package dev.spectroscope.orchestrator;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.events.RunEvent;

import java.util.Objects;

/**
 * The bus wire format: an envelope that WRAPS a
 * RunEvent and never rewrites it. Addressing is self-addressing — no from/to;
 * consumers correlate by {@code taskId} within a {@code contextId} (the A2A
 * steal), order per sender by {@code sequence}, and walk causality through
 * {@code parentId} (the previous envelope of the same sender).
 *
 * @param sender    the publishing node's agent id (= the lane's event identity)
 * @param epoch     the sender's incarnation: a restarted process stamps a
 *                  higher epoch, so its restarted sequence is a new stream,
 *                  never a redelivery. An identity qualifier, not a fence —
 *                  every incarnation delivers; what counts as "current" is
 *                  the roster's business, not the bus's.
 * @param contextId the fleet session — every lane of one panel run shares it
 * @param taskId    correlates every envelope of one assignment ("task-…")
 * @param sequence  monotonic per (sender, epoch) — per-incarnation order
 *                  survives any transport
 * @param parentId  the sender's previous envelope id, "-" at its chain root
 *                  (each incarnation starts its own causal chain)
 * @param topic     session isolation: subscribers pick one fleet's stream
 * @param ts        epoch millis of publication
 * @param payload   the wrapped RunEvent, carried verbatim
 */
public record BusEnvelope(String sender, long epoch, String contextId, String taskId,
                          long sequence, String parentId, String topic, long ts,
                          RunEvent payload) {

    /** Chain root marker for the first envelope of a sender. */
    public static final String CHAIN_ROOT = "-";

    /**
     * The topic convention: topic = session, isolation for free.
     *
     * @param contextId the session id
     * @return the topic every envelope of that session rides on
     */
    public static String topicFor(String contextId) {
        return contextId + ".events";
    }

    public BusEnvelope {
        Objects.requireNonNull(sender, "sender");
        Objects.requireNonNull(contextId, "contextId");
        Objects.requireNonNull(taskId, "taskId");
        Objects.requireNonNull(parentId, "parentId");
        Objects.requireNonNull(topic, "topic");
        Objects.requireNonNull(payload, "payload");
    }

    /** @return the envelope's natural id — {@code sender#epoch#sequence},
     *  unambiguous across restarts */
    public String id() {
        return sender + "#" + epoch + "#" + sequence;
    }

    /**
     * One JSONL line: envelope fields around the payload's own JSON. The
     * payload is serialized by the given mapper and spliced in as-is — the
     * envelope adds around the event, it never reaches into it.
     *
     * @param mapper the Jackson mapper shared by the transport
     * @return a single line, ready for a file/process bus
     */
    public String toLine(ObjectMapper mapper) {
        try {
            ObjectNode node = mapper.createObjectNode();
            node.put("sender", sender);
            node.put("epoch", epoch);
            node.put("contextId", contextId);
            node.put("taskId", taskId);
            node.put("sequence", sequence);
            node.put("parentId", parentId);
            node.put("topic", topic);
            node.put("ts", ts);
            node.set("payload", mapper.valueToTree(payload));
            return mapper.writeValueAsString(node);
        } catch (RuntimeException e) {
            throw new IllegalStateException("envelope not serializable: " + id(), e);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException("envelope not serializable: " + id(), e);
        }
    }

    /**
     * Parses one JSONL line back into an envelope; the payload deserializes
     * through the RunEvent union (unknown future types would fail here, which
     * a transport surfaces as a poison line, never as silent loss).
     *
     * @param line   the wire line
     * @param mapper the Jackson mapper shared by the transport
     * @return the envelope
     */
    public static BusEnvelope fromLine(String line, ObjectMapper mapper) {
        try {
            var node = mapper.readTree(line);
            return new BusEnvelope(
                    node.path("sender").asText(),
                    node.path("epoch").asLong(),
                    node.path("contextId").asText(),
                    node.path("taskId").asText(),
                    node.path("sequence").asLong(),
                    node.path("parentId").asText(),
                    node.path("topic").asText(),
                    node.path("ts").asLong(),
                    mapper.treeToValue(node.path("payload"), RunEvent.class));
        } catch (java.io.IOException e) {
            throw new IllegalArgumentException("not a bus envelope line: " + line, e);
        }
    }
}
