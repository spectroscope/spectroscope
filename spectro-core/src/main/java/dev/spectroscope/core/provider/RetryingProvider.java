package dev.spectroscope.core.provider;

import dev.spectroscope.core.CancelSignal;

import java.util.Iterator;
import java.util.NoSuchElementException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * A retry decorator around any {@link LlmProvider}. On the first pull it
 * establishes the delegate stream AND fetches the first {@link ProviderEvent}
 * inside a retry loop; a transient failure BEFORE any event is yielded is retried
 * with capped exponential backoff + jitter (a pause on the virtual thread that
 * a stop ends at once, card 557).
 * Once the first event is in hand (or a non-transient error, or the cancel signal
 * fires) it delegates straight through — so a mid-stream break is never retried
 * (retrying after emitted deltas would duplicate them and corrupt the transcript).
 * A break after N tokens therefore surfaces as an {@code error} event, exactly as
 * before. {@link #providerName()} delegates so the {@code run_start} label stays true.
 */
public final class RetryingProvider implements LlmProvider {

    /** Backoff seam: {@link #pause} in production, a spy or no-op in tests. */
    interface Sleeper {
        /**
         * Blocks the current (virtual) thread for the backoff delay.
         *
         * @param millis how long to pause
         * @param signal the run's cancel signal (may be null); a stop ends the pause
         */
        void sleep(long millis, CancelSignal signal) throws InterruptedException;
    }

    private final LlmProvider delegate;
    private final RetryPolicy policy;
    private final Sleeper sleeper;

    /**
     * Package-private — production code goes through {@link #wrap}; tests inject a spy sleeper.
     *
     * @param delegate the provider whose stream establishment is protected
     * @param policy   the backoff curve plus the transient classifier
     * @param sleeper  the pause seam (Thread::sleep in production)
     */
    RetryingProvider(LlmProvider delegate, RetryPolicy policy, Sleeper sleeper) {
        this.delegate = delegate;
        this.policy = policy;
        this.sleeper = sleeper;
    }

    /**
     * Wrap a provider, or return it unchanged when retries are disabled.
     *
     * @param delegate the provider to protect
     * @param policy   the retry policy; {@code maxRetries <= 0} means pass-through
     * @return the retrying decorator, or the delegate itself when retry is off
     */
    public static LlmProvider wrap(LlmProvider delegate, RetryPolicy policy) {
        if (policy.maxRetries() <= 0) {
            return delegate;
        }
        return new RetryingProvider(delegate, policy, RetryingProvider::pause);
    }

    /**
     * The production pause: waits out the backoff, and returns at once when
     * the stop is pressed (card 557). It used to be {@code Thread.sleep},
     * which a cancel could not reach. Nothing is interrupted here: the cancel
     * listener counts a latch down.
     *
     * @param millis how long to pause
     * @param signal the run's cancel signal, or null for a plain sleep
     * @throws InterruptedException when the thread is interrupted from elsewhere
     */
    static void pause(long millis, CancelSignal signal) throws InterruptedException {
        if (signal == null) {
            Thread.sleep(millis);
            return;
        }
        CountDownLatch stopped = new CountDownLatch(1);
        Runnable unhook = signal.onCancel(stopped::countDown);
        try {
            stopped.await(millis, TimeUnit.MILLISECONDS);
        } finally {
            unhook.run();
        }
    }

    /** Delegates, so the {@code run_start} label reports the real provider, not the wrapper. */
    @Override
    public String modelName() {
        return delegate.modelName();
    }

    @Override
    public String providerName() {
        return delegate.providerName();
    }

    /** Delegates, so the address survives the retry wrapper the faces hold. */
    @Override
    public String endpoint() {
        return delegate.endpoint();
    }

    /** Delegates: card 252's fence asks the provider the agent HOLDS, and every
     *  session holds this wrapper. A default answer here would leave the fence
     *  permanently open — the failure that looks like nothing was built at all. */
    @Override
    public Vision vision() {
        return delegate.vision();
    }

    /** Delegates (card 263): the threshold is derived from the provider the
     *  agent HOLDS, and every session holds this wrapper. A default answer here
     *  would pin every run back onto the 100,000 constant, silently. */
    @Override
    public int contextWindow() {
        return delegate.contextWindow();
    }

    /** Delegates (card 391), for the reason {@link #contextWindow()} does: a
     *  default answer here would put every Ollama cloud session back on the
     *  100,000 fallback. */
    @Override
    public int publishedWindow() {
        return delegate.publishedWindow();
    }

    /**
     * Returns a lazy iterable whose {@code iterator()} runs the retrying establishment.
     *
     * @param request the neutral request, re-sent verbatim on every attempt
     * @return the (possibly retried) event stream
     */
    @Override
    public Iterable<ProviderEvent> stream(ProviderRequest request) {
        return () -> establish(request);
    }

    /**
     * Retry loop around establishing the stream and pulling the first event.
     *
     * @param request the neutral request each attempt re-sends
     * @return an iterator serving the pre-pulled first event, then the delegate's rest
     */
    private Iterator<ProviderEvent> establish(ProviderRequest request) {
        CancelSignal signal = request.signal();
        int attempt = 0;
        while (true) {
            try {
                Iterator<ProviderEvent> iterator = delegate.stream(request).iterator();
                boolean hasFirst = iterator.hasNext();          // forces the transient-prone first pull
                ProviderEvent first = hasFirst ? iterator.next() : null;
                return new PrefixIterator(first, hasFirst, iterator);
            } catch (RuntimeException error) {
                boolean cancelled = signal != null && signal.isCancelled();
                if (!cancelled && attempt < policy.maxRetries() && policy.isTransient(error)) {
                    attempt++;
                    // The retry that used to be invisible — the
                    // run recovers silently, the operator log says why it paused.
                    org.slf4j.LoggerFactory.getLogger(RetryingProvider.class).info(
                            "transient provider failure ({}), retry {}/{}",
                            error.getMessage(), attempt, policy.maxRetries());
                    backoff(attempt, signal);
                    if (signal != null && signal.isCancelled()) {
                        // Card 557: a stop during the backoff starts no new
                        // attempt; the failure that started it is the answer.
                        throw error;
                    }
                    continue;
                }
                throw error; // cancelled, non-transient, or retries exhausted
            }
        }
    }

    /**
     * Sleeps the capped exponential delay plus jitter; skipped when already
     * cancelled, ended by a stop, and an interrupt only restores the flag.
     *
     * @param attempt the 1-based retry attempt driving the exponent
     * @param signal  the run's cancel signal (may be null)
     */
    private void backoff(int attempt, CancelSignal signal) {
        if (signal != null && signal.isCancelled()) {
            return;
        }
        long base = policy.baseDelay().toMillis();
        long exp = base <= 0 ? 0 : base * (1L << Math.min(attempt - 1, 30));
        long capped = Math.min(exp, policy.cap().toMillis());
        long jitter = capped <= 0 ? 0 : (long) (capped * policy.jitter() * Math.random());
        try {
            sleeper.sleep(capped + jitter, signal);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    /** Yields the already-pulled first event, then the rest of the delegate stream. */
    private static final class PrefixIterator implements Iterator<ProviderEvent> {
        private final Iterator<ProviderEvent> rest;
        private ProviderEvent first;
        private boolean firstPending;

        /**
         * Seeds the iterator with the pre-pulled head of the stream.
         *
         * @param first    the event already pulled during establishment (null when none)
         * @param hasFirst whether a first event exists at all — empty streams stay empty
         * @param rest     the delegate iterator, positioned after the first event
         */
        PrefixIterator(ProviderEvent first, boolean hasFirst, Iterator<ProviderEvent> rest) {
            this.first = first;
            this.firstPending = hasFirst;
            this.rest = rest;
        }

        /** True while the pre-pulled head or any delegate event remains. */
        @Override
        public boolean hasNext() {
            return firstPending || rest.hasNext();
        }

        /** Serves the pre-pulled head first, then delegates straight through. */
        @Override
        public ProviderEvent next() {
            if (firstPending) {
                firstPending = false;
                ProviderEvent value = first;
                first = null;
                return value;
            }
            if (!rest.hasNext()) {
                throw new NoSuchElementException();
            }
            return rest.next();
        }
    }
}
