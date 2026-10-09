package dev.spectroscope.server.session;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** /api/config exposes the built-in local provider as its own entry, so the
 *  picker can render "built-in · VibeThinker-3B" with an honest download state. */
class ConfigProviderStatusTest {

    @Test
    @SuppressWarnings("unchecked")
    void providerStatusIncludesSpectroLocal() {
        Map<String, Object> config = new SessionsController().config();
        Map<String, String> status = (Map<String, String>) config.get("providerStatus");
        assertNotNull(status);
        String local = status.get("spectro-local");
        assertNotNull(local, "the built-in provider is its own picker entry");
        assertTrue("ready".equals(local) || "needs-download".equals(local),
                "keyless local status, never needs-key: " + local);
    }

    @Test
    @SuppressWarnings("unchecked")
    void openaiAtAPrivateAddressWithoutAKeyReadsLocal() throws java.io.IOException {
        org.junit.jupiter.api.Assumptions.assumeFalse(SpectroConfig.hasApiKey("OPENAI_API_KEY"));
        java.nio.file.Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        java.nio.file.Files.writeString(SpectroConfig.USER_SETTINGS_PATH,
                "{ \"baseUrl\": \"http://192.168.1.10:8080\" }");
        try {
            Map<String, Object> config = new SessionsController().config();
            Map<String, String> status = (Map<String, String>) config.get("providerStatus");
            assertEquals("local", status.get("openai"),
                    "a private address without a key is a local server, the doctor already says so");
        } finally {
            java.nio.file.Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
        }
    }
}
