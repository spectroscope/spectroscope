package dev.spectroscope.core.config;

import dev.spectroscope.core.provider.LlmProvider;

/**
 * Builds an {@link LlmProvider} from a {@link SpectroConfig}. Headless callers
 * (scheduler, `run` subcommand) and the server share this construction.
 *
 * <p>No console output and no {@code System.exit} in the core: a missing key throws,
 * and the caller decides how to report it. The key check applies ONLY to the
 * anthropic provider — ollama and openai-compatible servers run locally without one.
 */
public final class ProviderFactory {

    /** Static factory only — never instantiated. */
    private ProviderFactory() {
    }

    /**
     * Builds the configured provider after the fail-fast key check — the shared
     * construction path for headless callers and the server.
     *
     * @param config the effective configuration (hierarchy plus CLI overrides)
     * @return the provider named by {@code config.provider()}; the model lives in the
     *     provider constructor
     * @throws IllegalStateException if anthropic is selected but ANTHROPIC_API_KEY is unset
     */
    public static LlmProvider providerFromConfig(SpectroConfig config) {
        if ("anthropic".equals(config.provider()) && System.getenv("ANTHROPIC_API_KEY") == null) {
            throw new IllegalStateException(
                    "ANTHROPIC_API_KEY is not set (export ANTHROPIC_API_KEY=...).");
        }
        return config.providerFromConfig();
    }
}
