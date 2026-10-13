package dev.spectroscope.core.playbook.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 586: the lines of one run, the entry count of each node, and the cut of long texts. */
class RunStepsTest {

    /** The mapper SessionStore writes a line with. */
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void entriesCountPerNode() {
        RunSteps lines = new RunSteps("abcdefabcdef", "playbook");
        assertEquals(1, lines.enter("fix"));
        assertEquals(1, lines.enter("review"));
        assertEquals(2, lines.enter("fix"));
    }

    @Test
    void enteringOneNodeFromManyThreadsLosesNoEntry() throws Exception {
        RunSteps lines = new RunSteps("abcdefabcdef", "workflow");
        int threads = 8;
        int each = 20_000;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            CountDownLatch go = new CountDownLatch(1);
            List<Future<Object>> runs = new ArrayList<>();
            for (int t = 0; t < threads; t++) {
                runs.add(pool.submit(() -> {
                    go.await();
                    for (int i = 0; i < each; i++) {
                        lines.enter("review");
                    }
                    return null;
                }));
            }
            go.countDown();
            for (Future<Object> run : runs) {
                run.get(30, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }
        assertEquals(threads * each + 1, lines.enter("review"), "no entry is lost when steps run in parallel");
    }

    @Test
    void aRunStartLineCarriesEveryFieldOfItsPhase(@TempDir Path folder) throws Exception {
        long before = System.currentTimeMillis();
        RunEvent.RunStep line = new RunSteps("abcdefabcdef", "workflow").runStart("Fix the bug",
                "make the failing test pass",
                List.of(new RunEvent.RunNode("plan", "Plan", "step"), new RunEvent.RunNode("gate", "Gate", "decision")),
                folder);
        assertTree("""
                {"type": "run_step", "agentId": "playbook", "runId": "abcdefabcdef", "runKind": "workflow",
                 "phase": "run_start", "name": "Fix the bug", "task": "make the failing test pass",
                 "nodes": [{"id": "plan", "name": "Plan", "kind": "step"},
                           {"id": "gate", "name": "Gate", "kind": "decision"}],
                 "workspaceFingerprint": "%s"}
                """.formatted(RunEvent.RunStep.fingerprintOf(folder.toRealPath())), line, before);
    }

    @Test
    void aRunStartWithoutAFolderOrWithAGoneOneCarriesNoFingerprint(@TempDir Path tmp) {
        RunSteps lines = new RunSteps("abcdefabcdef", "playbook");
        assertNull(lines.runStart("Fix the bug", null, List.of(), null).workspaceFingerprint());
        assertNull(lines.runStart("Fix the bug", null, List.of(), tmp.resolve("gone")).workspaceFingerprint());
        assertNotNull(lines.runStart("Fix the bug", null, List.of(), tmp).workspaceFingerprint(),
                "positive: a folder that is there is fingerprinted");
    }

    @Test
    void aStepStartLineCarriesEveryFieldOfItsPhase() throws Exception {
        long before = System.currentTimeMillis();
        RunEvent.RunStep line = new RunSteps("abcdefabcdef", "workflow").stepStart("write_plan", "Write the plan",
                "step", 2, new RunSteps.Start("child", "worker", "ollama", "qwen2.5:7b", true, "draft the plan",
                        List.of(new RunEvent.RunDoc("brief", "docs/brief.md", null)), 3, 5));
        assertTree("""
                {"type": "run_step", "agentId": "playbook", "runId": "abcdefabcdef", "runKind": "workflow",
                 "phase": "step_start", "name": "Write the plan", "node": "write_plan", "kind": "step", "entry": 2,
                 "performer": "child", "role": "worker", "provider": "ollama", "model": "qwen2.5:7b", "picked": true,
                 "input": "draft the plan", "inputChars": 14, "reads": [{"doc": "brief", "path": "docs/brief.md"}],
                 "round": 3, "maxRounds": 5}
                """, line, before);
    }

    @Test
    void aStepEndLineCarriesEveryFieldOfItsPhase() throws Exception {
        long before = System.currentTimeMillis();
        RunEvent.RunStep line = new RunSteps("abcdefabcdef", "workflow").stepEnd("review", "Review", "decision", 3,
                new RunSteps.End(RunSteps.FAILED, 1234L, "explore-7", List.of("explore-1", "explore-2"),
                        "two findings", List.of(new RunEvent.RunDoc("plan", "docs/plan.md", "changed")), "fail",
                        "the check timed out", 1, 4));
        assertTree("""
                {"type": "run_step", "agentId": "playbook", "runId": "abcdefabcdef", "runKind": "workflow",
                 "phase": "step_end", "name": "Review", "node": "review", "kind": "decision", "entry": 3,
                 "round": 1, "maxRounds": 4, "status": "failed", "durationMs": 1234, "childId": "explore-7",
                 "children": ["explore-1", "explore-2"], "output": "two findings", "outputChars": 12,
                 "documents": [{"doc": "plan", "path": "docs/plan.md", "change": "changed"}],
                 "label": "fail", "error": "the check timed out"}
                """, line, before);
    }

    @Test
    void aRunEndLineCarriesEveryFieldOfItsPhase() throws Exception {
        long before = System.currentTimeMillis();
        RunEvent.RunStep line = new RunSteps("abcdefabcdef", "workflow").runEnd("end", "done",
                "the run reached its end node", 98_765L);
        assertTree("""
                {"type": "run_step", "agentId": "playbook", "runId": "abcdefabcdef", "runKind": "workflow",
                 "phase": "run_end", "durationMs": 98765, "stopReason": "end", "result": "done",
                 "detail": "the run reached its end node"}
                """, line, before);
    }

    @Test
    void aRunStartCopiesItsPathAndKeepsAnEmptyOne() throws Exception {
        RunSteps lines = new RunSteps("abcdefabcdef", "playbook");
        List<RunEvent.RunNode> path = new ArrayList<>(List.of(new RunEvent.RunNode("plan", "Plan", "step")));
        RunEvent.RunStep start = lines.runStart("Fix the bug", null, path, null);
        path.add(new RunEvent.RunNode("late", "Late", "step"));
        assertEquals(List.of(new RunEvent.RunNode("plan", "Plan", "step")), start.nodes(),
                "a node added to the caller's list after the line is built stays off the line");
        RunEvent.RunStep empty = lines.runStart("Fix the bug", null, List.of(), null);
        assertEquals("[]", JSON.readTree(JSON.writeValueAsString(empty)).get("nodes").toString(),
                "an empty path stays on the wire as []");
    }

    @Test
    void aLongInputIsCutWithItsLengthBeside() {
        RunSteps lines = new RunSteps("abcdefabcdef", "playbook");
        String big = "x".repeat(RunSteps.TEXT_CAP + 10);
        RunEvent.RunStep start = lines.stepStart("w", "Write", "step", 1,
                new RunSteps.Start("chat", null, "anthropic", "claude-opus-5-5", false, big, List.of(), null, null));
        assertEquals(RunSteps.TEXT_CAP, start.input().length());
        assertEquals(RunSteps.TEXT_CAP + 10, start.inputChars());
        assertEquals("step_start", start.phase());
        assertEquals("playbook", start.agentId());
        assertNull(start.picked(), "an unpicked model leaves the flag off");
    }

    @Test
    void aTextOfExactlyTheCapStaysWholeWithItsLengthBeside() {
        RunEvent.RunStep start = startWith("x".repeat(RunSteps.TEXT_CAP));
        assertEquals("x".repeat(RunSteps.TEXT_CAP), start.input());
        assertEquals(RunSteps.TEXT_CAP, start.inputChars());
    }

    @Test
    void aTextOneOverTheCapIsCut() {
        RunEvent.RunStep start = startWith("x".repeat(RunSteps.TEXT_CAP + 1));
        assertEquals("x".repeat(RunSteps.TEXT_CAP), start.input());
        assertEquals(RunSteps.TEXT_CAP + 1, start.inputChars());
    }

    @Test
    void aNullInputLeavesTheTextAndItsLengthOff() {
        RunEvent.RunStep start = startWith(null);
        assertNull(start.input());
        assertNull(start.inputChars());
        assertEquals("w", start.node(), "positive: the line itself is built");
    }

    @Test
    void anEndCarriesStatusDocumentsAndCutOutput() {
        RunSteps lines = new RunSteps("abcdefabcdef", "workflow");
        String output = "o".repeat(RunSteps.TEXT_CAP + 10);
        String error = "e".repeat(RunSteps.TEXT_CAP + 10);
        RunEvent.RunStep end = lines.stepEnd("review", "Review", "fanout", 1,
                new RunSteps.End(RunSteps.DONE, 40L, null, List.of("explore-1", "explore-2"), output,
                        List.of(), null, error, null, null));
        assertEquals("done", end.status());
        assertEquals(List.of("explore-1", "explore-2"), end.children());
        assertEquals("o".repeat(RunSteps.TEXT_CAP), end.output(), "the output is cut at the cap");
        assertEquals(RunSteps.TEXT_CAP + 10, end.outputChars(), "the output's full length rides beside the cut");
        assertEquals("e".repeat(RunSteps.TEXT_CAP), end.error(), "the error is cut at the cap");
        assertEquals("workflow", end.runKind());
        assertNull(end.documents(), "an empty document list stays off the wire");
    }

    @Test
    void aRunEndCutsALongDetail() {
        String detail = "d".repeat(RunSteps.TEXT_CAP + 10);
        RunEvent.RunStep end = new RunSteps("abcdefabcdef", "playbook").runEnd("step_failed", null, detail, 5L);
        assertEquals("d".repeat(RunSteps.TEXT_CAP), end.detail());
        assertEquals("step_failed", end.stopReason(), "positive: the line itself is built");
    }

    @Test
    void aCutNeverEndsInHalfASurrogatePair() {
        // A lone high surrogate cannot be encoded as UTF-8, so SessionStore.append would refuse the line.
        RunSteps lines = new RunSteps("abcdefabcdef", "playbook");
        String text = "x".repeat(RunSteps.TEXT_CAP - 1) + Character.toString(0x1F600) + "tail";
        assertTrue(Character.isHighSurrogate(text.charAt(RunSteps.TEXT_CAP - 1)), "the high surrogate sits at the cap");
        RunEvent.RunStep start = lines.stepStart("w", "Write", "step", 1,
                new RunSteps.Start("chat", null, "anthropic", "claude-opus-5-5", false, text, List.of(), null, null));
        assertEquals(RunSteps.TEXT_CAP - 1, start.input().length(), "the emoji is left out whole");
        assertFalse(Character.isHighSurrogate(start.input().charAt(start.input().length() - 1)),
                "the cut never ends in half of a surrogate pair");
        assertEquals(text.length(), start.inputChars(), "the full length rides beside the cut");
    }

    @Test
    void cutKeepsNullAndShortTexts() {
        assertNull(RunSteps.cut(null));
        assertEquals("ok", RunSteps.cut("ok"));
        assertEquals(RunSteps.TEXT_CAP, RunSteps.cut("y".repeat(5000)).length());
    }

    private static RunEvent.RunStep startWith(String input) {
        return new RunSteps("abcdefabcdef", "playbook").stepStart("w", "Write", "step", 1,
                new RunSteps.Start("chat", null, "anthropic", "claude-opus-5-5", false, input, List.of(), null, null));
    }

    /**
     * Writes a line the way SessionStore does and compares the whole tree,
     * after checking that {@code ts} is the time the line was built.
     */
    private static void assertTree(String expected, RunEvent.RunStep line, long before) throws Exception {
        ObjectNode tree = (ObjectNode) JSON.readTree(JSON.writeValueAsString(line));
        long ts = tree.remove("ts").asLong();
        assertTrue(ts >= before && ts <= System.currentTimeMillis(), "ts is the time the line was built: " + ts);
        assertEquals(JSON.readTree(expected), tree);
    }
}
