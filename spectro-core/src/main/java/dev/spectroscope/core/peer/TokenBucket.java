package dev.spectroscope.core.peer;

import java.util.function.LongSupplier;

/** One token bucket on an injected clock; not thread safe, the owner locks. */
final class TokenBucket {

    private final LongSupplier clock;
    private double tokens;
    private long last;

    TokenBucket(LongSupplier clock) {
        this.clock = clock;
        this.tokens = PeerLimits.BUCKET_CAPACITY;
        this.last = clock.getAsLong();
    }

    /** @return true when a token was taken */
    boolean tryTake() {
        refill();
        if (tokens >= 1.0) {
            tokens -= 1.0;
            return true;
        }
        return false;
    }

    /** @return true when a token is there to take, without taking it */
    boolean hasToken() {
        refill();
        return tokens >= 1.0;
    }

    /** @return true when the bucket has refilled to its capacity, as a new one would be */
    boolean full() {
        refill();
        return tokens >= PeerLimits.BUCKET_CAPACITY;
    }

    private void refill() {
        long now = clock.getAsLong();
        if (now > last) {
            tokens = Math.min(PeerLimits.BUCKET_CAPACITY,
                    tokens + (now - last) / 1000.0 * PeerLimits.REFILL_PER_SECOND);
            last = now;
        }
    }
}
