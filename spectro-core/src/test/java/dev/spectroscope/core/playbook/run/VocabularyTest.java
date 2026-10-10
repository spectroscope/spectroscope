package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class VocabularyTest {

    static final String LOOP = """
        { "schema_version": 1, "id": "t", "name": "T", "description": "d",
          "models": { "strong": { "primary": { "provider": "anthropic", "model": "claude-opus-5-5" } },
                      "fast":   { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "documents": { "plan": { "name": "Plan", "purpose": "p", "location": "plan.md", "sections": ["Tasks"] } },
          "checks": { "plan_ok": { "kind": "command", "run": "test -f plan.md" } },
          "start": "write_plan",
          "nodes": [
            { "kind": "step", "id": "write_plan", "name": "Write plan", "performer": "chat", "model": "strong", "produces": ["plan"] },
            { "kind": "decision", "id": "plan_ok", "name": "Plan ok", "check": "plan_ok", "max_rounds": 2 },
            { "kind": "step", "id": "build", "name": "Build", "performer": "child", "role": "worker", "model": "fast", "consumes": ["plan"] },
            { "kind": "end", "id": "done", "result": "done" },
            { "kind": "end", "id": "gave_up", "result": "gave_up" }
          ],
          "arrows": [
            { "from": "write_plan", "to": "plan_ok" },
            { "from": "plan_ok", "to": "build", "on": "pass" },
            { "from": "plan_ok", "to": "write_plan", "on": "fail" },
            { "from": "plan_ok", "to": "gave_up", "on": "exhausted" },
            { "from": "build", "to": "done" }
          ] }
        """;

    static Playbook loop() {
        PlaybookReader.Read read = PlaybookReader.read(LOOP);
        assertEquals(List.of(), read.findings());
        return read.playbook();
    }

    @Test
    void theStricterOfSessionAndStepWins() {
        assertEquals("ask", Permissions.effective("auto", "ask"));
        assertEquals("ask", Permissions.effective("ask", "auto"));
        assertEquals("readonly", Permissions.effective("extended", "readonly"));
        assertEquals("auto", Permissions.effective("auto", "inherit"));
        assertEquals("auto", Permissions.effective("auto", null));
        assertEquals("ask", Permissions.effective("bogus", "auto"), "an unknown session mode reads as ask");
    }

    @Test
    void aStepNeverWidensTheSession() {
        for (String session : List.of("readonly", "ask", "auto", "extended")) {
            for (String step : List.of("inherit", "readonly", "ask", "auto")) {
                assertTrue(Permissions.rank(Permissions.effective(session, step)) <= Permissions.rank(session),
                        session + " with " + step);
            }
        }
        assertThrows(IllegalArgumentException.class, () -> Permissions.effective("auto", "extended"));
    }

    @Test
    void aProbeServesOnlyWhatItAnswersFor() {
        Probe reachable = new Probe("ollama", "local", "reachable", "http://localhost:11434", null, List.of("qwen3:8b"), true, 1L);
        assertTrue(reachable.serves("qwen3:8b"));
        assertFalse(reachable.serves("llama4"), "a live list that lacks the model does not serve it");
        Probe curated = new Probe("anthropic", "cloud", "reachable", null, null, List.of(), false, 1L);
        assertTrue(curated.serves("claude-opus-5-5"), "a curated list says nothing about the model");
        Probe builtin = new Probe("spectro-local", "builtin", "configured", null, null, List.of(), false, 0L);
        assertTrue(builtin.answers(), "the built in runtime is never dialled and counts as answering when configured");
        Probe failed = new Probe("ollama", "local", "failed", "http://localhost:11434", "refused", List.of(), false, 1L);
        assertFalse(failed.answers());
    }

    @Test
    void theWalkFollowsArrowsInFileOrderAndKnowsTheLoops() {
        Playbook p = loop();
        assertEquals(List.of("write_plan", "plan_ok", "build"), PlaybookWalk.forwardPath(p));
        assertEquals(Set.of("done", "gave_up"), PlaybookWalk.endIds(p));
        assertTrue(PlaybookWalk.canReach(p, "write_plan", "plan_ok"));
        assertFalse(PlaybookWalk.canReach(p, "build", "plan_ok"));
        assertFalse(PlaybookWalk.canReach(p, "gave_up", "plan_ok"));
        assertEquals("write_plan", PlaybookWalk.arrowFrom(p, "plan_ok", "fail").to());
        assertEquals("plan_ok", PlaybookWalk.arrowFrom(p, "write_plan", null).to());
        assertEquals(3, PlaybookWalk.arrowsFrom(p, "plan_ok").size());
    }
}
