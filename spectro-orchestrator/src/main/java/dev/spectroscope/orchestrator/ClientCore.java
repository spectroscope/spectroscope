package dev.spectroscope.orchestrator;

import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The client's pure state machine (card 22): a bounded outbox that survives
 * a dead hub (kept until the cumulative ack, reflushed on reconnect) and a
 * consumption cursor that makes wire redelivery invisible to the consumer —
 * at-least-once on the wire, exactly-once at the consumer. Since card 25 the
 * cursor and the ack are scoped per (sender, epoch): a restarted sender's
 * fresh incarnation reaches the consumer instead of vanishing into the dedup.
 *
 * <p>Socket-free and single-threaded on purpose; the shell owns the lock and
 * turns the full-outbox refusal into publisher backpressure (the EventStream
 * discipline: block, never drop in silence).</p>
 */
final class ClientCore {

    private final int outboxCapacity;
    /** Published frames the hub has not cumulatively acked yet, in order. */
    private final ArrayDeque<BusEnvelope> outbox = new ArrayDeque<>();
    /** topic → sender → epoch → highest sequence handed to the consumer. */
    private final Map<String, Map<String, Map<Long, Long>>> consumed = new LinkedHashMap<>();

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
        Map<Long, Long> epochs = consumed
                .computeIfAbsent(env.topic(), topic -> new LinkedHashMap<>())
                .computeIfAbsent(env.sender(), sender -> new LinkedHashMap<>());
        Long known = epochs.get(env.epoch());
        if (known != null && env.sequence() <= known) {
            return false;
        }
        epochs.put(env.epoch(), env.sequence());
        return true;
    }

    /**
     * The resume cursor a (re)subscribe sends: exactly what was consumed,
     * per incarnation.
     *
     * @param topic the topic to resume
     * @return sender → epoch → high-water, defensively copied
     */
    Map<String, Map<Long, Long>> cursor(String topic) {
        Map<String, Map<Long, Long>> copy = new LinkedHashMap<>();
        consumed.getOrDefault(topic, Map.of())
                .forEach((sender, epochs) -> copy.put(sender, Map.copyOf(epochs)));
        return Map.copyOf(copy);
    }

    /**
     * Advances the consumption cursor over an announced gap: the hub already
     * evicted that stretch, so no resume can ever deliver it — a cursor left
     * below the loss would resend the same stale position on every reconnect
     * and re-earn the same gap forever (card 25 review). Never moves
     * backwards: a stale gap must not resurrect consumed history.
     *
     * @param topic  the topic the gap was announced on
     * @param sender the sender whose history was evicted
     * @param epoch  the incarnation the evicted stretch belonged to
     * @param toSeq  the last missing sequence, inclusive
     */
    void noteGap(String topic, String sender, long epoch, long toSeq) {
        consumed.computeIfAbsent(topic, t -> new LinkedHashMap<>())
                .computeIfAbsent(sender, s -> new LinkedHashMap<>())
                .merge(epoch, toSeq, Long::max);
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
     * Applies the hub's cumulative ack: everything of that sender's
     * incarnation ON THAT TOPIC up to the high-water is safe on the hub and
     * leaves the outbox. Topic and epoch filters are both load-bearing —
     * sequences restart per context AND per incarnation, so an ack missing
     * either scope would trim frames the hub never confirmed.
     */
    void ack(String topic, String sender, long epoch, long highWater) {
        outbox.removeIf(env -> env.topic().equals(topic)
                && env.sender().equals(sender) && env.epoch() == epoch
                && env.sequence() <= highWater);
    }

    /** @return the frames a reconnect must reflush, oldest first */
    List<BusEnvelope> unacked() {
        return List.copyOf(outbox);
    }
}
