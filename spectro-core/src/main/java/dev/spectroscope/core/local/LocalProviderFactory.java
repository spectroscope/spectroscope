package dev.spectroscope.core.local;

import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.OpenAiCompatProvider;

import java.nio.file.Path;
import java.util.Optional;

/**
 * Turns a running {@link LocalRuntime} into the provider that drives it. The
 * bundled model is reached through the SAME OpenAI-compatible wire as every
 * other local server — so the agent loop needs no new provider, only a base URL
 * that happens to point at a supervised {@code llama-server}.
 *
 * <p>The server (or CLI) intercepts {@code provider == "spectro-local"} before
 * the pure {@link dev.spectroscope.core.config.SpectroConfig#providerFromConfig()}
 * (which cannot start a subprocess) and calls this instead.</p>
 */
public final class LocalProviderFactory {

    private LocalProviderFactory() {
    }

    /**
     * Build the spectro-local provider by ensuring the runtime is up.
     *
     * @param runtime   the local runtime supervisor
     * @param modelFile the resolved GGUF path
     * @return the OpenAI-compatible provider pointed at the runtime, or empty
     *         when the runtime never became healthy (the caller surfaces a
     *         readable "local model unavailable" message)
     */
    public static Optional<LlmProvider> build(LocalRuntime runtime, Path modelFile) {
        return runtime.ensureRunning(modelFile).map(endpoint ->
                new OpenAiCompatProvider(new OpenAiCompatProvider.Options(
                        endpoint.baseUrl(), endpoint.model(), endpoint.apiKey())));
    }
}
