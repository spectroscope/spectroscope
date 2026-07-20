package dev.spectroscope.orchestrator;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

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

    static final int VERSION = 2;

    /** The builder-side mapper for ops that carry no envelope. */
    private static final ObjectMapper PLAIN = new ObjectMapper();

    private Wire() {
    }

    /** One parsed op — the transport switches over the sealed union. */
    sealed interface Msg permits Hello, Sub, Pub, Ack, Gap {
    }

    /** The card is optional handshake metadata — plain clients send none. */
    record Hello(String clientId, Optional<NodeCard> card) implements Msg {
    }

    /** The cursor names each incarnation it consumed: sender → epoch → seq. */
    record Sub(String topic, Map<String, Map<Long, Long>> cursor) implements Msg {
    }

    record Pub(BusEnvelope frame) implements Msg {
    }

    record Ack(String topic, String sender, long epoch, long highWater) implements Msg {
    }

    record Gap(String topic, String sender, long epoch, long fromSeq, long toSeq) implements Msg {
    }

    static String hello(String clientId) {
        return hello(clientId, null);
    }

    /**
     * The node form: the {@link NodeCard} rides the handshake, so
     * registration needs no sixth op and liveness is the connection itself.
     * The card is optional METADATA — the delivery dialect (sub/pub/ack/gap)
     * is untouched, which is why adding it did not bump the version.
     */
    static String hello(String clientId, NodeCard card) {
        ObjectNode node = base("hello");
        node.put("clientId", clientId);
        if (card != null) {
            ObjectNode cardNode = node.putObject("card");
            cardNode.put("id", card.id());
            cardNode.put("role", card.role());
            ArrayNode caps = cardNode.putArray("capabilities");
            card.capabilities().forEach(caps::add);
            cardNode.put("topic", card.topic());
        }
        return write(node);
    }

    static String sub(String topic, Map<String, Map<Long, Long>> cursor) {
        ObjectNode node = base("sub");
        node.put("topic", topic);
        ObjectNode cursorNode = node.putObject("cursor");
        cursor.forEach((sender, epochs) -> {
            ObjectNode epochNode = cursorNode.putObject(sender);
            epochs.forEach((epoch, seq) -> epochNode.put(String.valueOf(epoch), seq));
        });
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

    static String ack(String topic, String sender, long epoch, long highWater) {
        // Topic AND epoch ride along on purpose: high-waters are per (topic,
        // sender, epoch) — sequences restart per context AND per incarnation,
        // so an ack missing either scope would trim frames the hub never saw.
        ObjectNode node = base("ack");
        node.put("topic", topic);
        node.put("sender", sender);
        node.put("epoch", epoch);
        node.put("highWater", highWater);
        return write(node);
    }

    static String gap(String topic, String sender, long epoch, long fromSeq, long toSeq) {
        ObjectNode node = base("gap");
        node.put("topic", topic);
        node.put("sender", sender);
        node.put("epoch", epoch);
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
            case "hello" -> new Hello(node.path("clientId").asText(), parseCard(node.path("card")));
            case "sub" -> {
                Map<String, Map<Long, Long>> cursor = new LinkedHashMap<>();
                node.path("cursor").fields().forEachRemaining(sender -> {
                    Map<Long, Long> epochs = new LinkedHashMap<>();
                    sender.getValue().fields().forEachRemaining(epoch ->
                            epochs.put(Long.parseLong(epoch.getKey()), epoch.getValue().asLong()));
                    cursor.put(sender.getKey(), epochs);
                });
                yield new Sub(node.path("topic").asText(), cursor);
            }
            case "pub" -> new Pub(BusEnvelope.fromLine(node.path("frame").toString(), mapper));
            case "ack" -> new Ack(node.path("topic").asText(), node.path("sender").asText(),
                    node.path("epoch").asLong(), node.path("highWater").asLong());
            case "gap" -> new Gap(node.path("topic").asText(), node.path("sender").asText(),
                    node.path("epoch").asLong(),
                    node.path("fromSeq").asLong(), node.path("toSeq").asLong());
            default -> throw new IllegalArgumentException("unknown op '" + op + "': " + line);
        };
    }

    /** An absent or malformed card is simply no card — hello stays a hello.
     *  Malformed includes an object missing its identity: a card without id
     *  and topic would haunt rosters as an empty-string ghost. */
    private static Optional<NodeCard> parseCard(JsonNode card) {
        if (!card.isObject()) {
            return Optional.empty();
        }
        String id = card.path("id").asText("");
        String topic = card.path("topic").asText("");
        if (id.isBlank() || topic.isBlank()) {
            return Optional.empty();
        }
        List<String> capabilities = new ArrayList<>();
        card.path("capabilities").forEach(cap -> capabilities.add(cap.asText()));
        return Optional.of(new NodeCard(id, card.path("role").asText(), capabilities, topic));
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
