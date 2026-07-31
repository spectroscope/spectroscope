package dev.spectroscope.core.local;

/**
 * Per-model capabilities the agent loop reads. This used to be a property of the
 * provider, which was true only while the built-in provider ran exactly one
 * model: VibeThinker reasons but does not speak {@code tool_calls} (measured
 * against LM Studio, it emits the call as text and can run away in the think
 * channel). Now that an operator chooses from a catalogue, the same provider can
 * run a model that does speak the protocol, so the fact belongs to the model.
 *
 * @param nativeTools whether the model speaks the OpenAI {@code tool_calls} protocol
 * @param reasoning   whether the model is reasoning-tuned (emits a think channel)
 */
public record ModelProfile(boolean nativeTools, boolean reasoning) {

    /**
     * The profile for the model a session is actually running.
     *
     * <p>For {@code spectro-local} the answer comes from the catalogue entry. An
     * unknown or stale id resolves the way the runtime resolves it, to the
     * default model, so what the loop advertises and what llama-server loads
     * never disagree. Every other provider keeps the permissive assumption:
     * native tools, no think channel.</p>
     *
     * @param provider the provider name, may be null
     * @param model    the model name, may be null
     * @return the profile, never null
     */
    public static ModelProfile forModel(String provider, String model) {
        if ("spectro-local".equals(provider)) {
            return LocalCatalog.bundled().resolve(model).profile();
        }
        return new ModelProfile(true, false);
    }
}
