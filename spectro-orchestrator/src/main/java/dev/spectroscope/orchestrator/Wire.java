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
 * pinned from day one. Six ops carry the whole transport — {@code hello}
 * (who connects), {@code sub} (topic + resume cursor), {@code pub} (an
 * envelope, spliced via its canonical line form), {@code ack} (cumulative
 * per-sender high-water), {@code gap} (evicted history, announced loudly
 * — KONZEPT §8 trap 1 forbids silent loss, not loss) and {@code ctl} (block 2:
 * a control verb the hub addresses to ONE node — the reverse of the node→hub
 * pub flow; delivery is by connection, so a ctl line carries only its verb).
 *
 * <p>Pure codec: no sockets, no state. A foreign version or unknown op fails
 * loudly at parse time — a mixed-version fleet must be impossible to miss. The
 * version bumped to 3 the moment the delivery dialect grew the ctl op, so a
 * pre-ctl (v2) node can never misread a control line as anything else.</p>
 *
 * <p>It bumped to 4 for the message form of ctl, and that one is worth its
 * cost in writing: the gate form could stay on 3 because a pre-gate node
 * dispatches on {@code callId != null} and simply never enters the branch. A
 * message has no such luck. Every shipped control handler reads
 * {@code if ("stop".equals(action))}, so a v3 node handed
 * {@code action:"message"} would drop the operator's words with no log line on
 * either side — a 202 at the endpoint and silence at the node. Silent loss is
 * the one failure KONZEPT §8 trap 1 forbids outright, so the line is made
 * unreadable to v3 rather than quietly misread by it.</p>
 */
final class Wire {

    static final int VERSION = 4;

    /** The builder-side mapper for ops that carry no envelope. */
    private static final ObjectMapper PLAIN = new ObjectMapper();

    private Wire() {
    }

    /** One parsed op — the transport switches over the sealed union. */
    sealed interface Msg permits Hello, Sub, Pub, Ack, Gap, Ctl {
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

    /** A control verb the hub delivers to ONE node (addressed by connection, so
     *  no id rides the line). {@code action} is the verb — "stop" or "gate"
     *  today; more can join without a version bump, since a new verb adds no op.
     *  A "gate" answer also carries the {@code callId} it addresses and the
     *  operator's {@code allow} verdict; a "message" carries the operator's
     *  {@code text}; a plain verb (stop) leaves all three null. The reader
     *  dispatches on WHICH field is present, never on the verb string, so no
     *  handler can half-understand a line meant for another seam. */
    record Ctl(String action, String callId, Boolean allow, String text) implements Msg {
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
            // Card 72, additive like the card itself: written only when present,
            // so a trigger-less hello stays byte-identical to the pre-72 line.
            if (card.trigger() != null) {
                cardNode.put("trigger", card.trigger());
            }
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

    /** The reverse-control line: {@code {"v":3,"op":"ctl","action":"stop"}}. The
     *  hub writes it to one node's connection; delivery IS the addressing. A
     *  plain verb carries no gate fields — the line stays byte-identical to the
     *  block-2 form, so a pre-gate node reads it unchanged. */
    static String ctl(String action) {
        ObjectNode node = base("ctl");
        node.put("action", action);
        return write(node);
    }

    /** The gate form: the hub answers a parked permission request on ONE node,
     *  carrying the {@code callId} it addresses and the operator's verdict —
     *  {@code {"v":4,"op":"ctl","action":"gate","callId":"…","allow":true}}. */
    static String ctl(String action, String callId, boolean allow) {
        ObjectNode node = base("ctl");
        node.put("action", action);
        node.put("callId", callId);
        node.put("allow", allow);
        return write(node);
    }

    /** The message form (card 166's server leg): the operator's own words,
     *  addressed to ONE node —
     *  {@code {"v":4,"op":"ctl","action":"message","text":"…"}}. The text field
     *  is what separates it from a plain verb at the reader, which is why a
     *  verb must never grow one. */
    static String ctl(String action, String text) {
        ObjectNode node = base("ctl");
        node.put("action", action);
        node.put("text", text);
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
            case "ctl" -> {
                JsonNode callIdNode = node.get("callId");
                String callId = callIdNode != null && !callIdNode.isNull() ? callIdNode.asText() : null;
                JsonNode allowNode = node.get("allow");
                Boolean allow = allowNode != null && !allowNode.isNull() ? allowNode.asBoolean() : null;
                JsonNode textNode = node.get("text");
                String text = textNode != null && !textNode.isNull() ? textNode.asText() : null;
                yield new Ctl(node.path("action").asText(), callId, allow, text);
            }
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
        // Absent on every pre-card-72 line — null, exactly like the writer's omission.
        String trigger = card.hasNonNull("trigger") ? card.path("trigger").asText() : null;
        return Optional.of(new NodeCard(id, card.path("role").asText(), capabilities, topic, trigger));
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
