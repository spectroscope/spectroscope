package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.playbook.ContentHash;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.SafeWalk;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PinnedPlaybookTest {

    static final String BUNDLE = """
        { "schema_version": 1, "id": "b", "name": "Bundle", "description": "d",
          "models": { "fast": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "documents": { "spec": { "name": "Spec", "purpose": "the design", "location": "docs/{slug}-design.md",
                                   "template": "templates/spec.md", "sections": ["Goal", "Design"] } },
          "checks": { "spec_ok": { "kind": "sections", "documents": ["spec"] } },
          "start": "brainstorm",
          "nodes": [
            { "kind": "step", "id": "brainstorm", "name": "Brainstorm", "goal": "Agree the design.",
              "skills": ["spectropowers:brainstorming", "house-rules", "nowhere"], "model": "fast", "produces": ["spec"] },
            { "kind": "decision", "id": "spec_ok", "name": "Spec complete", "check": "spec_ok", "max_rounds": 2 },
            { "kind": "end", "id": "done", "result": "done" }
          ],
          "arrows": [
            { "from": "brainstorm", "to": "spec_ok" },
            { "from": "spec_ok", "to": "done", "on": "pass" },
            { "from": "spec_ok", "to": "brainstorm", "on": "fail" },
            { "from": "spec_ok", "to": "done", "on": "exhausted" }
          ],
          "contents": { "skills": ["skills/spectropowers"] } }
        """;

    static Path bundle(Path dir) throws IOException {
        Files.writeString(dir.resolve("playbook.json"), BUNDLE);
        Files.createDirectories(dir.resolve("templates"));
        Files.writeString(dir.resolve("templates/spec.md"), "# Goal\n\n# Design\n");
        Path skill = Files.createDirectories(dir.resolve("skills/spectropowers/brainstorming"));
        Files.writeString(skill.resolve("SKILL.md"), "Ask one question at a time.");
        return dir;
    }

    static Playbook read() {
        return PlaybookReader.read(BUNDLE).playbook();
    }

    @Test
    void skillsComeFromTheFolderThenTheInstalledSetAndTheRestIsMissing() throws IOException {
        Path dir = bundle(Files.createDirectories(tmp.resolve("pb")));
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, read(), name -> "house-rules".equals(name) ? "Stage explicit paths." : null);
        assertEquals(new SkillBody("spectropowers:brainstorming", "playbook", "Ask one question at a time."),
                pinned.skills().get("spectropowers:brainstorming"));
        assertEquals("installed", pinned.skills().get("house-rules").source());
        assertEquals(List.of("nowhere"), pinned.missingSkills());
        assertEquals("# Goal\n\n# Design\n", pinned.templates().get("spec"));
    }

    @Test
    void theHashIsStableAndMovesWithEveryPinnedByte() throws IOException {
        Path dir = bundle(Files.createDirectories(tmp.resolve("pb")));
        String first = PinnedPlaybook.pin(dir, read(), n -> null).hash();
        assertTrue(first.matches("sha256:[0-9a-f]{64}"), first);
        assertEquals(first, PinnedPlaybook.pin(dir, read(), n -> null).hash());
        Files.writeString(dir.resolve("skills/spectropowers/brainstorming/SKILL.md"), "Ask two questions.");
        assertNotEquals(first, PinnedPlaybook.pin(dir, read(), n -> null).hash());
        TreeMap<String, byte[]> a = new TreeMap<>(Map.of("a", new byte[] {1}, "b", new byte[] {2}));
        assertEquals(PinnedPlaybook.hash(a), PinnedPlaybook.hash(new TreeMap<>(a)));
    }

    @Test
    void thePinHashIsTheContentHashTreeOfTheSameFiles() throws IOException {
        Path dir = bundle(Files.createDirectories(tmp.resolve("pb")));
        String pinned = PinnedPlaybook.pin(dir, read(), n -> null).hash();
        assertEquals("sha256:" + ContentHash.tree(SafeWalk.walk(dir, dir)), pinned);
    }

    @Test
    void theStepPromptKeepsTheRecordShortAndInlinesForTheModel() throws IOException {
        Path dir = bundle(Files.createDirectories(tmp.resolve("pb")));
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, read(), name -> "house-rules".equals(name) ? "Stage explicit paths." : null);
        Playbook.Step step = (Playbook.Step) read().nodes().get(0);
        StepPrompt.Prompt prompt = StepPrompt.of(pinned, step, Map.of());
        assertEquals("""
                Playbook Bundle, step Brainstorm (brainstorm).
                Goal: Agree the design.
                Read: nothing.
                Write: Spec at docs/{slug}-design.md with the sections Goal, Design.
                Done when: Spec complete: Spec has the sections Goal, Design, each with text.""", prompt.record());
        assertTrue(prompt.model().startsWith(prompt.record() + "\n\n## Skill spectropowers:brainstorming\n\nAsk one question at a time."),
                prompt.model());
        assertTrue(prompt.model().contains("## Skill house-rules\n\nStage explicit paths."));
        assertTrue(prompt.model().endsWith("## Template for Spec\n\n# Goal\n\n# Design\n"));
    }

    @TempDir Path tmp;
}
