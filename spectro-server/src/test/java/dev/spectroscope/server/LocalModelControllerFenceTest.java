package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.ByteArrayInputStream;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** The download start is a write (it fetches gigabytes to disk), so it wears
 *  the local-origin fence: a rebound Host or cross-site Origin is refused —
 *  for every catalogue model, not just the default. The READS are fenced too
 *  (card 107, one endpoint wider than card 74): the catalogue reports this
 *  machine's RAM, free disk and ready-model list — a hardware fingerprint a
 *  DNS-rebinding page must not read, exactly like the fleet roster. */
class LocalModelControllerFenceTest {

    private LocalModelController controller(Path modelsDir) {
        return new LocalModelController(modelsDir,
                url -> new ByteArrayInputStream(new byte[0]));
    }

    @Test
    void downloadRefusesADnsReboundHost(@TempDir Path modelsDir) {
        MockHttpServletRequest rebound = new MockHttpServletRequest();
        rebound.setServerName("attacker.example");
        assertEquals(404, controller(modelsDir).startDownload(null, rebound)
                .getStatusCode().value());
    }

    @Test
    void downloadRefusesACrossSiteOrigin(@TempDir Path modelsDir) {
        MockHttpServletRequest crossSite = new MockHttpServletRequest();
        crossSite.addHeader("Origin", "https://evil.example");
        assertEquals(404, controller(modelsDir).startDownload(null, crossSite)
                .getStatusCode().value());
    }

    @Test
    void theCatalogRefusesADnsReboundHost(@TempDir Path modelsDir) {
        MockHttpServletRequest rebound = new MockHttpServletRequest();
        rebound.setServerName("attacker.example");
        assertEquals(404, controller(modelsDir).catalog(rebound).getStatusCode().value(),
                "RAM, free disk and the ready-model list are a hardware fingerprint — "
                        + "a rebound Host must not read them");
    }

    @Test
    void theStatusRefusesADnsReboundHost(@TempDir Path modelsDir) {
        MockHttpServletRequest rebound = new MockHttpServletRequest();
        rebound.setServerName("attacker.example");
        assertEquals(404, controller(modelsDir).status(null, rebound)
                .getStatusCode().value());
    }

    @Test
    void aLocalCallerReadsTheCatalog(@TempDir Path modelsDir) {
        assertEquals(200, controller(modelsDir).catalog(new MockHttpServletRequest())
                .getStatusCode().value());
        assertEquals(200, controller(modelsDir).status(null, new MockHttpServletRequest())
                .getStatusCode().value());
    }

    @Test
    void aLocalCallerStartsIt(@TempDir Path modelsDir) throws InterruptedException {
        LocalModelController controller = controller(modelsDir);
        assertEquals(200, controller.startDownload(null, new MockHttpServletRequest())
                .getStatusCode().value());
        // Await the async download VT so it does not race @TempDir cleanup (the
        // stub bytes fail the sha256 check fast -> state leaves "downloading").
        for (int i = 0; i < 200
                && "downloading".equals(controller.status(null, new MockHttpServletRequest())
                        .getBody().get("state")); i++) {
            Thread.sleep(20);
        }
    }
}
