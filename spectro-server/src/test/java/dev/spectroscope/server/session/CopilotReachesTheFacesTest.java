package dev.spectroscope.server.session;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.copilot.CopilotCredentials;
import java.io.IOException;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Card 496: what this controller answers for a provider that signs in. The
 * first-run status says signed in or needs a sign-in, never "local" and never
 * "needs-key", and the model list stays empty until there is a sign-in, so an
 * empty home starts no Copilot runtime for a picker that only looked.
 */
class CopilotReachesTheFacesTest {

    @Test
    @SuppressWarnings("unchecked")
    void everySignInProviderHasASignInWordInTheOnboardingStatus() throws IOException {
        Files.deleteIfExists(CopilotCredentials.defaultPath());
        Map<String, String> status = (Map<String, String>) new SessionsController().config().get("providerStatus");

        assertFalse(SpectroConfig.signInProviders().isEmpty());
        for (String provider : SpectroConfig.signInProviders()) {
            assertEquals("needs-signin", status.get(provider),
                    provider + " in an empty home: " + status);
        }
        assertTrue(Set.of("signed-in", "needs-signin").containsAll(
                SpectroConfig.signInProviders().stream().map(status::get).toList()));
    }

    @Test
    void theModelListOfASignInProviderHasItsOwnWire() {
        assertEquals("copilot", SessionsController.modelWire("copilot", p -> false));
    }

    @Test
    void withoutASignInTheRuntimeIsNotAskedForItsModels() {
        java.util.concurrent.atomic.AtomicInteger asked = new java.util.concurrent.atomic.AtomicInteger();

        assertEquals(List.of(), SessionsController.copilotModels(false, () -> {
            asked.incrementAndGet();
            return List.of("auto");
        }));
        assertEquals(0, asked.get(), "a picker that only looks must not start a runtime");
        assertEquals(List.of("auto", "claude-sonnet-5"),
                SessionsController.copilotModels(true, () -> List.of("auto", "claude-sonnet-5")));
        assertEquals(List.of(), SessionsController.copilotModels(true, () -> {
            throw new IllegalStateException("copilot runtime: not installed");
        }), "a missing runtime is an empty list, not an error page");
    }

    @Test
    void withoutASignInTheCopilotModelListIsEmpty() throws IOException {
        Files.deleteIfExists(CopilotCredentials.defaultPath());

        assertEquals(List.of(), new SessionsController().models("copilot"));
    }
}
