package dev.spectroscope.orchestrator;

import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableSet;
import java.util.TreeSet;

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
    /** topic → sender → epoch → sequences the wire delivered while NOBODY
     *  here consumed the topic (all handles closed): holes above the cursor.
     *  {@link #accept} must never advance PAST one — the replay that fills
     *  it would be misread as redelivery and the frame lost silently, with
     *  no gap announced. Only that replay ({@link #accept}) or an announced
     *  eviction ({@link #noteGap}) removes a hole. Growth is bounded by the
     *  frames the hub fans out during one consumer-less window: a reconnect
     *  only re-subscribes topics somebody still consumes. */
    private final Map<String, Map<String, Map<Long, NavigableSet<Long>>>> undelivered =
            new LinkedHashMap<>();

    /** @param outboxCapacity frames the outbox holds before refusing loudly */
    ClientCore(int outboxCapacity) {
        this.outboxCapacity = outboxCapacity;
    }

    /**
     * Decides whether an incoming frame reaches the consumer.
     *
     * @param env the frame as delivered (live or replay)
     * @return true when the consumer must see it; false on redelivery, or
     *         when the frame rides above a hole and its own redelivery is
     *         already in flight behind that hole's replay
     */
    boolean accept(BusEnvelope env) {
        Map<Long, Long> epochs = consumed
                .computeIfAbsent(env.topic(), topic -> new LinkedHashMap<>())
                .computeIfAbsent(env.sender(), sender -> new LinkedHashMap<>());
        Long known = epochs.get(env.epoch());
        if (known != null && env.sequence() <= known) {
            return false;
        }
        NavigableSet<Long> holes = holes(env.topic(), env.sender(), env.epoch());
        if (holes != null && !holes.isEmpty()) {
            if (holes.first() < env.sequence()) {
                // The frame rides ABOVE a frame nobody consumed: it was in
                // flight while the topic had no consumer and arrives right
                // after the re-subscribe. Advancing the high-water here would
                // leapfrog the hole — its replay, already in flight (the
                // re-subscribe sent a cursor below it, and the hub either
                // replays the stretch or announces its eviction as a gap),
                // would be rejected as redelivery: silent loss. Refuse this
                // frame instead; the same replay redelivers it right after
                // the hole, in publish order.
                return false;
            }
            holes.remove(env.sequence());
        }
        epochs.put(env.epoch(), env.sequence());
        return true;
    }

    /**
     * Records a frame the shell dropped for want of a consumer (every handle
     * on its topic closed): a hole above the cursor. The cursor rightly does
     * not advance for it — and, just as load-bearing, {@link #accept} must
     * never advance past it, or the replay a later subscribe requests would
     * be rejected as redelivery and the frame lost for good, silently.
     *
     * @param env the frame that reached this client but nobody here saw
     */
    void noteUndelivered(BusEnvelope env) {
        Long known = consumed
                .getOrDefault(env.topic(), Map.of())
                .getOrDefault(env.sender(), Map.of())
                .get(env.epoch());
        if (known != null && env.sequence() <= known) {
            return; // redelivered consumed history — not a hole
        }
        undelivered
                .computeIfAbsent(env.topic(), topic -> new LinkedHashMap<>())
                .computeIfAbsent(env.sender(), sender -> new LinkedHashMap<>())
                .computeIfAbsent(env.epoch(), epoch -> new TreeSet<>())
                .add(env.sequence());
    }

    /** @return this incarnation's holes, or null when it never dropped any */
    private NavigableSet<Long> holes(String topic, String sender, long epoch) {
        return undelivered
                .getOrDefault(topic, Map.of())
                .getOrDefault(sender, Map.of())
                .get(epoch);
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
        NavigableSet<Long> holes = holes(topic, sender, epoch);
        if (holes != null) {
            // Holes inside the evicted stretch can never replay — this very
            // gap is their loud announcement. Keeping them would make accept
            // refuse every later frame forever, waiting on a replay that
            // cannot come.
            holes.headSet(toSeq, true).clear();
        }
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
