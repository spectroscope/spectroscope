package dev.spectroscope.server;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The server's provider router: spectro-local goes through the local runtime;
 *  every other provider through the shared ProviderFactory. */
class ServerProvidersTest {

    private static SpectroConfig withProvider(String provider) {
        return SpectroConfig.load(new SpectroConfig.Overrides(provider, null, null, null, null, null));
    }

    private static final LlmProvider STUB = request -> List.of();

    @Test
    void spectroLocalUsesTheLocalProvider() {
        LlmProvider built = ServerProviders.build(withProvider("spectro-local"), () -> Optional.of(STUB));
        assertSame(STUB, built, "spectro-local is built by the local runtime, not ProviderFactory");
    }

    @Test
    void spectroLocalWithoutAReadyModelFailsReadably() {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> ServerProviders.build(withProvider("spectro-local"), Optional::empty));
        assertTrue(e.getMessage().toLowerCase().contains("download"),
                "points the user at the download: " + e.getMessage());
    }

    @Test
    void ollamaGoesThroughProviderFactory() {
        // ollama needs no key and builds without a running backend — a non-null
        // provider proves the delegation path (not the local runtime).
        LlmProvider built = ServerProviders.build(withProvider("ollama"), Optional::empty);
        assertEquals(false, built == null);
    }
}
