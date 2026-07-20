package dev.spectroscope;

import dev.spectroscope.core.provider.AnthropicProvider;
import dev.spectroscope.core.provider.LlmProvider;

/**
 * Anthropic provider factories that read as plain names — the frozen facade's
 * provider vocabulary: {@code .model(Anthropic.opus())}. Construction is
 * cheap and offline; the API key is read when the first request streams.
 */
public final class Anthropic {

    private Anthropic() {}

    /** @return the strongest Claude tier (claude-opus-4-8), prompt caching on */
    public static LlmProvider opus() {
        return model("claude-opus-4-8");
    }

    /** @return the balanced Claude tier (claude-sonnet-5), prompt caching on */
    public static LlmProvider sonnet() {
        return model("claude-sonnet-5");
    }

    /** @return the fast Claude tier (claude-haiku-4-5), prompt caching on */
    public static LlmProvider haiku() {
        return model("claude-haiku-4-5-20251001");
    }

    /**
     * Any Anthropic model id, for the tiers between the plain names.
     *
     * @param modelId the model id every request is sent to
     * @return the provider, prompt caching on
     */
    public static LlmProvider model(String modelId) {
        return new AnthropicProvider(modelId, true);
    }
}
