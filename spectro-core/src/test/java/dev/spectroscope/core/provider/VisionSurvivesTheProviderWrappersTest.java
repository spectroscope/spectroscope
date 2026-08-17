package dev.spectroscope.core.provider;

import dev.spectroscope.core.log.Logged;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 252: the fence asks the provider the AGENT holds, and no session holds a
 * bare one.
 *
 * <p>What a session really carries is
 * {@code SwitchableProvider(RetryingProvider(Logged.wrap(real)))} — assembled in
 * {@code SpectroConfig.providerFromConfig} and wrapped once more by the server's
 * mid-session switch. A wrapper that answers the capability question itself
 * instead of forwarding it leaves the fence permanently open, and that failure
 * is invisible: every test that talks to a provider directly stays green while
 * the shipped session sends the image anyway.</p>
 */
class VisionSurvivesTheProviderWrappersTest {

    /** A provider that knows one thing about itself and streams nothing. */
    private record Sighted(Vision sight) implements LlmProvider {
        @Override
        public Vision vision() {
            return sight;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            return List.of(new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static LlmProvider asASessionBuildsIt(LlmProvider real) {
        // The exact chain of SpectroConfig#providerFromConfig: the autologging
        // proxy inside, the retry decorator outside.
        return RetryingProvider.wrap(Logged.wrap(LlmProvider.class, real), RetryPolicy.from(2));
    }

    @Test
    void aBlindModelIsStillBlindThroughLoggingRetryAndTheMidSessionSwitch() {
        SwitchableProvider held = new SwitchableProvider(
                asASessionBuildsIt(new Sighted(LlmProvider.Vision.BLIND)), "openai");

        assertEquals(LlmProvider.Vision.BLIND, held.vision(),
                "the verdict must reach the request builder through every wrapper");
    }

    @Test
    void switchingToAModelThatSeesReopensTheFenceAtOnce() {
        // The swap replaces the question, not just the answer: an operator who
        // switches to a vision model after the refusal expects the NEXT prompt to
        // carry the picture, and a verdict cached in the wrapper would deny it.
        SwitchableProvider held = new SwitchableProvider(
                asASessionBuildsIt(new Sighted(LlmProvider.Vision.BLIND)), "openai");
        assertEquals(LlmProvider.Vision.BLIND, held.vision());

        held.swap(asASessionBuildsIt(new Sighted(LlmProvider.Vision.SEES)), "anthropic");

        assertEquals(LlmProvider.Vision.SEES, held.vision());
    }

    @Test
    void aProviderThatSaysNothingIsUnknownAndNotBlind() {
        // The default arm, through the same wrappers: every foreign implementation
        // (the samples, a LangChain4j bridge) inherits it, and reading it as a
        // refusal would strip images from providers nobody ever asked.
        LlmProvider silent = request -> List.of(new LlmProvider.PStop(
                LlmProvider.PStop.StopReason.END_TURN));
        assertEquals(LlmProvider.Vision.UNKNOWN,
                new SwitchableProvider(asASessionBuildsIt(silent), "openai").vision());
    }
}
