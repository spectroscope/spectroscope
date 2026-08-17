package dev.spectroscope.core.provider;

import java.util.Arrays;
import java.util.OptionalLong;

/**
 * How long this session's model exchanges actually take — a bounded, shared
 * window of measured wall-clock durations, one entry per finished provider
 * stream (card 270).
 *
 * <p>It exists because a per-child budget has to come from the backend rather
 * than from a constant. The spread that killed the constant is measured and
 * worth keeping in front of the next reader: on the owner's own LM Studio node
 * the baseline session of {@code konzept/ORCHESTRATION.md} §7 ran 18 exchanges
 * with a median of 92.2 s and a maximum of 1,560.9 s — four orders of magnitude
 * between the fastest and the slowest, on ONE backend in ONE evening. No single
 * literal serves both ends of that, which is why {@code CHILD_TIMEOUT_MS =
 * 120_000} was not conservative but simply wrong: shorter than 7 of the 15 chat
 * exchanges it was supposed to bound.</p>
 *
 * <p>The window is deliberately small and forgetful. A backend can be swapped
 * mid-session ({@code SwitchableProvider}), so a long memory would price a
 * child on a machine it is not talking to any more.</p>
 *
 * <p>Thread-safe: parent and children observe concurrently, and the readers run
 * on the timeout scheduler's thread.</p>
 */
public final class ExchangeLatency {

    /** How many recent exchanges the median is taken over. */
    public static final int WINDOW = 16;

    private final long[] recent = new long[WINDOW];
    private int written;

    /**
     * Records one finished exchange. Non-positive durations are ignored — a
     * stream that never opened is not a measurement of the backend.
     *
     * @param durationMs wall-clock milliseconds from the request going out to
     *                   the stream being exhausted
     */
    public synchronized void observe(long durationMs) {
        if (durationMs <= 0) {
            return;
        }
        recent[written % WINDOW] = durationMs;
        written++;
    }

    /**
     * The median of the window, or empty while nothing has been measured.
     *
     * <p>Median rather than mean on purpose: the baseline's own maximum is
     * seventeen times its median, and a mean over that spread describes no
     * exchange that ever happened.</p>
     *
     * @return the p50 in milliseconds, or empty when this session has not
     *         talked to a backend yet
     */
    public synchronized OptionalLong p50Ms() {
        int filled = Math.min(written, WINDOW);
        if (filled == 0) {
            return OptionalLong.empty();
        }
        long[] sorted = Arrays.copyOf(recent, filled);
        Arrays.sort(sorted);
        return OptionalLong.of(sorted[filled / 2]);
    }

    /**
     * How many exchanges have been measured over the life of this window —
     * counting past {@link #WINDOW}, so it keeps growing after the ring has
     * started overwriting.
     *
     * <p>This is NOT the sample size of {@link #p50Ms} once a session runs long:
     * use {@link #sampleSize()} whenever the number is going to be reported
     * beside the median.</p>
     *
     * @return the total number of observations
     */
    public synchronized int observed() {
        return written;
    }

    /**
     * How many samples {@link #p50Ms} actually weighs — the honesty half of the
     * median: a median over one sample is a sample.
     *
     * <p>The ring holds {@link #WINDOW} entries and forgets everything older on
     * purpose (a swapped backend must be repriced). So after 340 exchanges the
     * median is still taken over 16, and a sentence that quotes
     * {@link #observed()} instead claims 324 samples that were deliberately
     * discarded.</p>
     *
     * @return {@code min(observed(), WINDOW)}
     */
    public synchronized int sampleSize() {
        return Math.min(written, WINDOW);
    }
}
