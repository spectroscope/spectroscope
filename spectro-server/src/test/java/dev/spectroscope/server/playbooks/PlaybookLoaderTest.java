package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.playbook.Finding;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PlaybookLoaderTest {

    /** The core reader test's MINIMAL playbook, spelled again here because test classes do not cross modules. */
    static final String MINIMAL = """
        { "schema_version": 1, "id": "p", "name": "P", "description": "d",
          "models": { "fast": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "documents": { "spec": { "name": "Spec", "purpose": "design", "location": "docs/{slug}.md",
                                   "template": "templates/spec.md", "sections": ["Goal"] } },
          "checks": { "spec_ok": { "kind": "sections", "documents": ["spec"] } },
          "start": "write",
          "nodes": [
            { "kind": "step", "id": "write", "name": "Write", "skills": ["spectropowers:brainstorming"],
              "model": "fast", "produces": ["spec"] },
            { "kind": "decision", "id": "ok", "name": "Spec ok", "check": "spec_ok", "max_rounds": 2 },
            { "kind": "end", "id": "done", "result": "done" }
          ],
          "arrows": [
            { "from": "write", "to": "ok" },
            { "from": "ok", "to": "done", "on": "pass" },
            { "from": "ok", "to": "write", "on": "fail" },
            { "from": "ok", "to": "done", "on": "exhausted" }
          ],
          "contents": { "skills": ["skills/spectropowers"] } }
        """;

    static final Set<String> PRESENCE_WORDS = Set.of("ready", "needs-key", "local", "needs-download", "unknown");

    @TempDir Path tmp;

    private static SpectroConfig config() {
        return SpectroConfig.load(SpectroConfig.Overrides.none());
    }

    /** A playbook folder holding {@code json} and the spectropowers brainstorming skill its contents names. */
    private Path playbook(String name, String json) throws IOException {
        Path dir = Files.createDirectories(tmp.resolve(name));
        Files.writeString(dir.resolve("playbook.json"), json);
        Path skill = Files.createDirectories(dir.resolve("skills/spectropowers/brainstorming"));
        Files.writeString(skill.resolve("SKILL.md"), "---\nname: brainstorming\ndescription: d\n---\nbody\n");
        return dir;
    }

    private static List<String> paths(List<Finding> findings) {
        return findings.stream().map(Finding::path).toList();
    }

    @Test
    void loadsTheMinimalPlaybookWithItsDrawingAndStepResolution() throws IOException {
        Path dir = playbook("pb", MINIMAL);
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        PlaybookLoader.Loaded loaded = PlaybookLoader.load(dir, ws, config(), ProviderStates.presence());

        assertEquals(List.of(), loaded.findings());
        assertNotNull(loaded.playbook());
        assertEquals(dir.toRealPath().toString(), loaded.dir());
        assertEquals(4, loaded.topology().nodes().size(), "start, write, ok, end");

        assertEquals(1, loaded.steps().size());
        PlaybookLoader.StepResolution write = loaded.steps().get(0);
        assertEquals("write", write.id());
        assertEquals(List.of(new PlaybookLoader.SkillState("spectropowers:brainstorming", false)), write.skills());
        PlaybookLoader.ModelState model = write.model();
        assertEquals("fast", model.choice());
        assertEquals("ollama", model.provider());
        assertEquals("qwen3:8b", model.model());
        assertTrue(PRESENCE_WORDS.contains(model.state()), "a known word: " + model.state());
        assertEquals("local", model.state(), "ollama carries no key variable");
        assertFalse(model.reason().isBlank());
    }

    @Test
    void aSkillInstalledInTheWorkspaceResolvesAsInstalled() throws IOException {
        Path dir = playbook("pb", MINIMAL);
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        Path installed = Files.createDirectories(ws.resolve(".spectro/skills/spectropowers/brainstorming"));
        Files.writeString(installed.resolve("SKILL.md"), "---\nname: brainstorming\ndescription: d\n---\nbody\n");

        PlaybookLoader.Loaded loaded = PlaybookLoader.load(dir, ws, config());

        assertEquals(List.of(new PlaybookLoader.SkillState("spectropowers:brainstorming", true)),
                loaded.steps().get(0).skills());
    }

    @Test
    void theModelStateComesFromTheProviderStatesSeam() throws IOException {
        Path dir = playbook("pb", MINIMAL);
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        ProviderStates fixed = (provider, model, config) -> new ProviderStates.State("ready", "seam:" + provider + "/" + model);

        PlaybookLoader.Loaded loaded = PlaybookLoader.load(dir, ws, config(), fixed);

        PlaybookLoader.ModelState model = loaded.steps().get(0).model();
        assertEquals("ready", model.state());
        assertEquals("seam:ollama/qwen3:8b", model.reason());
    }

    @Test
    void thePresenceWordsFollowTheKeyQuestion() {
        ProviderStates presence = ProviderStates.presence();
        assertEquals("local", presence.of("ollama", "qwen3:8b", config()).state());
        assertEquals("unknown", presence.of("no-such-provider", "m", config()).state());
        String anthropic = presence.of("anthropic", "claude-opus-5-5", config()).state();
        assertTrue(Set.of("ready", "needs-key").contains(anthropic), "a keyed provider answers the key question: " + anthropic);
    }

    @Test
    void aContentsPathOutsideTheFolderIsAFinding() throws IOException {
        Files.createDirectories(tmp.resolve("outside"));
        Path dir = playbook("pb", MINIMAL.replace("\"skills\": [\"skills/spectropowers\"] }",
                "\"skills\": [\"../outside\", \"skills/missing\", \"/etc\"] }"));
        Path ws = Files.createDirectories(tmp.resolve("ws"));

        List<Finding> findings = PlaybookLoader.load(dir, ws, config()).findings();

        assertEquals(List.of(
                new Finding("contents.skills[0]", "leaves the playbook folder"),
                new Finding("contents.skills[1]", "does not exist in the playbook folder"),
                new Finding("contents.skills[2]", "an absolute path; contents paths are relative to the playbook folder")),
                findings);
    }

    @Test
    void aSymlinkLeavingTheFolderIsAFinding() throws IOException {
        Path outside = Files.createDirectories(tmp.resolve("outside"));
        Path dir = playbook("pb", MINIMAL.replace("\"skills\": [\"skills/spectropowers\"] }",
                "\"skills\": [\"skills/escape\"] }"));
        Files.createSymbolicLink(dir.resolve("skills/escape"), outside);
        Path ws = Files.createDirectories(tmp.resolve("ws"));

        assertEquals(List.of(new Finding("contents.skills[0]", "a link that leaves the playbook folder")),
                PlaybookLoader.load(dir, ws, config()).findings());
    }

    @Test
    void aFolderOfMoreThanTwoHundredFilesIsAFinding() throws IOException {
        Path dir = playbook("pb", MINIMAL);
        Path extra = Files.createDirectories(dir.resolve("extra"));
        // playbook.json and SKILL.md are two files already; 199 more make 201.
        for (int i = 0; i < 199; i++) {
            Files.writeString(extra.resolve("f" + i + ".md"), "x");
        }
        Path ws = Files.createDirectories(tmp.resolve("ws"));

        assertEquals(List.of("contents"), paths(PlaybookLoader.load(dir, ws, config()).findings()));
    }

    @Test
    void aFolderOfExactlyTwoHundredFilesLoads() throws IOException {
        Path dir = playbook("pb", MINIMAL);
        Path extra = Files.createDirectories(dir.resolve("extra"));
        for (int i = 0; i < 198; i++) {
            Files.writeString(extra.resolve("f" + i + ".md"), "x");
        }
        Path ws = Files.createDirectories(tmp.resolve("ws"));

        assertEquals(List.of(), PlaybookLoader.load(dir, ws, config()).findings());
    }

    @Test
    void aPlaybookFileLargerThanOneMegabyteIsRefusedUnread() throws IOException {
        String padded = MINIMAL.replace("\"description\": \"d\"",
                "\"description\": \"" + "d".repeat(1024 * 1024) + "\"");
        Path dir = playbook("pb", padded);
        Path ws = Files.createDirectories(tmp.resolve("ws"));

        PlaybookLoader.Loaded loaded = PlaybookLoader.load(dir, ws, config());

        assertEquals(List.of("playbook.json"), paths(loaded.findings()));
        assertNull(loaded.playbook());
        assertNull(loaded.topology());
        assertEquals(List.of(), loaded.steps());
    }

    @Test
    void aFileCarryingBaseUrlIsRefusedWithItsPathAndNothingIsDrawn() throws IOException {
        Path dir = playbook("pb", MINIMAL.replace("\"model\": \"fast\"",
                "\"model\": \"fast\", \"baseUrl\": \"http://10.0.0.5:8080\""));
        Path ws = Files.createDirectories(tmp.resolve("ws"));

        PlaybookLoader.Loaded loaded = PlaybookLoader.load(dir, ws, config());

        assertTrue(paths(loaded.findings()).contains("nodes[0].baseUrl"), loaded.findings().toString());
        assertNull(loaded.playbook());
        assertNull(loaded.topology());
        assertEquals(List.of(), loaded.steps());
    }
}
