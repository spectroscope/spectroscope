package dev.spectroscope.server.settings;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.hooks.HookRunner;
import dev.spectroscope.core.permission.ToolTierMap;
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
    void theProjectScopeWritesIntoTheFolderTheRunResolved(
            @TempDir Path launchDir, @TempDir Path resolved, @TempDir Path configuredLater)
            throws Exception {
        // Third surface, same folder, third rule. /api/files reads the folder
        // the socket recorded; this recomputed pinned-or-configured from a
        // config read fresh, so a settings write could land in a directory the
        // running agent has never seen.
        SettingsController controller = new SettingsController(
                launchDir, session -> null, session -> resolved.toString());
        controller.putProject("abc-123", JSON.readTree("""
                { "autoApprove": ["run_command:git status*"] }
                """), local());

        assertTrue(Files.exists(resolved.resolve(".spectro/settings.json")),
                "the write missed the folder the run resolved");
        assertTrue(Files.notExists(configuredLater.resolve(".spectro/settings.json")));
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

    // ---- the allowlist read-out (card 199, criterion 4) -----------------------------

    @Test
    void theAllowlistReadOutNamesEveryEntrysTierAndTheMapVersion(@TempDir Path launchDir)
            throws Exception {
        Files.createDirectories(launchDir.resolve(".spectro"));
        Files.writeString(launchDir.resolve(".spectro/settings.json"), """
                { "autoApprove": ["read_file#read", "write_file#write",
                                  "mcp__playwright__*#read", "mcp__playwright__*"] }
                """);
        SettingsController controller = new SettingsController(launchDir, session -> null);

        JsonNode view = JSON.valueToTree(controller.allowlist(null, local()));
        assertEquals(1, view.path("schemaVersion").asInt());
        assertEquals(ToolTierMap.shipped().mapVersion(), view.path("mapVersion").asText());
        assertEquals(3, view.path("tiers").size(), "the page renders the tiers the gate knows");

        JsonNode entries = view.path("scopes").path("launch-dir");
        assertEquals(4, entries.size());
        assertEquals("read", entries.get(0).path("tier").asText());
        assertEquals("read", entries.get(0).path("toolTier").asText());
        assertEquals("write", entries.get(1).path("toolTier").asText(),
                "an exact entry shows the tier the NAMED tool actually holds");
        assertTrue(entries.get(2).path("wildcard").asBoolean());
        assertEquals("read", entries.get(2).path("tier").asText());
        assertTrue(entries.get(3).path("inertBecause").asText().contains("wildcard"),
                "a wildcard without a tier is shown as approving nothing, and why");

        assertEquals(4, view.path("effective").size(),
                "the folded list is answered too, parsed by the SAME matcher the gate uses");
    }

    @Test
    void theAllowlistReadOutIsFencedLikeEveryOtherReadingOfTheSettings(@TempDir Path launchDir) {
        SettingsController controller = new SettingsController(launchDir, session -> null);
        MockHttpServletRequest rebound = new MockHttpServletRequest();
        rebound.addHeader("Host", "evil.example.com");
        assertThrows(org.springframework.web.server.ResponseStatusException.class,
                () -> controller.allowlist(null, rebound));
    }

    // ---- the hooks read-out (card 195) ---------------------------------------------
    //
    // Same rule as the allowlist block above and for the same reason: the server
    // answers what it RESOLVED — the defaulted matcher, the timeout a hook will
    // actually run under, the tier this capability carries — and the page renders
    // it. A default worked out a second time in TypeScript drifts the day the
    // runner's default moves.

    @Test
    void theHooksReadOutResolvesTheDefaultsRatherThanLeavingThemToThePage(@TempDir Path launchDir)
            throws Exception {
        Files.createDirectories(launchDir.resolve(".spectro"));
        Files.writeString(launchDir.resolve(".spectro/settings.json"), """
                { "hooks": [
                    { "event": "pre_tool_use", "command": "guard.sh" },
                    { "event": "post_tool_use", "matcher": "write_*",
                      "command": "notify.sh", "timeoutSeconds": 3 } ] }
                """);
        SettingsController controller = new SettingsController(launchDir, session -> null);

        JsonNode view = JSON.valueToTree(controller.hooks(null, local()));
        JsonNode entries = view.path("scopes").path("launch-dir");
        assertEquals(2, entries.size());
        assertEquals("*", entries.get(0).path("matcher").asText(),
                "an unset matcher is answered as the * the runner will actually use");
        assertTrue(entries.get(0).path("timeoutSeconds").isNull(),
                "what the file says stays visible beside what it resolves to");
        assertEquals(HookRunner.DEFAULT_TIMEOUT_SECONDS,
                entries.get(0).path("effectiveTimeoutSeconds").asLong());
        assertEquals(3, entries.get(1).path("effectiveTimeoutSeconds").asLong());
        assertEquals("write_*", entries.get(1).path("matcher").asText());
        assertEquals(2, view.path("effective").size(), "the folded list is answered too");
    }

    @Test
    void theHooksReadOutStatesTheTierAndTheTwoEventsThatExist(@TempDir Path launchDir) {
        SettingsController controller = new SettingsController(launchDir, session -> null);
        JsonNode view = JSON.valueToTree(controller.hooks(null, local()));

        // A hook is arbitrary shell this product executes, so it carries the
        // widest tier card 199 defined. The page shows that word; it does not
        // choose it.
        assertEquals("eval-execute", view.path("tier").asText());
        assertEquals(HookRunner.DEFAULT_TIMEOUT_SECONDS, view.path("defaultTimeoutSeconds").asLong());
        assertEquals(2, view.path("events").size());
        assertEquals("pre_tool_use", view.path("events").get(0).asText());
        assertEquals("post_tool_use", view.path("events").get(1).asText());
        assertTrue(view.path("scopes").isObject());
        assertTrue(view.path("files").path("user").asText().endsWith(".spectro/settings.json"));
    }

    @Test
    void aHookCommandThatLooksLikeACredentialIsNotEchoedBack(@TempDir Path launchDir) throws Exception {
        // The settings API already echoes otlpBasicAuth and is fenced for it.
        // The hooks block is read by a page that renders commands as text, and a
        // command is the one settings value an operator pastes a token into.
        String secret = "curl -H 'Authorization: Bearer " + "ghp_"
                + "0123456789abcdefghij0123456789abcdef" + "'";
        Files.createDirectories(launchDir.resolve(".spectro"));
        Files.writeString(launchDir.resolve(".spectro/settings.json"),
                JSON.writeValueAsString(JSON.readTree("""
                        { "hooks": [ { "event": "post_tool_use", "command": "%s" } ] }
                        """.formatted(secret))));
        SettingsController controller = new SettingsController(launchDir, session -> null);

        JsonNode entry = JSON.valueToTree(controller.hooks(null, local()))
                .path("scopes").path("launch-dir").get(0);
        assertFalse(entry.path("command").asText().contains("ghp_"), entry.toString());
        assertTrue(entry.path("redactedBy").asText().length() > 0,
                "a hidden command must say WHY it is hidden, or it reads as a broken hook");
    }

    @Test
    void theHooksReadOutIsFencedLikeEveryOtherReadingOfTheSettings(@TempDir Path launchDir) {
        SettingsController controller = new SettingsController(launchDir, session -> null);
        MockHttpServletRequest rebound = new MockHttpServletRequest();
        rebound.addHeader("Host", "evil.example.com");
        assertThrows(ResponseStatusException.class, () -> controller.hooks(null, rebound));
    }

    @Test
    void aHookWithAnUnknownEventIsRefusedByTheWriteRatherThanStoredAndIgnored(
            @TempDir Path launchDir) throws Exception {
        // HookConfig's constructor is the guard; this proves the settings PUT
        // surfaces it as a 400 with the message instead of a 500 stack trace, so
        // the page can show the operator what it did not like.
        SettingsController controller = new SettingsController(launchDir, session -> null);
        ResponseStatusException refused = assertThrows(ResponseStatusException.class,
                () -> controller.putUser(JSON.readTree("""
                        { "hooks": [ { "event": "pre-tool-use", "command": "guard.sh" } ] }
                        """), local()));
        assertEquals(400, refused.getStatusCode().value());
        assertTrue(String.valueOf(refused.getReason()).contains("pre-tool-use"),
                String.valueOf(refused.getReason()));
    }

    @Test
    void aHookWrittenThroughTheSettingsPutIsWhatTheNextRunWouldLoad(@TempDir Path launchDir)
            throws Exception {
        // The page has no write endpoint of its own: one validated write path,
        // not two (the rule card 199 set for the allowlist). This is the proof
        // that the ordinary PUT carries a hooks array end to end.
        SettingsController controller = new SettingsController(launchDir, session -> null);
        controller.putUser(JSON.readTree("""
                { "hooks": [ { "event": "pre_tool_use", "matcher": "run_command",
                               "command": "guard.sh", "timeoutSeconds": 5 } ] }
                """), local());

        JsonNode view = JSON.valueToTree(controller.hooks(null, local()));
        JsonNode entry = view.path("scopes").path("user").get(0);
        assertEquals("run_command", entry.path("matcher").asText());
        assertEquals("guard.sh", entry.path("command").asText());
        assertEquals(5, entry.path("effectiveTimeoutSeconds").asLong());
    }
}
