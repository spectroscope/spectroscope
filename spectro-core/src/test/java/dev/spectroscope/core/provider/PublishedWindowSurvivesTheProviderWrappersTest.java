package dev.spectroscope.core.provider;

import dev.spectroscope.core.log.Logged;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 391, the twin of {@code ContextWindowSurvivesTheProviderWrappersTest}:
 * the published window is read off the provider the AGENT holds, which is
 * {@code SwitchableProvider(RetryingProvider(Logged.wrap(real)))}. A wrapper
 * that answers the interface default instead of forwarding would put every
 * Ollama cloud session back on the 100,000 fallback, with every test that
 * talks to {@code OllamaProvider} directly still green.
 */
class PublishedWindowSurvivesTheProviderWrappersTest {

    /** A provider that publishes a window, states no loaded one, and streams nothing. */
    private record Published(int window) implements LlmProvider {
        @Override
        public int publishedWindow() {
            return window;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            return List.of(new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static LlmProvider asASessionBuildsIt(LlmProvider real) {
        return RetryingProvider.wrap(Logged.wrap(LlmProvider.class, real), RetryPolicy.from(2));
    }

    @Test
    void thePublishedWindowReachesTheLoopThroughLoggingRetryAndTheMidSessionSwitch() {
        SwitchableProvider held =
                new SwitchableProvider(asASessionBuildsIt(new Published(1_048_576)), "ollama");

        assertEquals(1_048_576, held.publishedWindow());
    }

    @Test
    void switchingModelsSwitchesThePublishedWindowAtOnce() {
        SwitchableProvider held =
                new SwitchableProvider(asASessionBuildsIt(new Published(1_048_576)), "ollama");
        assertEquals(1_048_576, held.publishedWindow());

        held.swap(asASessionBuildsIt(new Published(512_000)), "ollama");

        assertEquals(512_000, held.publishedWindow());
    }

    @Test
    void aProviderThatPublishesNothingReportsZeroThroughEveryWrapper() {
        LlmProvider silent = request -> List.of(new LlmProvider.PStop(
                LlmProvider.PStop.StopReason.END_TURN));

        assertEquals(0, new SwitchableProvider(asASessionBuildsIt(silent), "anthropic")
                .publishedWindow());
    }
}
