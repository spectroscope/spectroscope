package dev.spectroscope.core.local;

/**
 * Per-model capabilities the agent loop reads. The bundled VibeThinker is a
 * reasoner without native {@code tool_calls} (measured against LM Studio: it
 * emits the call as text and can run away in the think channel); everything
 * else assumes native tools. A per-model FACT, not a special case buried in the
 * loop — Tier 2's grammar adapter flips {@code nativeTools} when a local model
 * earns it.
 *
 * @param nativeTools whether the model speaks the OpenAI {@code tool_calls} protocol
 * @param reasoning   whether the model is reasoning-tuned (emits a think channel)
 */
public record ModelProfile(boolean nativeTools, boolean reasoning) {

    /**
     * The profile for a provider.
     *
     * @param provider the provider name
     * @return {@code spectro-local} → reasoning, no native tools; all others →
     *         native tools, not reasoning-tuned
     */
    public static ModelProfile forProvider(String provider) {
        if ("spectro-local".equals(provider)) {
            return new ModelProfile(false, true);
        }
        return new ModelProfile(true, false);
    }
}
