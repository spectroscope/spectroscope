package dev.spectroscope.orchestrator;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The ProcessBus wire protocol (card 22): one op = one JSON line, version
 * pinned from day one. Five ops carry the whole transport — {@code hello}
 * (who connects), {@code sub} (topic + resume cursor), {@code pub} (an
 * envelope, spliced via its canonical line form), {@code ack} (cumulative
 * per-sender high-water) and {@code gap} (evicted history, announced loudly
 * — KONZEPT §8 trap 1 forbids silent loss, not loss).
 *
 * <p>Pure codec: no sockets, no state. A foreign version or unknown op fails
 * loudly at parse time — a mixed-version fleet must be impossible to miss.</p>
 */
final class Wire {

    static final int VERSION = 1;

    /** The builder-side mapper for ops that carry no envelope. */
    private static final ObjectMapper PLAIN = new ObjectMapper();

    private Wire() {
    }

    /** One parsed op — the transport switches over the sealed union. */
    sealed interface Msg permits Hello, Sub, Pub, Ack, Gap {
    }

    record Hello(String clientId) implements Msg {
    }

    record Sub(String topic, Map<String, Long> cursor) implements Msg {
    }

    record Pub(BusEnvelope frame) implements Msg {
    }

    record Ack(String topic, String sender, long highWater) implements Msg {
    }

    record Gap(String topic, String sender, long fromSeq, long toSeq) implements Msg {
    }

    static String hello(String clientId) {
        ObjectNode node = base("hello");
        node.put("clientId", clientId);
        return write(node);
    }

    static String sub(String topic, Map<String, Long> cursor) {
        ObjectNode node = base("sub");
        node.put("topic", topic);
        ObjectNode cursorNode = node.putObject("cursor");
        cursor.forEach(cursorNode::put);
        return write(node);
    }

    static String pub(BusEnvelope env, ObjectMapper mapper) {
        ObjectNode node = base("pub");
        try {
            // The envelope's canonical line IS the frame format — reparse it in
            // rather than encode a second, drifting form.
            node.set("frame", mapper.readTree(env.toLine(mapper)));
        } catch (IOException impossible) {
            throw new IllegalStateException("own envelope line unreadable: " + env.id(), impossible);
        }
        return write(node);
    }

    static String ack(String topic, String sender, long highWater) {
        // The topic rides along on purpose: high-waters are per (topic,
        // sender), and sequences restart per context — an ack without the
        // topic would trim a same-named sender's OTHER topics from the outbox.
        ObjectNode node = base("ack");
        node.put("topic", topic);
        node.put("sender", sender);
        node.put("highWater", highWater);
        return write(node);
    }

    static String gap(String topic, String sender, long fromSeq, long toSeq) {
        ObjectNode node = base("gap");
        node.put("topic", topic);
        node.put("sender", sender);
        node.put("fromSeq", fromSeq);
        node.put("toSeq", toSeq);
        return write(node);
    }

    /**
     * Parses one wire line into the op union.
     *
     * @param line   the received line
     * @param mapper the transport's shared mapper (envelope payloads ride it)
     * @return the parsed op
     * @throws IllegalArgumentException on foreign versions, unknown ops or non-JSON
     */
    static Msg parse(String line, ObjectMapper mapper) {
        JsonNode node;
        try {
            node = mapper.readTree(line);
        } catch (IOException notJson) {
            throw new IllegalArgumentException("not a wire line: " + line, notJson);
        }
        if (node == null || !node.isObject()) {
            throw new IllegalArgumentException("not a wire line: " + line);
        }
        if (node.path("v").asInt(-1) != VERSION) {
            throw new IllegalArgumentException("foreign protocol version: " + line);
        }
        String op = node.path("op").asText("");
        return switch (op) {
            case "hello" -> new Hello(node.path("clientId").asText());
            case "sub" -> {
                Map<String, Long> cursor = new LinkedHashMap<>();
                node.path("cursor").fields()
                        .forEachRemaining(e -> cursor.put(e.getKey(), e.getValue().asLong()));
                yield new Sub(node.path("topic").asText(), cursor);
            }
            case "pub" -> new Pub(BusEnvelope.fromLine(node.path("frame").toString(), mapper));
            case "ack" -> new Ack(node.path("topic").asText(), node.path("sender").asText(),
                    node.path("highWater").asLong());
            case "gap" -> new Gap(node.path("topic").asText(), node.path("sender").asText(),
                    node.path("fromSeq").asLong(), node.path("toSeq").asLong());
            default -> throw new IllegalArgumentException("unknown op '" + op + "': " + line);
        };
    }

    private static ObjectNode base(String op) {
        ObjectNode node = PLAIN.createObjectNode();
        node.put("v", VERSION);
        node.put("op", op);
        return node;
    }

    private static String write(ObjectNode node) {
        try {
            return PLAIN.writeValueAsString(node);
        } catch (com.fasterxml.jackson.core.JsonProcessingException impossible) {
            throw new IllegalStateException("wire op not serializable", impossible);
        }
    }
}
