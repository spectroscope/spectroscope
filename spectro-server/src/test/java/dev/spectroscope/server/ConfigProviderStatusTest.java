package dev.spectroscope.server;

import org.junit.jupiter.api.Test;

import java.util.Map;

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
}
