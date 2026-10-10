package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PlaybookRunnerRulesTest {

    @TempDir Path tmp;

    static String privateBuild(String fallbacks) {
        return VocabularyTest.LOOP
                .replace("\"fast\":   { \"primary\": { \"provider\": \"ollama\", \"model\": \"qwen3:8b\" } }",
                        "\"fast\":   { \"primary\": { \"provider\": \"ollama\", \"model\": \"qwen3:8b\" }, \"fallbacks\": " + fallbacks + " }")
                .replace("\"model\": \"fast\", \"consumes\"", "\"model\": \"fast\", \"privacy\": \"private\", \"consumes\"");
    }

    FakeHost host() throws IOException {
        FakeHost h = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        h.onChat.put("write_plan", x -> PlaybookRunnerTest.write(x.workspace.resolve("plan.md"), "# Tasks\nx\n"));
        return h;
    }

    @Test
    void aPrivateStepWhoseModelDoesNotAnswerStopsAndAsksWithoutAFallback() throws IOException {
        FakeHost h = host();
        h.rows.put("ollama", new Probe("ollama", "local", "failed", "http://localhost:11434", "refused", List.of(), false, 2L));
        h.answers.put("Retry or stop", "stop");
        PlaybookRunner.Outcome out = PlaybookRunnerTest.run(tmp,
                privateBuild("[ { \"provider\": \"lmstudio\", \"model\": \"x\" } ]"), h);
        assertEquals(RunStop.MODEL_UNAVAILABLE, out.stopReason());
        assertFalse(h.probed.contains("lmstudio"), "a private step never walks");
        RunEvent.QuestionAsked q = h.events.stream().filter(RunEvent.QuestionAsked.class::isInstance)
                .map(RunEvent.QuestionAsked.class::cast).reduce((a, b) -> b).orElseThrow();
        assertTrue(q.questions().get(0).question().contains("ollama qwen3:8b does not answer at http://localhost:11434 (refused)"));
    }

    @Test
    void aCheapStepWalksToItsFallbackAndRecordsTheWalk() throws IOException {
        FakeHost h = host();
        h.rows.put("ollama", new Probe("ollama", "local", "failed", "http://localhost:11434", "timeout", List.of(), false, 2L));
        String json = privateBuild("[ { \"provider\": \"lmstudio\", \"model\": \"qwen3-8b\" } ]")
                .replace("\"privacy\": \"private\", ", "");
        PlaybookRunner.Outcome out = PlaybookRunnerTest.run(tmp, json, h);
        assertEquals(RunStop.DONE, out.stopReason());
        assertTrue(h.events.stream().anyMatch(e -> e instanceof RunEvent.RunStart s && "lmstudio".equals(s.provider())));
        assertEquals("ollama/qwen3:8b", PlaybookRunnerTest.sidecar(tmp, "step_start").get(1).get("walked").get(0).asText());
    }

    @Test
    void aChatStepAfterAPrivateStepAsksBeforeGoingToTheCloud() throws IOException {
        FakeHost h = host();
        String json = VocabularyTest.LOOP
                .replace("\"performer\": \"chat\", \"model\": \"strong\"", "\"performer\": \"chat\", \"model\": \"fast\", \"privacy\": \"private\"")
                .replace("\"performer\": \"child\", \"role\": \"worker\", \"model\": \"fast\"", "\"performer\": \"chat\", \"model\": \"strong\"");
        h.answers.put("Continue?", "stop");
        PlaybookRunner.Outcome out = PlaybookRunnerTest.run(tmp, json, h);
        assertEquals(RunStop.PRIVACY_DECLINED, out.stopReason());
        assertFalse(h.switches.contains("anthropic/claude-opus-5-5"), "the switch never happened");
        assertEquals("stop", PlaybookRunnerTest.sidecar(tmp, "privacy").get(0).get("answer").asText());
    }

    @Test
    void aStepSetsItsPermissionFloorAndClearsIt() throws IOException {
        FakeHost h = host();
        String json = VocabularyTest.LOOP.replace("\"model\": \"fast\", \"consumes\"", "\"model\": \"fast\", \"permission\": \"readonly\", \"consumes\"");
        PlaybookRunnerTest.run(tmp, json, h);
        int at = h.floors.indexOf("readonly");
        assertTrue(at >= 0, h.floors.toString());
        assertEquals("null", h.floors.get(at + 1), "the floor clears when the step ends");
        assertEquals("readonly", PlaybookRunnerTest.sidecar(tmp, "step_start").get(1).get("permission").asText());
    }

    @Test
    void aRefusedNodEndsTheRun() throws IOException {
        FakeHost h = host();
        String json = VocabularyTest.LOOP.replace("\"produces\": [\"plan\"] }", "\"produces\": [\"plan\"], \"nod\": true }");
        h.answers.put("Approve the handover", "stop");
        assertEquals(RunStop.NOD_REFUSED, PlaybookRunnerTest.run(tmp, json, h).stopReason());
    }

    @Test
    void nobodyToAskRefusesAPlaybookWithANodBeforeAnythingRuns() throws IOException {
        FakeHost h = host();
        h.nobodyToAsk = true;
        String json = VocabularyTest.LOOP.replace("\"produces\": [\"plan\"] }", "\"produces\": [\"plan\"], \"nod\": true }");
        PlaybookRunner.Outcome out = PlaybookRunnerTest.run(tmp, json, h);
        assertEquals(RunStop.REFUSED, out.stopReason());
        assertEquals(List.of(), h.chatTurns);
        assertTrue(out.detail().contains("nobody can approve"), out.detail());
    }

    @Test
    void stopEndsTheRunAndTheGraphFileStillEnds() throws IOException {
        FakeHost h = host();
        h.onChat.put("write_plan", x -> x.signal.cancel());
        PlaybookRunner.Outcome out = PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, h);
        assertEquals(RunStop.ABORTED, out.stopReason());
        List<com.fasterxml.jackson.databind.JsonNode> g = PlaybookRunnerTest.graph(tmp);
        assertEquals("graph_end", g.get(g.size() - 1).get("type").asText());
        assertEquals(List.of("write_plan"), g.stream().filter(n -> "node_start".equals(n.get("type").asText()))
                .map(n -> n.get("node").asText()).toList(), "no node starts after the step Stop came in");
        assertEquals("aborted", PlaybookRunnerTest.sidecar(tmp, "playbook_end").get(0).get("stopReason").asText());
    }
}
