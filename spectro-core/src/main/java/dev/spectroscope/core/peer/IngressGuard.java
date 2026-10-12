package dev.spectroscope.core.peer;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.function.LongSupplier;

/**
 * The five guards at one session's inbox (card 502 criterion 7): loop,
 * runaway, full queue, duplicate and rate. A dropped message spends no token.
 *
 * <p>At most {@link PeerLimits#TRACKED_SENDERS} senders are tracked. A sender
 * leaves the table only when it is settled: its bucket has refilled and its
 * duplicate window has passed, so forgetting it changes nothing. While every
 * tracked sender is active, a new sender is dropped as rate limited instead of
 * pushing out the state of an active one.</p>
 */
public final class IngressGuard {

    private record Last(String text, long at) {
    }

    private final LongSupplier clock;
    private final Map<String, TokenBucket> buckets = new LinkedHashMap<>();
    private final Map<String, Last> previous = new LinkedHashMap<>();

    /** @param clock epoch millis */
    public IngressGuard(LongSupplier clock) {
        this.clock = clock;
    }

    /**
     * Decides one arriving message.
     *
     * @param sender   who sent it, keyed by the verified pid and session
     * @param text     the body
     * @param hopChain the hop ids the message passed through
     * @param ownHop   this session's hop id
     * @param queued   messages this session already holds undelivered
     * @return empty when admitted, else the reason it is dropped
     */
    public synchronized Optional<DropReason> admit(String sender, String text, List<String> hopChain,
                                                   String ownHop, int queued) {
        List<String> chain = hopChain == null ? List.of() : hopChain;
        long self = chain.stream().filter(hop -> Objects.equals(hop, ownHop)).count();
        if (self >= PeerLimits.SELF_HOP_LIMIT) {
            return Optional.of(DropReason.LOOP);
        }
        if (chain.size() > PeerLimits.CHAIN_LENGTH) {
            return Optional.of(DropReason.RUNAWAY);
        }
        if (queued >= PeerLimits.QUEUE_CAP) {
            return Optional.of(DropReason.QUEUE_FULL);
        }
        long now = clock.getAsLong();
        Last last = previous.get(sender);
        if (last != null && Objects.equals(last.text(), text)
                && now - last.at() < PeerLimits.DUPLICATE_WINDOW_MS) {
            return Optional.of(DropReason.DUPLICATE);
        }
        if (!buckets.containsKey(sender) && !roomFor(now)) {
            return Optional.of(DropReason.RATE_LIMITED);
        }
        TokenBucket bucket = buckets.computeIfAbsent(sender, key -> new TokenBucket(clock));
        if (!bucket.tryTake()) {
            return Optional.of(DropReason.RATE_LIMITED);
        }
        previous.put(sender, new Last(text, now));
        return Optional.empty();
    }

    /** Forgets settled senders when the table is full; true when a new sender fits. */
    private boolean roomFor(long now) {
        if (buckets.size() < PeerLimits.TRACKED_SENDERS) {
            return true;
        }
        buckets.entrySet().removeIf(entry -> {
            Last last = previous.get(entry.getKey());
            boolean settled = entry.getValue().full()
                    && (last == null || now - last.at() >= PeerLimits.DUPLICATE_WINDOW_MS);
            if (settled) {
                previous.remove(entry.getKey());
            }
            return settled;
        });
        return buckets.size() < PeerLimits.TRACKED_SENDERS;
    }
}
