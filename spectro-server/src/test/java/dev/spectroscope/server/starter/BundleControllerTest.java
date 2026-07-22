package dev.spectroscope.server.starter;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The starter-bundle endpoints, exercised directly (no MockMvc): list, fetch,
 *  and scaffold-into-a-folder with its read-only-safe guards. */
class BundleControllerTest {

    private final BundleController controller = new BundleController();
    private final ObjectMapper mapper = new ObjectMapper();

    private JsonNode body(String dir, String build) {
        ObjectNode node = mapper.createObjectNode();
        if (dir != null) node.put("dir", dir);
        if (build != null) node.put("build", build);
        return node;
    }

    @Test
    void listsTheCatalog() {
        Map<String, Object> out = controller.list();
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> bundles = (List<Map<String, Object>>) out.get("bundles");
        assertEquals(3, bundles.size());
        assertEquals(List.of("gradle", "maven"), out.get("buildTools"));
    }

    @Test
    void getRendersAKnownBundleAndBuildTool() {
        var response = controller.get("fleet", "maven");
        assertEquals(200, response.getStatusCode().value());
        @SuppressWarnings("unchecked")
        Map<String, Object> map = (Map<String, Object>) response.getBody();
        assertEquals("maven", map.get("buildTool"));
        @SuppressWarnings("unchecked")
        Map<String, String> files = (Map<String, String>) map.get("files");
        assertTrue(files.containsKey("pom.xml"));
    }

    @Test
    void getUnknownBundleIs404() {
        assertEquals(404, controller.get("nope", "gradle").getStatusCode().value());
    }

    @Test
    void scaffoldWritesEveryFileIntoThePickedFolder(@TempDir Path dir) throws Exception {
        var response = controller.scaffold("five-lines", body(dir.toString(), "gradle"));
        assertEquals(200, response.getStatusCode().value());
        assertTrue(Files.exists(dir.resolve("settings.gradle.kts")));
        assertTrue(Files.exists(dir.resolve("build.gradle.kts")));
        assertTrue(Files.exists(dir.resolve("src/main/java/demo/FiveLines.java")));
        assertTrue(Files.readString(dir.resolve("build.gradle.kts")).contains("spectro-core:0.2.0"));
    }

    @Test
    void scaffoldRefusesToOverwriteExistingFiles(@TempDir Path dir) throws Exception {
        Files.writeString(dir.resolve("build.gradle.kts"), "// mine, keep it");
        var response = controller.scaffold("five-lines", body(dir.toString(), "gradle"));
        assertEquals(409, response.getStatusCode().value());
        // the conflict is reported and NOTHING else was written
        assertFalse(Files.exists(dir.resolve("settings.gradle.kts")));
        assertEquals("// mine, keep it", Files.readString(dir.resolve("build.gradle.kts")));
    }

    @Test
    void scaffoldNeedsADir() {
        assertEquals(400, controller.scaffold("five-lines", body(null, "gradle")).getStatusCode().value());
        assertEquals(400, controller.scaffold("five-lines", body("   ", "gradle")).getStatusCode().value());
    }

    @Test
    void scaffoldRejectsANonDirectory(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("a-file");
        Files.writeString(file, "x");
        assertEquals(400, controller.scaffold("five-lines", body(file.toString(), "gradle")).getStatusCode().value());
    }

    @Test
    void scaffoldUnknownBundleIs404(@TempDir Path dir) {
        assertEquals(404, controller.scaffold("nope", body(dir.toString(), "gradle")).getStatusCode().value());
    }
}
