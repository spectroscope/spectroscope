package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.playbook.run.PinnedPlaybook;
import dev.spectroscope.server.providers.ProviderRow;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 482: the confirmation the sheet shows, and the route that serves it. */
class PlaybookStartPreviewTest {

    /** The core pin test's bundle, spelled again with a command check, because test classes do not cross modules. */
    static final String BUNDLE = """
        { "schema_version": 1, "id": "b", "name": "Bundle", "description": "d",
          "models": { "fast": { "primary": { "provider": "ollama", "model": "qwen3:8b" } },
                      "strong": { "primary": { "provider": "anthropic", "model": "claude-opus" } } },
          "documents": { "spec": { "name": "Spec", "purpose": "the design", "location": "docs/{slug}-design.md",
                                   "template": "templates/spec.md", "sections": ["Goal", "Design"] } },
          "checks": { "spec_ok": { "kind": "sections", "documents": ["spec"] },
                      "tests": { "kind": "command", "run": "{test} -q" } },
          "vars": { "test": "python3 -m unittest" },
          "start": "brainstorm",
          "nodes": [
            { "kind": "step", "id": "brainstorm", "name": "Brainstorm", "goal": "Agree the design.",
              "skills": ["spectropowers:brainstorming", "house-rules", "nowhere"], "model": "fast", "produces": ["spec"] },
            { "kind": "decision", "id": "spec_ok", "name": "Spec complete", "check": "spec_ok", "max_rounds": 2 },
            { "kind": "step", "id": "implement", "name": "Implement", "goal": "Build it.", "performer": "child",
              "role": "worker", "model": "strong", "consumes": ["spec"] },
            { "kind": "decision", "id": "tests_ok", "name": "Tests pass", "check": "tests", "max_rounds": 2 },
            { "kind": "end", "id": "done", "result": "done" }
          ],
          "arrows": [
            { "from": "brainstorm", "to": "spec_ok" },
            { "from": "spec_ok", "to": "implement", "on": "pass" },
            { "from": "spec_ok", "to": "brainstorm", "on": "fail" },
            { "from": "spec_ok", "to": "done", "on": "exhausted" },
            { "from": "implement", "to": "tests_ok" },
            { "from": "tests_ok", "to": "done", "on": "pass" },
            { "from": "tests_ok", "to": "implement", "on": "fail" },
            { "from": "tests_ok", "to": "done", "on": "exhausted" }
          ],
          "contents": { "skills": ["skills/spectropowers"] } }
        """;

    @TempDir Path tmp;

    private Path folder(String json) throws IOException {
        Path dir = Files.createDirectories(tmp.resolve("pb"));
        Files.writeString(dir.resolve("playbook.json"), json);
        Files.createDirectories(dir.resolve("templates"));
        Files.writeString(dir.resolve("templates/spec.md"), "# Goal\n\n# Design\n");
        Path skill = Files.createDirectories(dir.resolve("skills/spectropowers/brainstorming"));
        Files.writeString(skill.resolve("SKILL.md"), "Ask one question at a time.");
        return dir;
    }

    private static SpectroConfig config() {
        return SpectroConfig.load(SpectroConfig.Overrides.none());
    }

    private static ProviderRow row(String id, String kind, String state) {
        return new ProviderRow(id, kind, state, false, null, null, List.of(), false, null, 0L);
    }

    private static final Function<String, ProviderRow> ROWS = id -> switch (id) {
        case "ollama" -> row("ollama", "local", "reachable");
        case "anthropic" -> row("anthropic", "cloud", "configured");
        default -> null;
    };

    private static String installed(String name) {
        return "house-rules".equals(name) ? "Stage explicit paths." : null;
    }

