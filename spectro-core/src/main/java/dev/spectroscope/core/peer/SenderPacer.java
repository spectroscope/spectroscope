package dev.spectroscope.core.peer;

import java.util.HashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/**
 * The sender's own pacing against the receiver's bucket (card 502 criterion
 * 7), so a message the receiver would drop is not sent at all.
 */
public final class SenderPacer {

    private final LongSupplier clock;
    private final Map<String, TokenBucket> buckets = new HashMap<>();

    /** @param clock epoch millis */
    public SenderPacer(LongSupplier clock) {
        this.clock = clock;
    }

    /**
     * Takes a token for one send to a target.
     *
     * @param target the receiving process and session
     * @return true when the send may go
     */
    public synchronized boolean tryAcquire(String target) {
        return buckets.computeIfAbsent(target, key -> new TokenBucket(clock)).tryTake();
    }

    /**
     * The error a paced send returns to the model.
     *
     * @param recent how many messages went to that session recently
     * @return the text
     */
    public static String pacedText(int recent) {
        return "Too many messages to this session just now: " + recent + " were sent recently and more"
                + " would be dropped by its rate limit, so this one was not sent. Batch what remains"
                + " into one message, or wait a little before sending more.";
    }
}
