package dev.spectroscope.samples.fleet;

import dev.spectroscope.core.provider.LlmProvider;

import java.util.List;

/**
 * A deliberately tiny offline {@link LlmProvider}: every call answers with
 * one fixed text and ends the turn. It exists so this sample runs without a
 * key, a server, or a network — the fleet mechanics (lanes, merged stream,
 * A2A task/result messages) are real; only the "model" is scripted.
 *
 * <p>Copied into each sample that needs it, on purpose: every sample stays
 * self-contained.</p>
 */
final class ScriptedProvider implements LlmProvider {

    private final String answer;

    ScriptedProvider(String answer) {
        this.answer = answer;
    }

    @Override
    public Iterable<ProviderEvent> stream(ProviderRequest request) {
        return List.of(
                new PTextDelta(answer),
                new PUsage(24, 12),
                new PStop(PStop.StopReason.END_TURN));
    }

    @Override
    public String modelName() {
        return "scripted";
    }

    @Override
    public String providerName() {
        return "scripted";
    }
}
