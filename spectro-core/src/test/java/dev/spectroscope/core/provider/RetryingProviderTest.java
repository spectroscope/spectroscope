package dev.spectroscope.core.provider;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.PUsage;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The retry decorator, proven against tiny in-memory providers — no network.
 * Retry is scoped to failures before the first event, honours the cancel signal,
 * and never sleeps in tests (a spy Sleeper counts calls; backoff is injected),
 * except where card 557 measures the production pause against a stop.
 */
@Timeout(value = 5, unit = TimeUnit.SECONDS)
class RetryingProviderTest {

    private static final RetryPolicy ZERO =
            new RetryPolicy(3, Duration.ZERO, Duration.ZERO, 0.0);

    /** Fails transiently a fixed number of times, then yields one scripted turn. */
    private static final class FlakyProvider implements LlmProvider {
        final AtomicInteger streamCalls = new AtomicInteger();
        private int failsRemaining;
        private final List<ProviderEvent> success;

        FlakyProvider(int failsRemaining, List<ProviderEvent> success) {
            this.failsRemaining = failsRemaining;
            this.success = success;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            streamCalls.incrementAndGet();
            if (failsRemaining > 0) {
                failsRemaining--;
                throw new TransientProviderException("503 flaky");
            }
            return success;
        }

        @Override
        public String providerName() {
            return "flaky";
        }
    }

    private static ProviderRequest request(CancelSignal signal) {
        return new ProviderRequest("s", List.of(), List.of(), 100, signal);
    }

    private static List<ProviderEvent> drain(LlmProvider provider, ProviderRequest request) {
        List<ProviderEvent> out = new ArrayList<>();
        provider.stream(request).forEach(out::add);
        return out;
    }

    @Test
    void aTransientFailureIsRetriedThenSucceedsInvisibly() {
        FlakyProvider flaky = new FlakyProvider(1, List.of(
                new PTextDelta("hi"), new PUsage(1, 1), new PStop(PStop.StopReason.END_TURN)));
        AtomicInteger sleeps = new AtomicInteger();
        RetryingProvider retrying = new RetryingProvider(flaky, ZERO, (millis, signal) -> sleeps.incrementAndGet());

        List<ProviderEvent> events = drain(retrying, request(new CancelSignal()));

        assertEquals(List.of(new PTextDelta("hi"), new PUsage(1, 1),
                new PStop(PStop.StopReason.END_TURN)), events);
        assertEquals(2, flaky.streamCalls.get(), "one failed attempt, one success");
        assertEquals(1, sleeps.get(), "slept once between the two attempts");
    }

    @Test
    void aNonTransientFailurePropagatesWithoutRetry() {
        LlmProvider bad = request -> { throw new IllegalArgumentException("bad request"); };
        AtomicInteger sleeps = new AtomicInteger();
        RetryingProvider retrying = new RetryingProvider(bad, ZERO, (millis, signal) -> sleeps.incrementAndGet());

        assertThrows(IllegalArgumentException.class,
                () -> drain(retrying, request(new CancelSignal())));
        assertEquals(0, sleeps.get(), "a terminal error is never slept on");
    }

    @Test
    void exhaustedRetriesRethrowSoTheAgentStillErrors() {
        FlakyProvider flaky = new FlakyProvider(99, List.of(new PStop(PStop.StopReason.END_TURN)));
        RetryingProvider retrying = new RetryingProvider(flaky, ZERO, (millis, signal) -> { });

        assertThrows(TransientProviderException.class,
                () -> drain(retrying, request(new CancelSignal())));
        assertEquals(4, flaky.streamCalls.get(), "1 initial + 3 retries, then rethrow");
    }

    @Test
    void aCancelledSignalShortCircuitsWithoutSleeping() {
        LlmProvider alwaysTransient = request -> { throw new TransientProviderException("503"); };
        CancelSignal cancelled = new CancelSignal();
        cancelled.cancel();
        AtomicInteger sleeps = new AtomicInteger();
        RetryingProvider retrying = new RetryingProvider(alwaysTransient, ZERO,
                (millis, signal) -> sleeps.incrementAndGet());

        assertThrows(TransientProviderException.class,
                () -> drain(retrying, request(cancelled)));
        assertEquals(0, sleeps.get(), "a cancel during a transient failure aborts, never sleeps");
    }

    /**
     * Card 557: a stop pressed during the backoff ends the wait at once. The
     * production pause, a three second delay, and a stop 200 ms into it.
     */
    @Test
    @Timeout(value = 10, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
    void aStopDuringTheBackoffEndsTheWaitAtOnce() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        CountDownLatch failed = new CountDownLatch(1);
        LlmProvider refused = request -> {
            attempts.incrementAndGet();
            failed.countDown();
            throw new TransientProviderException("connection refused");
        };
        LlmProvider retrying = RetryingProvider.wrap(refused,
                new RetryPolicy(2, Duration.ofSeconds(3), Duration.ofSeconds(3), 0.0));
        CancelSignal signal = new CancelSignal();
        AtomicReference<Throwable> outcome = new AtomicReference<>();
        Thread run = Thread.ofVirtual().start(() -> {
            try {
                drain(retrying, request(signal));
            } catch (RuntimeException thrown) {
                outcome.set(thrown);
            }
        });
        assertTrue(failed.await(2, TimeUnit.SECONDS), "the first attempt never ran");
        Thread.sleep(200); // inside the three second backoff now

        long pressed = System.nanoTime();
        signal.cancel();
        run.join(Duration.ofSeconds(5));
        long millis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - pressed);
        System.out.println("card 557 measured: stop during the backoff: " + millis + " ms to the end of the wait");

        assertTrue(millis < 1_000, "the backoff went on for " + millis
                + " ms after the stop; the budget is 1000 ms");
        assertEquals(1, attempts.get(), "an attempt started after the stop");
        assertInstanceOf(TransientProviderException.class, outcome.get(),
                "the failure that started the backoff is what the stopped run reports");
    }

    /**
     * Card 557: a stop that lands while the backoff waits is not followed by
     * another attempt, even when the pause returns normally.
     */
    @Test
    void aStopDuringTheBackoffStartsNoNewAttempt() {
        FlakyProvider flaky = new FlakyProvider(99, List.of(new PStop(PStop.StopReason.END_TURN)));
        CancelSignal signal = new CancelSignal();
        RetryingProvider retrying = new RetryingProvider(flaky, ZERO, (millis, s) -> signal.cancel());

        assertThrows(TransientProviderException.class, () -> drain(retrying, request(signal)));
        assertEquals(1, flaky.streamCalls.get(), "a stop during the backoff was followed by another attempt");
    }

    @Test
    void wrapIsAPassThroughWhenRetriesAreDisabled() {
        FlakyProvider flaky = new FlakyProvider(0, List.of(new PStop(PStop.StopReason.END_TURN)));
        LlmProvider wrapped = RetryingProvider.wrap(flaky, RetryPolicy.from(0));
        assertTrue(wrapped == flaky, "maxRetries<=0 returns the delegate unwrapped");
    }

    @Test
    void providerNameDelegates() {
        FlakyProvider flaky = new FlakyProvider(0, List.of());
        RetryingProvider retrying = new RetryingProvider(flaky, ZERO, (millis, signal) -> { });
        assertEquals("flaky", retrying.providerName());
    }
}
