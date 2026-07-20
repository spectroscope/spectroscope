package dev.spectroscope.orchestrator;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The hub's pure heart (card 22): a bounded per-topic replay ring in arrival
 * order, per-sender high-water dedup, cursor-based replay for (re)connecting
 * subscribers — and LOUD gaps when a cursor fell behind the ring's start.
 * Losing history is survivable; hiding the loss is not (KONZEPT §8 trap 1).
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

    private final int ringCapacity;
    /** topic → frames in arrival order, capped at {@link #ringCapacity}. */
    private final Map<String, ArrayDeque<BusEnvelope>> rings = new LinkedHashMap<>();
    /** topic → sender → highest sequence ever accepted (the dedup line). */
    private final Map<String, Map<String, Long>> highWater = new LinkedHashMap<>();

    /** @param ringCapacity frames each topic's ring retains for late subscribers */
    HubCore(int ringCapacity) {
        this.ringCapacity = ringCapacity;
    }

    /**
     * Accepts one published frame — or recognizes it as a redelivery.
     *
     * @param env the frame as it arrived
     * @return the frame when it is fresh (fan it out), empty on a duplicate
     *         (ack it again, deliver it to no one)
     */
    Optional<BusEnvelope> publish(BusEnvelope env) {
        Map<String, Long> senders =
                highWater.computeIfAbsent(env.topic(), topic -> new LinkedHashMap<>());
        Long known = senders.get(env.sender());
        if (known != null && env.sequence() <= known) {
            return Optional.empty();
        }
        senders.put(env.sender(), env.sequence());
        ArrayDeque<BusEnvelope> ring =
                rings.computeIfAbsent(env.topic(), topic -> new ArrayDeque<>());
        ring.addLast(env);
        if (ring.size() > ringCapacity) {
            ring.removeFirst();
        }
        return Optional.of(env);
    }

    /**
     * The cumulative ack line for one sender on one topic.
     *
     * @return the highest accepted sequence, or -1 if nothing was ever seen
     */
    long highWater(String topic, String sender) {
        return highWater.getOrDefault(topic, Map.of()).getOrDefault(sender, -1L);
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
    }

    /**
     * Computes a (re)connecting subscriber's catch-up: every ring frame above
     * its cursor, in arrival order — plus a gap per sender whose history the
     * ring no longer holds. A missing cursor entry means "from the beginning".
     *
     * @param topic  the topic to catch up on
     * @param cursor per-sender high-water the subscriber has already consumed
     * @return frames to deliver and gaps to announce
     */
    Replay subscribe(String topic, Map<String, Long> cursor) {
        List<BusEnvelope> frames = new ArrayList<>();
        Map<String, Long> firstInRing = new LinkedHashMap<>();
        for (BusEnvelope env : rings.getOrDefault(topic, new ArrayDeque<>())) {
            firstInRing.putIfAbsent(env.sender(), env.sequence());
            if (env.sequence() > cursor.getOrDefault(env.sender(), -1L)) {
                frames.add(env);
            }
        }
        List<BusGap> gaps = new ArrayList<>();
        for (Map.Entry<String, Long> sender : highWater.getOrDefault(topic, Map.of()).entrySet()) {
            long consumed = cursor.getOrDefault(sender.getKey(), -1L);
            // The oldest sequence the ring still holds — everything below it and
            // above the cursor was evicted and must be announced, never hidden.
            long oldestHeld = firstInRing.getOrDefault(sender.getKey(), sender.getValue() + 1);
            if (consumed + 1 < oldestHeld) {
                gaps.add(new BusGap(topic, sender.getKey(), consumed + 1, oldestHeld - 1));
            }
        }
        return new Replay(frames, gaps);
    }
}
