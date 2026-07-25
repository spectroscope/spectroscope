package dev.spectroscope.server;

import dev.spectroscope.core.config.ProviderFactory;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;

import java.util.Optional;
import java.util.function.Supplier;

/**
 * The server's provider construction: {@code spectro-local} goes through the
 * bundled local runtime (which spawns {@code llama-server}); every other
 * provider through the shared {@link ProviderFactory}. This is the seam the pure
 * {@code SpectroConfig.providerFromConfig()} deliberately cannot be — starting a
 * subprocess is a server concern.
 */
public final class ServerProviders {

    private ServerProviders() {
    }

    /** Production: the built-in provider comes from {@link ServerLocalRuntime}. */
    public static LlmProvider build(SpectroConfig config) {
        return build(config, ServerLocalRuntime::provider);
    }

    /**
     * Route the config to a provider.
     *
     * @param config        the effective config
     * @param localProvider the built-in provider source (seam for tests)
     * @return the provider; for spectro-local it is the local runtime's, else
     *         the shared factory's
     * @throws IllegalStateException when spectro-local is selected but the model
     *         is not ready — with a message pointing at the download
     */
    static LlmProvider build(SpectroConfig config, Supplier<Optional<LlmProvider>> localProvider) {
        if ("spectro-local".equals(config.provider())) {
            return localProvider.get().orElseThrow(() -> new IllegalStateException(
                    "the built-in model isn't ready — download it from the provider picker"));
        }
        return ProviderFactory.providerFromConfig(config);
    }
}
