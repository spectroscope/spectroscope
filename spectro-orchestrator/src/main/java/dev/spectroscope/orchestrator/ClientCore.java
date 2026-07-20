package dev.spectroscope.orchestrator;

import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The client's pure state machine (card 22): a bounded outbox that survives
 * a dead hub (kept until the cumulative ack, reflushed on reconnect) and a
 * per-sender cursor that makes wire redelivery invisible to the consumer —
 * at-least-once on the wire, exactly-once at the consumer.
 *
 * <p>Socket-free and single-threaded on purpose; the shell owns the lock and
 * turns the full-outbox refusal into publisher backpressure (the EventStream
 * discipline: block, never drop in silence).</p>
 */
final class ClientCore {

    private final int outboxCapacity;
    /** Published frames the hub has not cumulatively acked yet, in order. */
    private final ArrayDeque<BusEnvelope> outbox = new ArrayDeque<>();
    /** topic → sender → highest sequence handed to the consumer. */
    private final Map<String, Map<String, Long>> consumed = new LinkedHashMap<>();

    /** @param outboxCapacity frames the outbox holds before refusing loudly */
    ClientCore(int outboxCapacity) {
        this.outboxCapacity = outboxCapacity;
    }

    /**
     * Decides whether an incoming frame reaches the consumer.
     *
     * @param env the frame as delivered (live or replay)
     * @return true when the consumer must see it; false on redelivery
     */
    boolean accept(BusEnvelope env) {
        Map<String, Long> senders =
                consumed.computeIfAbsent(env.topic(), topic -> new LinkedHashMap<>());
        Long known = senders.get(env.sender());
        if (known != null && env.sequence() <= known) {
            return false;
        }
        senders.put(env.sender(), env.sequence());
        return true;
    }

    /**
     * The resume cursor a (re)subscribe sends: exactly what was consumed.
     *
     * @param topic the topic to resume
     * @return per-sender high-water, defensively copied
     */
    Map<String, Long> cursor(String topic) {
        return Map.copyOf(consumed.getOrDefault(topic, Map.of()));
    }

    /**
     * Remembers one published frame until the hub acks it.
     *
     * @param env the frame just handed to the wire (or waiting for it)
     * @throws IllegalStateException when the outbox is full — the shell turns
     *         this into backpressure on the publisher, never a silent drop
     */
    void record(BusEnvelope env) {
        if (outbox.size() >= outboxCapacity) {
            throw new IllegalStateException(
                    "outbox full (" + outboxCapacity + ") — the publisher must wait for the hub");
        }
        outbox.addLast(env);
    }

    /**
     * Applies the hub's cumulative ack: everything of that sender ON THAT
     * TOPIC up to the high-water is safe on the hub and leaves the outbox.
     * The topic filter is load-bearing — sequences restart per context, so a
     * same-named sender on another topic is the normal case, not a collision.
     */
    void ack(String topic, String sender, long highWater) {
        outbox.removeIf(env -> env.topic().equals(topic)
                && env.sender().equals(sender) && env.sequence() <= highWater);
    }

    /** @return the frames a reconnect must reflush, oldest first */
    List<BusEnvelope> unacked() {
        return List.copyOf(outbox);
    }
}
