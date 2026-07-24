package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SettingsWriter;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.server.ResponseStatusException;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The settings API's read side: process-moment vs session-relative views,
 *  per-field provenance, and the malformed-session-id guard. Plus the write
 *  side (Task 9): user/project/local PUTs through {@link SettingsWriter} —
 *  and the local-origin fences on all of it (settings echo secrets like
 *  {@code otlpBasicAuth}, and the PUTs change config that executes). */
class SettingsControllerTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A legitimate operator request: loopback peer + localhost Host (the
     *  MockHttpServletRequest defaults). */
    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    /** The user-scope PUT tests write the REAL {@link SettingsWriter#userSettingsFile()}
     *  (redirected under the Gradle test {@code user.home}, never the developer's
     *  actual home) — clean it up so no other test in the suite sees it, mirroring
     *  {@code SpectroConfigTest}'s {@code CONFIG_PATH} cleanup. */
    @AfterEach
    void removeUserSettings() throws Exception {
        Files.deleteIfExists(SettingsWriter.userSettingsFile());
    }

    @Test
    void processMomentViewCarriesEffectiveOriginsAndFiles(@TempDir Path launchDir) throws Exception {
        Files.createDirectories(launchDir.resolve(".spectro"));
        Files.writeString(launchDir.resolve(".spectro/settings.json"), """
                { "model": "from-launch-dir" }
                """);
        SettingsController controller = new SettingsController(launchDir, session -> null);

        JsonNode view = JSON.valueToTree(controller.settings(null, local()));
        assertEquals("from-launch-dir", view.path("effective").path("model").asText());
        assertEquals("launch-dir", view.path("origins").path("model").path("winner").asText());
        assertTrue(view.path("files").path("user").asText().endsWith(".spectro/settings.json"));
        assertTrue(view.path("workspace").isNull());
    }

    @Test
    void sessionViewJoinsTheWorkspaceScopes(@TempDir Path launchDir, @TempDir Path ws) throws Exception {
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), """
                { "model": "from-ws" }
                """);
        SettingsController controller = new SettingsController(launchDir, session -> ws.toString());

        JsonNode view = JSON.valueToTree(controller.settings("abc-123", local()));
        assertEquals("from-ws", view.path("effective").path("model").asText());
        assertEquals("project", view.path("origins").path("model").path("winner").asText());
        assertEquals(ws.toString(), view.path("workspace").asText());
    }

    @Test
    void aMalformedSessionIdIs400() {
        SettingsController controller = new SettingsController(Path.of("."), session -> null);
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> controller.settings("../evil", local()));
        assertEquals(400, e.getStatusCode().value());
    }

    @Test
    void putUserWritesAndAnswersTheFreshView(@TempDir Path launchDir) throws Exception {
        SettingsController controller = new SettingsController(launchDir, session -> null);
        JsonNode view = JSON.valueToTree(controller.putUser(
                JSON.readTree("""
                        { "provider": "ollama", "model": "qwen3" }
                        """), local()));
        assertEquals("ollama", view.path("effective").path("provider").asText());
        assertEquals("user", view.path("origins").path("provider").path("winner").asText());
        String written = Files.readString(SettingsWriter.userSettingsFile());
        assertTrue(written.contains("\"ollama\""));
    }

    @Test
    void putProjectNeedsAWorkspaceAndWritesThere(@TempDir Path launchDir, @TempDir Path ws) throws Exception {
        SettingsController controller = new SettingsController(launchDir, session -> ws.toString());
        controller.putProject("abc-123", JSON.readTree("""
                { "autoApprove": ["run_command:git status*"] }
                """), local());
        String written = Files.readString(ws.resolve(".spectro/settings.json"));
        assertTrue(written.contains("git status*"));

        SettingsController unpinned = new SettingsController(launchDir, session -> null);
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> unpinned.putProject("abc-123", JSON.readTree("{}"), local()));
        assertEquals(404, e.getStatusCode().value());
    }

    @Test
    void putLocalWritesTheLocalFilePlusGitignore(@TempDir Path launchDir, @TempDir Path ws) throws Exception {
        SettingsController controller = new SettingsController(launchDir, session -> ws.toString());
        controller.putLocal("abc-123", JSON.readTree("""
                { "provider": "ollama" }
                """), local());
        assertTrue(Files.exists(ws.resolve(".spectro/settings.local.json")));
        assertTrue(Files.readString(ws.resolve(".spectro/.gitignore")).contains("settings.local.json"));
    }

    @Test
    void aBadPatchIs400WithTheReadableMessage(@TempDir Path launchDir) {
        SettingsController controller = new SettingsController(launchDir, session -> null);
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> controller.putUser(JSON.readTree("""
                        { "ANTHROPIC_API_KEY": "sk-x" }
                        """), local()));
        assertEquals(400, e.getStatusCode().value());
        assertTrue(e.getReason().contains("secrets never enter settings files"));
    }

    @Test
    void putUserRefusesADnsReboundHost(@TempDir Path launchDir) {
        // A rebinding page reaches loopback with the attacker's Host. The PUTs
        // change config that EXECUTES (otlpEndpoint reroutes span export, hooks
        // run) — same bar as the key writer: 404, and nothing is written.
        SettingsController controller = new SettingsController(launchDir, session -> null);
        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> controller.putUser(JSON.readTree("""
                        { "otlpEndpoint": "http://evil.example/api/otel" }
                        """), rebound));
        assertEquals(404, e.getStatusCode().value());
        assertFalse(Files.exists(SettingsWriter.userSettingsFile()), "nothing written");
    }

    @Test
    void putUserRefusesACrossSiteOrigin(@TempDir Path launchDir) {
        SettingsController controller = new SettingsController(launchDir, session -> null);
        MockHttpServletRequest crossSite = local();
        crossSite.addHeader("Origin", "https://evil.example");
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> controller.putUser(JSON.readTree("{\"model\":\"x\"}"), crossSite));
        assertEquals(404, e.getStatusCode().value());
    }

    @Test
    void projectAndLocalPutsShareTheFence(@TempDir Path launchDir, @TempDir Path ws) {
        SettingsController controller = new SettingsController(launchDir, session -> ws.toString());
        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        assertEquals(404, assertThrows(ResponseStatusException.class,
                () -> controller.putProject("abc-123", JSON.readTree("{}"), rebound))
                .getStatusCode().value());
        assertEquals(404, assertThrows(ResponseStatusException.class,
                () -> controller.putLocal("abc-123", JSON.readTree("{}"), rebound))
                .getStatusCode().value());
        assertFalse(Files.exists(ws.resolve(".spectro/settings.json")), "nothing written");
    }

    @Test
    void settingsReadRefusesADnsReboundHost(@TempDir Path launchDir) {
        // The read side echoes the effective config AND the raw layers —
        // including otlpBasicAuth (a pk:sk pair) when configured. A rebound
        // same-origin GET must not read it.
        SettingsController controller = new SettingsController(launchDir, session -> null);
        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> controller.settings(null, rebound));
        assertEquals(404, e.getStatusCode().value());
    }
}
