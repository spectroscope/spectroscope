package dev.spectroscope.cli.trace;

import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * {@code --verbose} wraps the provider, and an observer must not answer a
 * capability question on the observed thing's behalf.
 *
 * <p>Card 263 found this hole by biting it: removing
 * {@code TracingProvider.contextWindow()} left the whole suite green, because
 * the wrapper-survival test in spectro-core cannot see a class that lives in
 * spectro-cli. The same hole was open for {@code vision()} since card 252 —
 * pinned here too, because it is the identical failure and it is identically
 * invisible: only a session started with {@code --verbose} would have shown it,
 * which is precisely the mode an operator picks when they want to watch.</p>
 */
class TracingProviderForwardsCapabilitiesTest {

    /** Knows both facts about itself and streams one empty turn. */
    private record Known(int window, LlmProvider.Vision sight) implements LlmProvider {
        @Override
        public int contextWindow() {
            return window;
        }

        @Override
        public Vision vision() {
            return sight;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            return List.of(new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static TracingProvider traced(LlmProvider real) {
        return new TracingProvider(real, "test");
    }

    @Test
    void theWindowSurvivesTheVerboseWrapper() {
        assertEquals(204_288, traced(new Known(204_288, LlmProvider.Vision.SEES)).contextWindow(),
                "a --verbose run must derive its threshold from the same window");
    }

    @Test
    void aWindowlessProviderStaysWindowlessThroughIt() {
        assertEquals(0, traced(new Known(0, LlmProvider.Vision.UNKNOWN)).contextWindow());
    }

    @Test
    void theVisionVerdictSurvivesTheVerboseWrapper() {
        assertEquals(LlmProvider.Vision.BLIND,
                traced(new Known(0, LlmProvider.Vision.BLIND)).vision(),
                "card 252's fence must not fall open under --verbose");
    }
}
