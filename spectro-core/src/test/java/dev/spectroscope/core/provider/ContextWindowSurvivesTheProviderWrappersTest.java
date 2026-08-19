package dev.spectroscope.core.provider;

import dev.spectroscope.core.log.Logged;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 263, the twin of {@code VisionSurvivesTheProviderWrappersTest}: the
 * threshold is derived from the provider the AGENT holds, and no session holds
 * a bare one.
 *
 * <p>What a session carries is
 * {@code SwitchableProvider(RetryingProvider(Logged.wrap(real)))}. A wrapper
 * that answers the window question itself instead of forwarding it pins every
 * session back onto the 100,000 this card exists to remove — and that failure
 * is invisible: every test that talks to a provider directly stays green.</p>
 */
class ContextWindowSurvivesTheProviderWrappersTest {

    /** A provider that knows its window and streams nothing. */
    private record Sized(int window) implements LlmProvider {
        @Override
        public int contextWindow() {
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
    void theWindowReachesTheLoopThroughLoggingRetryAndTheMidSessionSwitch() {
        SwitchableProvider held =
                new SwitchableProvider(asASessionBuildsIt(new Sized(204_288)), "lmstudio");

        assertEquals(204_288, held.contextWindow(),
                "the window must reach the derivation through every wrapper");
    }

    @Test
    void switchingModelsSwitchesTheWindowAtOnce() {
        // Deliberately not remembered in the wrapper: swapping to another model
        // is swapping the question. An operator who moves from a 200k local
        // model to an 8k one must compact on the small window from the next run.
        SwitchableProvider held =
                new SwitchableProvider(asASessionBuildsIt(new Sized(204_288)), "lmstudio");
        assertEquals(204_288, held.contextWindow());

        held.swap(asASessionBuildsIt(new Sized(8_192)), "ollama");

        assertEquals(8_192, held.contextWindow());
    }

    @Test
    void aProviderThatSaysNothingReportsNoWindowRatherThanAGuess() {
        // Every foreign implementation inherits this: the samples, a LangChain4j
        // bridge, anthropic. Zero means "ask the fallback", never "zero tokens".
        LlmProvider silent = request -> List.of(new LlmProvider.PStop(
                LlmProvider.PStop.StopReason.END_TURN));
        assertEquals(0, new SwitchableProvider(asASessionBuildsIt(silent), "anthropic")
                .contextWindow());
    }
}
