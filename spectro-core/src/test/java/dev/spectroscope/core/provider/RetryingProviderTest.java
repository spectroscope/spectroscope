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
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The retry decorator, proven against tiny in-memory providers — no network.
 * Retry is scoped to failures before the first event, honours the cancel signal,
 * and never sleeps in tests (a spy Sleeper counts calls; backoff is injected).
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
        RetryingProvider retrying = new RetryingProvider(flaky, ZERO, millis -> sleeps.incrementAndGet());

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
        RetryingProvider retrying = new RetryingProvider(bad, ZERO, millis -> sleeps.incrementAndGet());

        assertThrows(IllegalArgumentException.class,
                () -> drain(retrying, request(new CancelSignal())));
        assertEquals(0, sleeps.get(), "a terminal error is never slept on");
    }

    @Test
    void exhaustedRetriesRethrowSoTheAgentStillErrors() {
        FlakyProvider flaky = new FlakyProvider(99, List.of(new PStop(PStop.StopReason.END_TURN)));
        RetryingProvider retrying = new RetryingProvider(flaky, ZERO, millis -> {});

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
                millis -> sleeps.incrementAndGet());

        assertThrows(TransientProviderException.class,
                () -> drain(retrying, request(cancelled)));
        assertEquals(0, sleeps.get(), "a cancel during a transient failure aborts, never sleeps");
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
        RetryingProvider retrying = new RetryingProvider(flaky, ZERO, millis -> {});
        assertEquals("flaky", retrying.providerName());
    }
}