    private PlaybookStartPreview preview(Path dir, Function<String, ProviderRow> rows) throws IOException {
        PlaybookLoader.Loaded loaded = PlaybookLoader.load(dir, tmp, config());
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, loaded.playbook(), PlaybookStartPreviewTest::installed);
        return PlaybookStartPreview.of(loaded, pinned, rows, true);
    }

    @Test
    void theHashIsTheHashTheStartFrameChecksAndTheCommandsAreFilled() throws IOException {
        Path dir = folder(BUNDLE);
        PlaybookStartPreview shown = preview(dir, ROWS);
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, PlaybookLoader.load(dir, tmp, config()).playbook(),
                PlaybookStartPreviewTest::installed);

        assertEquals(pinned.hash(), shown.hash());
        assertEquals(dir.toRealPath().toString(), shown.dir());
        assertEquals(List.of("python3 -m unittest -q"), shown.commands());
        assertEquals(List.of(), shown.findings());
        assertTrue(shown.topology() != null);
    }

    @Test
    void theSkillsNameTheirSourceAndAMissingOneRefuses() throws IOException {
        PlaybookStartPreview shown = preview(folder(BUNDLE), ROWS);

        assertEquals(List.of(
                new PlaybookStartPreview.SkillPlan("spectropowers:brainstorming", "playbook"),
                new PlaybookStartPreview.SkillPlan("house-rules", "installed"),
                new PlaybookStartPreview.SkillPlan("nowhere", "missing")), shown.skills());
        assertTrue(shown.refusals().contains("skill not found: nowhere"), shown.refusals().toString());
    }

    @Test
    void theStepTableNamesTheModelTheProviderAndItsState() throws IOException {
        PlaybookStartPreview shown = preview(folder(BUNDLE), ROWS);

        assertEquals(List.of(
                new PlaybookStartPreview.StepPlan("brainstorm", "Brainstorm", "chat", null, "fast", "ollama",
                        "qwen3:8b", "local", "reachable", "cheap", "inherit", false),
                new PlaybookStartPreview.StepPlan("implement", "Implement", "child", "worker", "strong",
                        "anthropic", "claude-opus", "cloud", "configured", "cheap", "inherit", false)),
                shown.steps());
    }

    @Test
    void aPrivateStepOnTheCloudIsRefusedByName() throws IOException {
        String json = BUNDLE.replace("\"model\": \"fast\", \"produces\"",
                "\"model\": \"strong\", \"privacy\": \"private\", \"produces\"");
        PlaybookStartPreview shown = preview(folder(json), ROWS);

        assertTrue(shown.refusals().contains(
                "brainstorm: a private step may not run on the cloud provider anthropic"), shown.refusals().toString());
    }

    @Test
    void aProviderTheRegistryDoesNotKnowReadsAsCloud() throws IOException {
        String json = BUNDLE.replace("\"model\": \"fast\", \"produces\"",
                "\"model\": \"fast\", \"privacy\": \"private\", \"produces\"");
        PlaybookStartPreview shown = preview(folder(json), id -> null);

        assertTrue(shown.refusals().contains(
                "brainstorm: a private step may not run on the cloud provider ollama"), shown.refusals().toString());
        assertEquals("cloud", shown.steps().get(0).providerKind());
        assertEquals("unknown", shown.steps().get(0).providerState());
    }

    @Test
    void aFindingIsARefusalWithItsPath() throws IOException {
        Path dir = Files.createDirectories(tmp.resolve("broken"));
        Files.writeString(dir.resolve("playbook.json"), "{ \"schema_version\": 1 }");
        PlaybookLoader.Loaded loaded = PlaybookLoader.load(dir, tmp, config());
        PlaybookStartPreview shown = PlaybookStartPreview.of(loaded, null, ROWS, true);

        assertTrue(!loaded.findings().isEmpty());
        assertNull(shown.hash());
        assertEquals(List.of(), shown.steps());
        assertEquals(loaded.findings().stream().map(f -> f.path() + ": " + f.message()).toList(), shown.refusals());
    }

    // ---- GET /api/playbooks/start-preview --------------------------------- //

    private PlaybookController controller(Path dir) throws IOException {
        PlaybookFolders folders = new PlaybookFolders(tmp.resolve(dir == null ? "empty.json" : "playbooks.json"));
        if (dir != null) {
            folders.register(dir);
        }
        return new PlaybookController(folders, "none", config -> List.of(
                row("ollama", "local", "reachable"), row("anthropic", "cloud", "configured")));
    }

    @Test
    void theRouteServesThePreviewOfARegisteredFolder() throws IOException {
        Path dir = folder(BUNDLE);
        ResponseEntity<PlaybookStartPreview> res = controller(dir).startPreview(dir.toString(), tmp.toString(),
                new MockHttpServletRequest());

        assertEquals(200, res.getStatusCode().value());
        assertTrue(res.getBody().hash().startsWith("sha256:"), res.getBody().hash());
        assertEquals("local", res.getBody().steps().get(0).providerKind());
        assertEquals("cloud", res.getBody().steps().get(1).providerKind());
    }

    @Test
    void theRouteRefusesAForeignCallerAndAFolderThatIsNotRegistered() throws IOException {
        Path dir = folder(BUNDLE);
        MockHttpServletRequest remote = new MockHttpServletRequest();
        remote.setRemoteAddr("203.0.113.7");
        MockHttpServletRequest crossSite = new MockHttpServletRequest();
        crossSite.addHeader("Origin", "https://evil.example");

        assertEquals(404, controller(dir).startPreview(dir.toString(), tmp.toString(), remote).getStatusCode().value());
        assertEquals(404, controller(dir).startPreview(dir.toString(), tmp.toString(), crossSite).getStatusCode().value());
        assertEquals(400, controller(null).startPreview(dir.toString(), tmp.toString(),
                new MockHttpServletRequest()).getStatusCode().value());
    }
}
