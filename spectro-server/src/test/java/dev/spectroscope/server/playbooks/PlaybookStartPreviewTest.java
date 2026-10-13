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
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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

    private PlaybookStartPreview preview(Path dir, Function<String, ProviderRow> rows) throws IOException {
        PlaybookLoader.Loaded loaded = PlaybookLoader.load(dir, tmp, config());
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, loaded.playbook());
        return PlaybookStartPreview.of(loaded, pinned, rows, true);
    }

    @Test
    void theHashIsTheHashTheStartFrameChecksAndTheCommandsAreFilled() throws IOException {
        Path dir = folder(BUNDLE);
        PlaybookStartPreview shown = preview(dir, ROWS);
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, PlaybookLoader.load(dir, tmp, config()).playbook());

        assertEquals(pinned.hash(), shown.hash());
        assertEquals(dir.toRealPath().toString(), shown.dir());
        assertEquals(List.of("python3 -m unittest -q"), shown.commands());
        assertEquals(List.of(), shown.findings());
        assertTrue(shown.topology() != null);
    }

    @Test
    void theSkillsNameTheirSourceAndAMissingOneRefuses() throws IOException {
        PlaybookStartPreview shown = preview(folder(BUNDLE), ROWS);

        // Card 558: a skill comes from the folder or is missing; nothing installed elsewhere is read.
        assertEquals(List.of(
                new PlaybookStartPreview.SkillPlan("spectropowers:brainstorming", "playbook"),
                new PlaybookStartPreview.SkillPlan("house-rules", "missing"),
                new PlaybookStartPreview.SkillPlan("nowhere", "missing")), shown.skills());
        assertTrue(shown.refusals().contains("skill not found: house-rules"), shown.refusals().toString());
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

    /**
     * Card 584: a private step on a cloud model is the step's reason, which a
     * local pick lifts, and no longer a refusal no pick can lift. The run
     * itself still refuses it when nothing was picked (PlaybookRunnerPicksTest).
     */
    @Test
    void aPrivateStepOnTheCloudIsNamedOnItsRowAndIsNoRefusal() throws IOException {
        String json = BUNDLE.replace("\"model\": \"fast\", \"produces\"",
                "\"model\": \"strong\", \"privacy\": \"private\", \"produces\"");
        PlaybookStartPreview shown = preview(folder(json), ROWS);

        PlaybookStartPreview.ModelCheck brainstorm = shown.models().get(0);
        assertEquals("brainstorm", brainstorm.node());
        assertFalse(brainstorm.serves());
        assertEquals("private-on-cloud", brainstorm.reason());
        assertTrue(shown.refusals().stream().noneMatch(r -> r.contains("private step")), shown.refusals().toString());
    }

    /** Review D2: a private step whose own model is an Ollama cloud model cannot start on it. */
    @Test
    void aPrivateStepOnAnOllamaCloudModelIsNamedOnItsRow() throws IOException {
        String json = BUNDLE.replace("\"model\": \"fast\", \"produces\"",
                "\"model\": \"fast\", \"privacy\": \"private\", \"produces\"")
                .replace("\"model\": \"qwen3:8b\"", "\"model\": \"minimax-m3:cloud\"");
        PlaybookStartPreview shown = preview(folder(json), id -> "ollama".equals(id)
                ? listing("ollama", "local", "minimax-m3:cloud", "qwen3:8b") : null, id -> null);

        PlaybookStartPreview.ModelCheck brainstorm = shown.models().get(0);
        assertEquals("minimax-m3:cloud", brainstorm.model());
        assertFalse(brainstorm.serves());
        assertEquals("private-on-cloud", brainstorm.reason());
    }

    @Test
    void aProviderTheRegistryDoesNotKnowReadsAsCloudAndUnknown() throws IOException {
        String json = BUNDLE.replace("\"model\": \"fast\", \"produces\"",
                "\"model\": \"fast\", \"privacy\": \"private\", \"produces\"");
        PlaybookStartPreview shown = preview(folder(json), id -> null);

        assertEquals("cloud", shown.steps().get(0).providerKind());
        assertEquals("unknown", shown.steps().get(0).providerState());
        assertEquals("private-on-cloud", shown.models().get(0).reason(), "the stricter assumption holds");
        assertEquals("unknown", shown.models().get(1).reason());
    }

    // ---- card 584: why a model does not serve, and what may be picked ----- //

    private static ProviderRow failed(String id, String kind, String reason, Integer status) {
        return new ProviderRow(id, kind, "failed", true, null, null, List.of(), false, reason, 1L, status);
    }

    private static ProviderRow listing(String id, String kind, String... models) {
        return new ProviderRow(id, kind, "reachable", false, null, null, List.of(models), true, null, 1L, null);
    }

    private PlaybookStartPreview preview(Path dir, Function<String, ProviderRow> rows,
                                         Function<String, String> keySource) throws IOException {
        PlaybookLoader.Loaded loaded = PlaybookLoader.load(dir, tmp, config());
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, loaded.playbook());
        return PlaybookStartPreview.of(loaded, pinned, rows, true, keySource);
    }

    @Test
    void aRejectedKeyNamesItsHttpStatusAndWhereTheKeyCameFromButNeverTheKey() throws IOException {
        Function<String, ProviderRow> rows = id -> switch (id) {
            case "ollama" -> listing("ollama", "local", "qwen3:8b");
            case "anthropic" -> failed("anthropic", "cloud", "rejected-key", 401);
            default -> null;
        };
        List<String> asked = new ArrayList<>();
        PlaybookStartPreview shown = preview(folder(BUNDLE), rows, provider -> {
            asked.add(provider);
            return "saved";
        });

        PlaybookStartPreview.ModelCheck implement = shown.models().get(1);
        assertEquals(new PlaybookStartPreview.ModelCheck("implement", "Implement", "step", "strong", "cheap",
                "anthropic", "claude-opus", false, null, null, "rejected-key", 401, "saved"), implement);
        assertEquals(List.of("anthropic"), asked, "the key source is asked only for a rejected key");
        assertTrue(shown.models().get(0).serves());
        assertNull(shown.models().get(0).reason());
        assertNull(shown.models().get(0).keySource());
    }

    @Test
    void everyReasonAModelDoesNotServeIsOneWordOnItsRow() throws IOException {
        record Case(ProviderRow anthropic, String reason, Integer status) {}
        List<Case> cases = List.of(
                new Case(failed("anthropic", "cloud", "refused", null), "refused", null),
                new Case(failed("anthropic", "cloud", "timeout", null), "timeout", null),
                new Case(failed("anthropic", "cloud", "http-503", 503), "http-503", 503),
                new Case(failed("anthropic", "cloud", "bad-answer", null), "bad-answer", null),
                new Case(listing("anthropic", "cloud", "claude-sonnet"), "not-listed", null),
                new Case(new ProviderRow("anthropic", "cloud", "needs-key", false, null, null, List.of(), false, null,
                        0L), "needs-key", null),
                new Case(new ProviderRow("anthropic", "cloud", "configured", true, null, null, List.of(), false, null,
                        0L), "configured", null));
        for (Case c : cases) {
            PlaybookStartPreview shown = preview(folder(BUNDLE),
                    id -> "anthropic".equals(id) ? c.anthropic() : listing("ollama", "local", "qwen3:8b"),
                    id -> "environment");
            PlaybookStartPreview.ModelCheck implement = shown.models().get(1);
            assertFalse(implement.serves(), c.reason());
            assertEquals(c.reason(), implement.reason());
            assertEquals(c.status(), implement.httpStatus(), c.reason());
            assertNull(implement.keySource(), "only a rejected key names its source: " + c.reason());
        }
    }

    @Test
    void aFallbackThatServesIsNamedAndTheRowServes() throws IOException {
        String json = BUNDLE.replace("\"strong\": { \"primary\": { \"provider\": \"anthropic\", \"model\": \"claude-opus\" } }",
                "\"strong\": { \"primary\": { \"provider\": \"anthropic\", \"model\": \"claude-opus\" },"
                        + " \"fallbacks\": [ { \"provider\": \"ollama\", \"model\": \"qwen3:8b\" } ] }");
        PlaybookStartPreview shown = preview(folder(json), id -> "anthropic".equals(id)
                ? failed("anthropic", "cloud", "rejected-key", 401) : listing("ollama", "local", "qwen3:8b"),
                id -> "saved");

        PlaybookStartPreview.ModelCheck implement = shown.models().get(1);
        assertTrue(implement.serves());
        assertEquals("ollama", implement.viaProvider());
        assertEquals("qwen3:8b", implement.viaModel());
        assertNull(implement.reason());
    }

    @Test
    void aReviewDecisionGetsARowBesideTheSteps() throws IOException {
        String json = BUNDLE.replace("\"tests\": { \"kind\": \"command\", \"run\": \"{test} -q\" }",
                "\"tests\": { \"kind\": \"review\", \"model\": \"strong\", \"reads\": [\"spec\"],"
                        + " \"ask\": \"Does it pass?\", \"labels\": [\"pass\", \"fail\"] }");
        PlaybookStartPreview shown = preview(folder(json), id -> "anthropic".equals(id)
                ? failed("anthropic", "cloud", "timeout", null) : listing("ollama", "local", "qwen3:8b"),
                id -> null);

        assertEquals(List.of("brainstorm:step", "implement:step", "tests_ok:review"),
                shown.models().stream().map(m -> m.node() + ":" + m.kind()).toList());
        assertEquals("Tests pass", shown.models().get(2).name());
        assertEquals("timeout", shown.models().get(2).reason());
        assertEquals(2, shown.steps().size(), "the step table keeps its steps");
    }

    @Test
    void theOffersAreTheProvidersWhoseListAnsweredWithTheirModels() throws IOException {
        Function<String, ProviderRow> rows = id -> switch (id) {
            case "ollama" -> listing("ollama", "local", "qwen3:8b", "llama3:8b");
            case "openai" -> listing("openai", "cloud", "gpt-5");
            case "lmstudio" -> new ProviderRow("lmstudio", "local", "reachable", false, null, null, List.of(), true,
                    null, 1L);
            case "anthropic" -> failed("anthropic", "cloud", "rejected-key", 401);
            case "gemini" -> new ProviderRow("gemini", "cloud", "reachable", true, null, null, List.of("g"), false,
                    null, 1L);
            default -> null;
        };
        PlaybookLoader.Loaded loaded = PlaybookLoader.load(folder(BUNDLE), tmp, config());
        PinnedPlaybook pinned = PinnedPlaybook.pin(tmp.resolve("pb"), loaded.playbook());
        PlaybookStartPreview shown = PlaybookStartPreview.of(loaded, pinned, rows, true, id -> null,
                List.of("anthropic", "gemini", "lmstudio", "ollama", "openai"));

        assertEquals(List.of(
                new PlaybookStartPreview.ModelOffer("ollama", "local", List.of("qwen3:8b", "llama3:8b")),
                new PlaybookStartPreview.ModelOffer("openai", "cloud", List.of("gpt-5"))), shown.offers(),
                "a failed list, an empty list and a list that is not live offer nothing");
    }

    @Test
    void aPlaybookThatDoesNotLoadHasNoModelRowsAndNoOffers() throws IOException {
        Path dir = Files.createDirectories(tmp.resolve("broken"));
        Files.writeString(dir.resolve("playbook.json"), "{ \"schema_version\": 1 }");
        PlaybookLoader.Loaded loaded = PlaybookLoader.load(dir, tmp, config());
        PlaybookStartPreview shown = PlaybookStartPreview.of(loaded, null, ROWS, true, id -> "saved");

        assertEquals(List.of(), shown.models());
        assertEquals(List.of(), shown.offers());
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

    /** Card 558: the route reads an agent role from the folder; nothing is installed for it. */
    @Test
    void theRouteReadsAnAgentRoleFromTheFolderWithNothingInstalled() throws IOException {
        String json = BUNDLE.replace("\"role\": \"worker\"", "\"role\": \"agent:reviewer\"")
                .replace("\"contents\": { \"skills\": [\"skills/spectropowers\"] }",
                        "\"contents\": { \"skills\": [\"skills/spectropowers\"], \"agents\": [\"agents/reviewer.md\"] }");
        Path dir = folder(json);
        Files.createDirectories(dir.resolve("agents"));
        Files.writeString(dir.resolve("agents/reviewer.md"),
                "---\nname: reviewer\ndescription: Reads the diff.\ntype: explore\n---\nYou are the reviewer.\n");
        PlaybookFolders folders = new PlaybookFolders(tmp.resolve("playbooks.json"));
        folders.register(dir);
        PlaybookController controller = new PlaybookController(folders, "none", tmp.resolve("home"), tmp,
                tmp.resolve("home/settings.json"), config -> List.of(row("ollama", "local", "reachable"),
                        row("anthropic", "cloud", "configured")));

        PlaybookStartPreview shown = controller.startPreview(dir.toString(), tmp.toString(),
                new MockHttpServletRequest()).getBody();

        assertTrue(shown.refusals().stream().noneMatch(r -> r.contains("reviewer")), shown.refusals().toString());
        assertTrue(shown.refusals().contains("skill not found: nowhere"), "the other refusals stay: " + shown.refusals());
        assertFalse(Files.exists(tmp.resolve("home")), "nothing was installed to make it run");
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
