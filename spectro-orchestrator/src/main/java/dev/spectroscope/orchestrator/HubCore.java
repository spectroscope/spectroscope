package dev.spectroscope.orchestrator;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The hub's pure heart (card 22): a bounded per-topic replay ring in arrival
 * order, high-water dedup, cursor-based replay for (re)connecting subscribers
 * — and LOUD gaps when a cursor fell behind the ring's start. Losing history
 * is survivable; hiding the loss is not (KONZEPT §8 trap 1). Since card 25
 * every guarantee is scoped per (sender, epoch): a restarted sender is a new
 * incarnation whose stream delivers, never a redelivery to drop.
 *
 * <p>Deliberately single-threaded and socket-free: the shell serializes calls
 * under one lock, and every delivery guarantee is provable here without
 * timing. Maps are insertion-ordered so replay and gap reports are
 * deterministic.</p>
 */
final class HubCore {

    /** What a (re)connecting subscriber gets: catch-up frames plus honesty. */
    record Replay(List<BusEnvelope> frames, List<BusGap> gaps) {
    }

    /** One incarnation of one sender — the ring-count and pruning key. */
    private record Incarnation(String sender, long epoch) {
    }

    private final int ringCapacity;
    /** topic → frames in arrival order, capped at {@link #ringCapacity}. */
    private final Map<String, ArrayDeque<BusEnvelope>> rings = new LinkedHashMap<>();
    /** topic → sender → epoch → highest sequence ever accepted (the dedup line). */
    private final Map<String, Map<String, Map<Long, Long>>> highWater = new LinkedHashMap<>();
    /** topic → incarnation → frames currently held by the ring (prune bookkeeping). */
    private final Map<String, Map<Incarnation, Long>> ringCounts = new LinkedHashMap<>();

    /** @param ringCapacity frames each topic's ring retains for late subscribers */
    HubCore(int ringCapacity) {
        this.ringCapacity = ringCapacity;
    }

    /**
     * Accepts one published frame — or recognizes it as a redelivery. The
     * dedup line is per (sender, epoch): a restarted sender's fresh epoch is
     * a new stream, so its restarted sequence DELIVERS (card 25 — before
     * epochs it was acked into the void).
     *
     * @param env the frame as it arrived
     * @return the frame when it is fresh (fan it out), empty on a duplicate
     *         (ack it again, deliver it to no one)
     */
    Optional<BusEnvelope> publish(BusEnvelope env) {
        Map<Long, Long> epochs = highWater
                .computeIfAbsent(env.topic(), topic -> new LinkedHashMap<>())
                .computeIfAbsent(env.sender(), sender -> new LinkedHashMap<>());
        Long known = epochs.get(env.epoch());
        if (known != null && env.sequence() <= known) {
            return Optional.empty();
        }
        epochs.put(env.epoch(), env.sequence());
        ArrayDeque<BusEnvelope> ring =
                rings.computeIfAbsent(env.topic(), topic -> new ArrayDeque<>());
        ring.addLast(env);
        Map<Incarnation, Long> counts =
                ringCounts.computeIfAbsent(env.topic(), topic -> new LinkedHashMap<>());
        counts.merge(new Incarnation(env.sender(), env.epoch()), 1L, Long::sum);
        if (ring.size() > ringCapacity) {
            BusEnvelope evicted = ring.removeFirst();
            noteEviction(evicted, counts);
        }
        return Optional.of(env);
    }

    /**
     * Prune bookkeeping (card 25 review): once an incarnation is BOTH fully
     * evicted from the ring AND superseded by a newer epoch of the same
     * sender, its high-water line is retired. Without this, a crash-looping
     * sender grows the per-epoch maps forever and every late subscriber is
     * greeted by one gap per dead incarnation — the gap-storm livelock. The
     * honesty horizon is the ring: beyond it, an old retransmit re-enters as
     * at-least-once and consumers dedup per incarnation. The NEWEST epoch is
     * never pruned — its dedup line guards the live node's retransmits.
     */
    private void noteEviction(BusEnvelope evicted, Map<Incarnation, Long> counts) {
        Incarnation key = new Incarnation(evicted.sender(), evicted.epoch());
        Long remaining = counts.computeIfPresent(key, (k, count) -> count - 1);
        if (remaining == null || remaining > 0) {
            return;
        }
        counts.remove(key);
        Map<Long, Long> epochs = highWater
                .getOrDefault(evicted.topic(), Map.of())
                .get(evicted.sender());
        if (epochs != null
                && epochs.keySet().stream().anyMatch(epoch -> epoch > evicted.epoch())) {
            epochs.remove(evicted.epoch());
        }
    }

    /**
     * The cumulative ack line for one incarnation of one sender on one topic.
     *
     * @return the highest accepted sequence, or -1 if nothing was ever seen
     */
    long highWater(String topic, String sender, long epoch) {
        return highWater.getOrDefault(topic, Map.of())
                .getOrDefault(sender, Map.of())
                .getOrDefault(epoch, -1L);
    }

    /**
     * Forgets one topic entirely — ring, high-waters, everything. The
     * aggregator calls this after a fleet session ends; a long-lived hub must
     * not pin every run's ring forever. A retired topic is a forgotten world:
     * later subscribers get neither frames nor gaps, and a sender starts
     * fresh at its next publish.
     */
    void retire(String topic) {
        rings.remove(topic);
        highWater.remove(topic);
        ringCounts.remove(topic);
    }

    /**
     * Computes a (re)connecting subscriber's catch-up: every ring frame above
     * its cursor, in arrival order — plus a gap per (sender, epoch) whose
     * history the ring no longer holds. A missing cursor entry means "from
     * the beginning".
     *
     * @param topic  the topic to catch up on
     * @param cursor per-(sender, epoch) high-water the subscriber consumed
     * @return frames to deliver and gaps to announce
     */
    Replay subscribe(String topic, Map<String, Map<Long, Long>> cursor) {
        List<BusEnvelope> frames = new ArrayList<>();
        // (sender, epoch) → oldest sequence the ring still holds.
        Map<String, Map<Long, Long>> firstInRing = new LinkedHashMap<>();
        for (BusEnvelope env : rings.getOrDefault(topic, new ArrayDeque<>())) {
            firstInRing.computeIfAbsent(env.sender(), sender -> new LinkedHashMap<>())
                    .putIfAbsent(env.epoch(), env.sequence());
            long consumed = cursor.getOrDefault(env.sender(), Map.of())
                    .getOrDefault(env.epoch(), -1L);
            if (env.sequence() > consumed) {
                frames.add(env);
            }
        }
        List<BusGap> gaps = new ArrayList<>();
        for (Map.Entry<String, Map<Long, Long>> sender
                : highWater.getOrDefault(topic, Map.of()).entrySet()) {
            for (Map.Entry<Long, Long> epoch : sender.getValue().entrySet()) {
                long consumed = cursor.getOrDefault(sender.getKey(), Map.of())
                        .getOrDefault(epoch.getKey(), -1L);
                // The oldest sequence the ring still holds for this
                // incarnation — everything below it and above the cursor was
                // evicted and must be announced, never hidden.
                long oldestHeld = firstInRing.getOrDefault(sender.getKey(), Map.of())
                        .getOrDefault(epoch.getKey(), epoch.getValue() + 1);
                if (consumed + 1 < oldestHeld) {
                    gaps.add(new BusGap(topic, sender.getKey(), epoch.getKey(),
                            consumed + 1, oldestHeld - 1));
                }
            }
        }
        return new Replay(frames, gaps);
    }
}
