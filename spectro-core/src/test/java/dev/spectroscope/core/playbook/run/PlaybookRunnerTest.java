package dev.spectroscope.core.playbook.run;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PlaybookRunnerTest {

    @TempDir Path tmp;

    static PlaybookRunner.Outcome run(Path tmp, String json, FakeHost host) throws IOException {
        Path dir = Files.createDirectories(tmp.resolve("pb"));
        Files.writeString(dir.resolve("playbook.json"), json);
        Playbook p = PlaybookReader.read(json).playbook();
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, p, name -> null);
        PlaybookRecorder recorder = new PlaybookRecorder(tmp.resolve("s1.playbook.jsonl"), PlaybookRecorder.DEFAULT_CEILING_BYTES);
        PlaybookRunner.Setup setup = new PlaybookRunner.Setup(pinned, "abcdefabcdef",
                tmp.resolve("s1.abcdefabcdef.graph.jsonl"), recorder, host.signal, "auto");
        return new PlaybookRunner(setup, host, StepChildOnGraphTest.manager(
                new StepChildOnGraphTest.OneTurn("chat", "unused")), line -> Optional.empty()).run();
    }

    static List<JsonNode> sidecar(Path tmp, String type) throws IOException {
        return PlaybookRecorderTest.lines(tmp.resolve("s1.playbook.jsonl")).stream()
                .filter(n -> type.equals(n.get("type").asText())).toList();
    }

    static List<JsonNode> graph(Path tmp) throws IOException {
        return PlaybookRecorderTest.lines(tmp.resolve("s1.abcdefabcdef.graph.jsonl"));
    }

    @Test
    void aChatStepThenAChildStepRunOnTheirModelsAndTheGraphLightsUp() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> write(h.workspace.resolve("plan.md"), "# Tasks\nx\n"));
        PlaybookRunner.Outcome out = run(tmp, VocabularyTest.LOOP, host);

        assertEquals(RunStop.DONE, out.stopReason());
        assertEquals("done", out.result());
        assertEquals(List.of("write_plan@anthropic"), host.chatTurns, "the chat was switched before the step");
        assertEquals("lmstudio", host.chat.provider(), "the chat model is back where it was");
        assertTrue(host.events.stream().anyMatch(e -> e instanceof RunEvent.RunStart s
                && s.agentId().startsWith("worker-") && "ollama".equals(s.provider()) && "qwen3:8b".equals(s.model())));

        List<String> started = graph(tmp).stream().filter(n -> "node_start".equals(n.get("type").asText()))
                .map(n -> n.get("node").asText()).toList();
        assertEquals(List.of("write_plan", "plan_ok", "build"), started);
        assertEquals("graph_end", graph(tmp).get(graph(tmp).size() - 1).get("type").asText());

        List<JsonNode> steps = sidecar(tmp, "step_start");
        assertEquals("anthropic", steps.get(0).get("provider").asText());
        assertEquals("ollama", steps.get(1).get("provider").asText());
        assertEquals("pass", sidecar(tmp, "check").get(0).get("label").asText());
        assertEquals("done", sidecar(tmp, "playbook_end").get(0).get("stopReason").asText());

        RunEvent.Plan last = host.events.stream().filter(RunEvent.Plan.class::isInstance).map(RunEvent.Plan.class::cast)
                .reduce((a, b) -> b).orElseThrow();
        assertEquals("playbook", last.agentId());
        assertEquals(List.of("[write_plan] Write plan", "[plan_ok] Plan ok", "[build] Build"),
                last.steps().stream().map(RunEvent.PlanStep::text).toList());
        assertTrue(last.steps().stream().allMatch(s -> "completed".equals(s.status())));
    }

    @Test
    void aLoopEndsAtItsCeilingWithExhausted() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        PlaybookRunner.Outcome out = run(tmp, VocabularyTest.LOOP, host);

        assertEquals(RunStop.DONE, out.stopReason());
        assertEquals("gave_up", out.result());
        assertEquals(3, host.chatTurns.size(), "the step before the decision runs three times at max_rounds 2");
        List<JsonNode> checks = sidecar(tmp, "check");
        assertEquals(List.of("fail", "fail", "exhausted"), checks.stream().map(n -> n.get("label").asText()).toList());
        assertEquals(List.of(1, 2, 2), checks.stream().map(n -> n.get("loops").asInt()).toList());
    }

    /**
     * An inner loop inside an outer one, the shape of the spectro playbook: a task
     * is reviewed, a failed review sends it to a fix, a passed one goes on to the
     * question whether tasks are left, and that question sends the run back to the
     * next task. Both decisions are human checks, so the answers script the run.
     */
    static String nested(int innerRounds, int outerRounds) {
        return """
            { "schema_version": 1, "id": "n", "name": "N", "description": "d",
              "models": { "strong": { "primary": { "provider": "anthropic", "model": "claude-opus-5-5" } } },
              "checks": { "review_q": { "kind": "human", "ask": "Is the task right?", "labels": ["pass", "fail"] },
                          "left_q":   { "kind": "human", "ask": "Are tasks left?", "labels": ["more", "none"] } },
              "start": "task",
              "nodes": [
                { "kind": "step", "id": "task", "name": "Task", "performer": "chat", "model": "strong" },
                { "kind": "decision", "id": "review", "name": "Review", "check": "review_q", "max_rounds": %d },
                { "kind": "step", "id": "fix", "name": "Fix", "performer": "chat", "model": "strong" },
                { "kind": "decision", "id": "left", "name": "Left", "check": "left_q", "max_rounds": %d },
                { "kind": "end", "id": "done", "result": "done" },
                { "kind": "end", "id": "gave_up", "result": "gave_up" },
                { "kind": "end", "id": "too_many", "result": "too_many" }
              ],
              "arrows": [
                { "from": "task", "to": "review" },
                { "from": "review", "to": "left", "on": "pass" },
                { "from": "review", "to": "fix", "on": "fail" },
                { "from": "review", "to": "gave_up", "on": "exhausted" },
                { "from": "fix", "to": "review" },
                { "from": "left", "to": "task", "on": "more" },
                { "from": "left", "to": "done", "on": "none" },
                { "from": "left", "to": "too_many", "on": "exhausted" }
              ] }
            """.formatted(innerRounds, outerRounds);
    }

    static PlaybookRunner.Outcome nestedRun(Path tmp, int innerRounds, int outerRounds, String... answers)
            throws IOException {
        String json = nested(innerRounds, outerRounds);
        assertEquals(List.of(), PlaybookReader.read(json).findings());
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.answerQueue.addAll(List.of(answers));
        return run(tmp, json, host);
    }

    static List<String> checks(Path tmp, String node, String field) throws IOException {
        return sidecar(tmp, "check").stream().filter(n -> node.equals(n.get("node").asText()))
                .map(n -> n.get(field).asText()).toList();
    }

    @Test
    void theInnerDecisionCountsAgainFromZeroForTheNextTask() throws IOException {
        PlaybookRunner.Outcome out = nestedRun(tmp, 2, 3,
                "fail", "fail", "pass", "more",
                "fail", "fail", "pass", "none");

        assertEquals(RunStop.DONE, out.stopReason(), out.detail());
        assertEquals("done", out.result(), "two tasks of two failed reviews each fit a limit of 2 per task");
        assertEquals(List.of("fail", "fail", "pass", "fail", "fail", "pass"), checks(tmp, "review", "label"));
        assertEquals(List.of("1", "2", "2", "1", "2", "2"), checks(tmp, "review", "loops"),
                "the second task's reviews start at zero again");
    }

    @Test
    void threeFailedRoundsThenAPassLeaveTheNextTaskAFreshCount() throws IOException {
        PlaybookRunner.Outcome out = nestedRun(tmp, 3, 3,
                "fail", "fail", "fail", "pass", "more",
                "fail", "pass", "none");

        assertEquals("done", out.result(), out.detail());
        assertEquals(List.of("1", "2", "3", "3", "1", "1"), checks(tmp, "review", "loops"));
    }

    @Test
    void theInnerDecisionStillRunsOutWithinOneTask() throws IOException {
        PlaybookRunner.Outcome out = nestedRun(tmp, 2, 3,
                "fail", "pass", "more",
                "fail", "fail", "fail");

        assertEquals(RunStop.DONE, out.stopReason(), out.detail());
        assertEquals("gave_up", out.result());
        assertEquals(List.of("fail", "pass", "fail", "fail", "exhausted"), checks(tmp, "review", "label"),
                "the second task gets two fix rounds, and the third failed review is the limit");
        assertEquals(List.of("1", "1", "1", "2", "2"), checks(tmp, "review", "loops"));
    }

    @Test
    void aPassNeverCountsAsARound() throws IOException {
        PlaybookRunner.Outcome out = nestedRun(tmp, 2, 3,
                "pass", "more", "pass", "more", "pass", "none");

        assertEquals("done", out.result(), out.detail());
        assertEquals(List.of("pass", "pass", "pass"), checks(tmp, "review", "label"));
        assertEquals(List.of("0", "0", "0"), checks(tmp, "review", "loops"));
    }

    @Test
    void theOuterDecisionKeepsItsCountWhileTheInnerOneStartsAgain() throws IOException {
        PlaybookRunner.Outcome out = nestedRun(tmp, 2, 2,
                "fail", "pass", "more",
                "fail", "pass", "more",
                "fail", "pass", "more");

        assertEquals("too_many", out.result(), out.detail());
        assertEquals(List.of("more", "more", "exhausted"), checks(tmp, "left", "label"));
        assertEquals(List.of("1", "2", "2"), checks(tmp, "left", "loops"));
        assertEquals(List.of("1", "1", "1", "1", "1", "1"), checks(tmp, "review", "loops"));
    }

    static final String PRIVATE_REVIEW = """
        { "schema_version": 1, "id": "r", "name": "R", "description": "d",
          "models": { "strong": { "primary": { "provider": "anthropic", "model": "claude-opus-5-5" } },
                      "fast":   { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "documents": { "code": { "name": "Code", "purpose": "p", "location": "code.md" } },
          "checks": { "review_ok": { "kind": "review", "model": "strong", "reads": ["code"], "ask": "Is it right?" } },
          "start": "implement",
          "nodes": [
            { "kind": "step", "id": "implement", "name": "Implement", "performer": "child", "role": "worker",
              "model": "fast", "privacy": "private", "produces": ["code"] },
            { "kind": "decision", "id": "review", "name": "Review", "check": "review_ok" },
            { "kind": "end", "id": "done", "result": "done" },
            { "kind": "end", "id": "redo", "result": "redo" }
          ],
          "arrows": [
            { "from": "implement", "to": "review" },
            { "from": "review", "to": "done", "on": "pass" },
            { "from": "review", "to": "redo", "on": "fail" }
          ] }
        """;

    @Test
    void aReviewerOfAPrivateStepsDocumentNeverRunsOnTheCloud() throws IOException {
        assertEquals(List.of(), PlaybookReader.read(PRIVATE_REVIEW).findings());
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        PlaybookRunner.Outcome out = run(tmp, PRIVATE_REVIEW, host);

        assertEquals(RunStop.MODEL_UNAVAILABLE, out.stopReason(), out.detail());
        assertTrue(out.detail().contains("private step"), out.detail());
        assertTrue(host.events.stream().noneMatch(e -> e instanceof RunEvent.RunStart s
                && "anthropic".equals(s.provider())), "no reviewing child ran on the cloud provider");
        assertTrue(host.events.stream().anyMatch(e -> e instanceof RunEvent.RunStart s
                && "ollama".equals(s.provider())), "the private step itself ran on its local model");
    }

    static void write(Path file, String text) {
        try {
            Files.writeString(file, text);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
