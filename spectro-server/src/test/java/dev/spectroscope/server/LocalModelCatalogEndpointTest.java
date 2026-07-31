package dev.spectroscope.server;

import dev.spectroscope.core.local.LocalCatalog;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The catalogue endpoint is what the chooser dialog renders: every model the
 * build offers, each with its download state and whether this machine can hold
 * it. One response, so the dialog needs one fetch.
 */
class LocalModelCatalogEndpointTest {

    private LocalModelController controller(Path modelsDir) {
        return new LocalModelController(modelsDir,
                url -> new ByteArrayInputStream(new byte[0]));
    }

    @Test
    @SuppressWarnings("unchecked")
    void theCatalogListsEveryModelWithStateAndPreflight(@TempDir Path modelsDir) {
        Map<String, Object> out =
                controller(modelsDir).catalog(new MockHttpServletRequest()).getBody();
        assertEquals(LocalCatalog.bundled().defaultId(), out.get("defaultId"));

        Map<String, Object> machine = (Map<String, Object>) out.get("machine");
        assertNotNull(machine, "the dialog shows the machine's numbers once, not per row");
        assertTrue(machine.containsKey("ramTotalBytes"));
        assertTrue(machine.containsKey("diskFreeBytes"));
        assertNotNull(machine.get("binaryPresent"),
                "a downloaded model is useless without a llama-server, so say up front whether one exists");

        List<Map<String, Object>> models = (List<Map<String, Object>>) out.get("models");
        assertEquals(LocalCatalog.bundled().models().size(), models.size());
        for (Map<String, Object> m : models) {
            assertNotNull(m.get("id"));
            assertNotNull(m.get("label"));
            assertTrue((long) m.get("sizeBytes") > 0);
            assertNotNull(m.get("nativeTools"), "the tools badge needs this");
            assertNotNull(m.get("reasoning"));
            assertNotNull(m.get("licence"));
            assertNotNull(m.get("licenceUrl"));
            assertNotNull(m.get("sourceUrl"));
            assertEquals("absent", m.get("state"), "an empty home has downloaded nothing");
            Map<String, Object> preflight = (Map<String, Object>) m.get("preflight");
            assertNotNull(preflight.get("ok"));
            assertNotNull(preflight.get("ramOk"));
            assertNotNull(preflight.get("diskOk"));
            assertNotNull(preflight.get("tight"));
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void aModelAlreadyOnDiskReportsReady(@TempDir Path modelsDir) throws Exception {
        LocalCatalog.Model first = LocalCatalog.bundled().models().get(0);
        Files.writeString(modelsDir.resolve(first.file()), "gguf");
        List<Map<String, Object>> models =
                (List<Map<String, Object>>) controller(modelsDir).catalog(new MockHttpServletRequest()).getBody().get("models");
        Map<String, Object> row = models.stream()
                .filter(m -> first.id().equals(m.get("id"))).findFirst().orElseThrow();
        assertEquals("ready", row.get("state"));
    }

    @Test
    void statusTakesAModelAndRefusesAnUnknownOne(@TempDir Path modelsDir) {
        LocalModelController c = controller(modelsDir);
        assertEquals("absent", c.status(LocalCatalog.bundled().defaultId(), new MockHttpServletRequest()).getBody().get("state"));
        assertEquals("absent", c.status(null, new MockHttpServletRequest()).getBody().get("state"),
                "no param means the default model, so the old client keeps working");
        assertEquals(404, c.status("no-such-model", new MockHttpServletRequest()).getStatusCode().value(),
                "an unknown id is a 404, never a silent default that reports the wrong file");
    }

    @Test
    void downloadRefusesAnUnknownModel(@TempDir Path modelsDir) {
        assertEquals(404, controller(modelsDir)
                .startDownload("no-such-model", new MockHttpServletRequest())
                .getStatusCode().value());
    }

    @Test
    void downloadsOfTwoModelsAreIndependent(@TempDir Path modelsDir) throws Exception {
        List<LocalCatalog.Model> models = LocalCatalog.bundled().models();
        LocalModelController c = controller(modelsDir);
        // The stub fetcher hands back empty bytes, so each started download fails
        // its sha check fast — what matters is that starting B does not disturb A.
        c.startDownload(models.get(0).id(), new MockHttpServletRequest());
        c.startDownload(models.get(1).id(), new MockHttpServletRequest());
        for (int i = 0; i < 200; i++) {
            String a = (String) c.status(models.get(0).id(), new MockHttpServletRequest()).getBody().get("state");
            String b = (String) c.status(models.get(1).id(), new MockHttpServletRequest()).getBody().get("state");
            if (!"downloading".equals(a) && !"downloading".equals(b)) {
                break;
            }
            Thread.sleep(20);
        }
        assertEquals("failed", c.status(models.get(0).id(), new MockHttpServletRequest()).getBody().get("state"));
        assertEquals("failed", c.status(models.get(1).id(), new MockHttpServletRequest()).getBody().get("state"));
        assertNull(c.status(models.get(2).id(), new MockHttpServletRequest()).getBody().get("error"),
                "a model nobody touched carries no error");
    }
}
