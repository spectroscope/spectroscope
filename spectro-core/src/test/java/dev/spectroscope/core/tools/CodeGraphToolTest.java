package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 547: the read-only {@code code_graph} tool that asks graphify about
 * the session folder's code graph.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CodeGraphToolTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String BIN = "/opt/tools/graphify";

    /** Records every argument vector and answers with a fixed outcome. */
    private static final class Recording implements CodeGraphTool.Runner {
        final List<List<String>> calls = new ArrayList<>();
        final List<Path> workdirs = new ArrayList<>();
        CodeGraphTool.Outcome outcome = new CodeGraphTool.Outcome("answer from graphify", 0, false, false, false);

        @Override
        public CodeGraphTool.Outcome run(List<String> argv, Path workdir, CancelSignal signal) {
            calls.add(List.copyOf(argv));
            workdirs.add(workdir);
            return outcome;
        }
    }

    private static Path withGraph(Path root) throws IOException {
        Files.createDirectories(root.resolve("graphify-out"));
        Files.writeString(root.resolve("graphify-out/graph.json"), "{\"nodes\":[],\"links\":[]}");
        return root;
    }

    private static String graphOf(Path root) throws IOException {
        return root.toRealPath().resolve("graphify-out").resolve("graph.json").toString();
    }

    private static CodeGraphTool tool(Recording runner) {
        return new CodeGraphTool(() -> Optional.of(BIN), runner);
    }

    private static String call(CodeGraphTool tool, Path cwd, ObjectNode input) {
        return tool.execute(input, new Tool.ToolContext(cwd, new CancelSignal()));
    }

    private static ObjectNode input(String action) {
        return JSON.createObjectNode().put("action", action);
    }

    // ---- the tool's identity -------------------------------------------------

    @Test
    void theToolIsCalledCodeGraphAndNeedsNoPermission() {
        CodeGraphTool tool = tool(new Recording());
        assertEquals("code_graph", tool.name());
        assertFalse(tool.needsPermission(), "a read-only tool passes no gate");
    }

    @Test
    void theSchemaNamesTheFiveActions() {
        String schema = tool(new Recording()).inputSchema().toString();
        for (String action : List.of("query", "path", "explain", "affected", "god_nodes")) {
            assertTrue(schema.contains("\"" + action + "\""), "schema lacks " + action + ": " + schema);
        }
    }

    // ---- argv per action, always the folder's own graph -----------------------

    @Test
    void queryRunsTheQuestionWithItsFlagsAndTheFoldersGraph(@TempDir Path root) throws IOException {
        withGraph(root);
        Recording runner = new Recording();
        String out = call(tool(runner), root, input("query").put("question", "who calls Foo")
                .put("dfs", true).put("budget", 3000));
        assertEquals("answer from graphify", out);
        assertEquals(List.of(List.of(BIN, "query", "who calls Foo", "--dfs", "--budget", "3000",
                "--graph", graphOf(root))), runner.calls);
        assertEquals(root.toRealPath(), runner.workdirs.get(0));
    }

    @Test
    void queryWithoutFlagsPassesOnlyTheQuestionAndTheGraph(@TempDir Path root) throws IOException {
        withGraph(root);
        Recording runner = new Recording();
        call(tool(runner), root, input("query").put("question", "how does compaction work"));
        assertEquals(List.of(BIN, "query", "how does compaction work", "--graph", graphOf(root)),
                runner.calls.get(0));
    }

    @Test
    void pathRunsTheTwoNames(@TempDir Path root) throws IOException {
        withGraph(root);
        Recording runner = new Recording();
        call(tool(runner), root, input("path").put("from", "Agent").put("to", "ToolRegistry"));
        assertEquals(List.of(BIN, "path", "Agent", "ToolRegistry", "--graph", graphOf(root)),
                runner.calls.get(0));
    }

    @Test
    void explainRunsTheName(@TempDir Path root) throws IOException {
        withGraph(root);
        Recording runner = new Recording();
        call(tool(runner), root, input("explain").put("name", "CodeGraphJobs"));
        assertEquals(List.of(BIN, "explain", "CodeGraphJobs", "--graph", graphOf(root)),
                runner.calls.get(0));
    }

    @Test
    void affectedRunsTheNameAndItsDepth(@TempDir Path root) throws IOException {
        withGraph(root);
        Recording runner = new Recording();
        call(tool(runner), root, input("affected").put("name", "CodeGraphJobs"));
        call(tool(runner), root, input("affected").put("name", "CodeGraphJobs").put("depth", 3));
        assertEquals(List.of(BIN, "affected", "CodeGraphJobs", "--graph", graphOf(root)), runner.calls.get(0));
        assertEquals(List.of(BIN, "affected", "CodeGraphJobs", "--depth", "3", "--graph", graphOf(root)),
                runner.calls.get(1));
    }

    @Test
    void godNodesRunsTheDashedSubcommandWithItsTop(@TempDir Path root) throws IOException {
        withGraph(root);
        Recording runner = new Recording();
        call(tool(runner), root, input("god_nodes"));
        call(tool(runner), root, input("god_nodes").put("top", 5));
        assertEquals(List.of(BIN, "god-nodes", "--graph", graphOf(root)), runner.calls.get(0));
        assertEquals(List.of(BIN, "god-nodes", "--top", "5", "--graph", graphOf(root)), runner.calls.get(1));
    }

    @Test
    void aNumberSentAsDigitsIsParsedAndPassedAsAnInteger(@TempDir Path root) throws IOException {
        withGraph(root);
        Recording runner = new Recording();
        call(tool(runner), root, input("god_nodes").put("top", "07"));
        assertEquals(List.of(BIN, "god-nodes", "--top", "7", "--graph", graphOf(root)), runner.calls.get(0));
    }

    // ---- refusals: tool results, graphify never starts -------------------------

    private static void refused(Path root, ObjectNode input, String because) throws IOException {
        withGraph(root);
        Recording runner = new Recording();
        String out = call(tool(runner), root, input);
        assertTrue(out.startsWith("ERROR: "), "refusal is an error result: " + out);
        assertTrue(out.contains(because), "refusal says " + because + ": " + out);
        assertTrue(runner.calls.isEmpty(), "graphify must not start: " + runner.calls);
    }

    @Test
    void aDashIsNotAName(@TempDir Path root) throws IOException {
        refused(root, input("explain").put("name", "--graph /etc/passwd"), "dash");
    }

    @Test
    void aQuestionThatIsAnOptionIsRefused(@TempDir Path root) throws IOException {
        refused(root, input("query").put("question", "--help"), "dash");
    }

    @Test
    void aShortOptionIsRefusedEvenBehindSpaces(@TempDir Path root) throws IOException {
        refused(root, input("query").put("question", "   -x"), "dash");
    }

    @Test
    void aPathEndThatStartsWithADashIsRefused(@TempDir Path root) throws IOException {
        refused(root, input("path").put("from", "Agent").put("to", "-v"), "dash");
    }

    @Test
    void anUnknownActionIsRefusedWithTheFiveNames(@TempDir Path root) throws IOException {
        refused(root, input("install").put("name", "copilot"), "god_nodes");
    }

    @Test
    void aMissingArgumentIsRefusedByName(@TempDir Path root) throws IOException {
        refused(root, input("path").put("from", "Agent"), "to");
    }

    @Test
    void aBudgetOutOfRangeIsRefused(@TempDir Path root) throws IOException {
        refused(root, input("query").put("question", "q").put("budget", 1_000_000), "budget");
    }

    @Test
    void aDepthThatIsNoIntegerIsRefused(@TempDir Path root) throws IOException {
        refused(root, input("affected").put("name", "X").put("depth", 2.5), "depth");
    }

    @Test
    void aTopGivenAsWordsIsRefused(@TempDir Path root) throws IOException {
        refused(root, input("god_nodes").put("top", "ten; rm -rf /"), "top");
    }

    @Test
    void aQuestionWithANewlineIsRefused(@TempDir Path root) throws IOException {
        refused(root, input("query").put("question", "who calls Foo\nand Bar"), "control character");
    }

    @Test
    void aNameWithAnEscapeCharacterIsRefused(@TempDir Path root) throws IOException {
        refused(root, input("explain").put("name", "Agent\u001b[2J"), "control character");
    }

    @Test
    void aQuestionOfFiveHundredAndOneCharactersIsRefused(@TempDir Path root) throws IOException {
        refused(root, input("query").put("question", "a".repeat(CodeGraphTool.MAX_TEXT_CHARS + 1)),
                "longer than " + CodeGraphTool.MAX_TEXT_CHARS);
    }

    @Test
    void aQuestionOfExactlyTheLimitPasses(@TempDir Path root) throws IOException {
        withGraph(root);
        Recording runner = new Recording();
        String question = "a".repeat(CodeGraphTool.MAX_TEXT_CHARS);
        call(tool(runner), root, input("query").put("question", question));
        assertEquals(List.of(BIN, "query", question, "--graph", graphOf(root)), runner.calls.get(0));
        assertEquals(500, CodeGraphTool.MAX_TEXT_CHARS);
    }

    // ---- the graph stays inside the folder -------------------------------------

    @Test
    void aGraphFolderThatLinksOutOfTheWorkspaceIsRefused(@TempDir Path base) throws IOException {
        Path outside = withGraph(Files.createDirectories(base.resolve("outside")));
        Path root = Files.createDirectories(base.resolve("work"));
        Files.createSymbolicLink(root.resolve("graphify-out"), outside.resolve("graphify-out"));
        Recording runner = new Recording();
        String out = call(tool(runner), root, input("explain").put("name", "Agent"));
        assertTrue(out.startsWith("ERROR: ") && out.contains("outside"), out);
        assertTrue(runner.calls.isEmpty(), "graphify must not start: " + runner.calls);
    }

    @Test
    void aGraphFileThatLinksOutOfTheWorkspaceIsRefused(@TempDir Path base) throws IOException {
        Path outside = withGraph(Files.createDirectories(base.resolve("outside")));
        Path root = Files.createDirectories(base.resolve("work/graphify-out")).getParent();
        Files.createSymbolicLink(root.resolve("graphify-out/graph.json"),
                outside.resolve("graphify-out/graph.json"));
        Recording runner = new Recording();
        String out = call(tool(runner), root, input("god_nodes"));
        assertTrue(out.startsWith("ERROR: ") && out.contains("outside"), out);
        assertTrue(runner.calls.isEmpty(), "graphify must not start: " + runner.calls);
    }

    // ---- presence ----------------------------------------------------------------

    @Test
    void theToolIsOfferedOnlyWithGraphifyAndAGraph(@TempDir Path base) throws IOException {
        Path bare = Files.createDirectories(base.resolve("bare"));
        Path graphed = withGraph(Files.createDirectories(base.resolve("graphed")));
        CodeGraphTool found = tool(new Recording());
        CodeGraphTool missing = new CodeGraphTool(Optional::empty, new Recording());
        assertTrue(found.offeredIn(graphed));
        assertFalse(found.offeredIn(bare), "no graph, no offer");
        assertFalse(missing.offeredIn(graphed), "no graphify, no offer");
        assertFalse(found.offeredIn(null), "no folder, no offer");
    }

    @Test
    void theToolIsNotOfferedWhereTheGraphLinksOutOfTheFolder(@TempDir Path base) throws IOException {
        Path outside = withGraph(Files.createDirectories(base.resolve("outside")));
        Path linkedFolder = Files.createDirectories(base.resolve("linked-folder"));
        Files.createSymbolicLink(linkedFolder.resolve("graphify-out"), outside.resolve("graphify-out"));
        Path linkedFile = Files.createDirectories(base.resolve("linked-file/graphify-out")).getParent();
        Files.createSymbolicLink(linkedFile.resolve("graphify-out/graph.json"),
                outside.resolve("graphify-out/graph.json"));
        CodeGraphTool found = tool(new Recording());
        assertTrue(found.offeredIn(outside), "test premise: the target itself is offered");
        assertFalse(found.offeredIn(linkedFolder), "a graph folder linked out of the folder is no offer");
        assertFalse(found.offeredIn(linkedFile), "a graph file linked out of the folder is no offer");
    }

    @Test
    void aCallWithoutAGraphSaysHowToBuildOne(@TempDir Path root) throws IOException {
        Recording runner = new Recording();
        String out = call(tool(runner), root, input("god_nodes"));
        assertTrue(out.startsWith("ERROR: "), out);
        assertTrue(out.contains("Build code graph") && out.contains("graphify update"), out);
        assertTrue(runner.calls.isEmpty());
    }

    @Test
    void aCallWithoutGraphifySaysSo(@TempDir Path root) throws IOException {
        withGraph(root);
        Recording runner = new Recording();
        String out = call(new CodeGraphTool(Optional::empty, runner), root, input("god_nodes"));
        assertTrue(out.startsWith("ERROR: ") && out.contains("graphify is not on the PATH"), out);
        assertTrue(runner.calls.isEmpty());
    }

    // ---- what the runner reports becomes a tool result ---------------------------

    @Test
    void aTimeoutIsAToolResultThatSaysSo(@TempDir Path root) throws IOException {
        withGraph(root);
        Recording runner = new Recording();
        runner.outcome = new CodeGraphTool.Outcome("partial", -1, true, false, false);
        String out = call(tool(runner), root, input("god_nodes"));
        assertTrue(out.startsWith("ERROR: ") && out.contains("did not answer within "
                + CodeGraphTool.TIMEOUT_SECONDS + " s"), out);
    }

    @Test
    void aCancelIsAToolResultThatSaysCancelledNotTimeout(@TempDir Path root) throws IOException {
        withGraph(root);
        Recording runner = new Recording();
        runner.outcome = new CodeGraphTool.Outcome("", -1, false, false, true);
        String out = call(tool(runner), root, input("god_nodes"));
        assertTrue(out.startsWith("ERROR: ") && out.contains("cancelled"), out);
        assertFalse(out.contains("did not answer within"), "a cancel is not a timeout: " + out);
    }

    @Test
    void aCutOutputSaysWhereItWasCut(@TempDir Path root) throws IOException {
        withGraph(root);
        Recording runner = new Recording();
        runner.outcome = new CodeGraphTool.Outcome("x".repeat(100), 0, false, true, false);
        String out = call(tool(runner), root, input("god_nodes"));
        assertFalse(out.startsWith("ERROR: "), out);
        assertTrue(out.contains("cut at " + CodeGraphTool.MAX_OUTPUT_CHARS + " characters"), out);
    }

    @Test
    void aNonZeroExitIsAnErrorResultWithTheOutput(@TempDir Path root) throws IOException {
        withGraph(root);
        Recording runner = new Recording();
        runner.outcome = new CodeGraphTool.Outcome("Traceback: boom", 2, false, false, false);
        String out = call(tool(runner), root, input("god_nodes"));
        assertTrue(out.startsWith("ERROR: ") && out.contains("exit 2") && out.contains("boom"), out);
    }

    // ---- the real process runner: no shell, a timeout and a cap ------------------

    @Test
    void theProcessRunnerStopsAProcessAtItsTimeout(@TempDir Path dir) {
        CodeGraphTool.Runner runner = CodeGraphTool.processRunner(Duration.ofSeconds(1), 1_000);
        long start = System.nanoTime();
        CodeGraphTool.Outcome outcome = runner.run(List.of("/bin/sleep", "30"), dir, new CancelSignal());
        long millis = (System.nanoTime() - start) / 1_000_000;
        assertTrue(outcome.timedOut(), "timed out: " + outcome);
        assertTrue(millis < 10_000, "stopped near the timeout, took " + millis + " ms");
    }

    @Test
    void theProcessRunnerKeepsTheFirstCharactersUpToItsCap(@TempDir Path dir) throws IOException {
        Path big = dir.resolve("big.txt");
        Files.writeString(big, "y".repeat(50_000));
        CodeGraphTool.Runner runner = CodeGraphTool.processRunner(Duration.ofSeconds(20), 1_000);
        CodeGraphTool.Outcome outcome = runner.run(List.of("/bin/cat", big.toString()), dir, new CancelSignal());
        assertTrue(outcome.truncated(), "cut: " + outcome.truncated());
        assertEquals(1_000, outcome.output().length());
        assertFalse(outcome.timedOut());
    }

    @Test
    void theProcessRunnerPassesAnArgumentAsOneWordWithoutAShell(@TempDir Path dir) {
        CodeGraphTool.Runner runner = CodeGraphTool.processRunner(Duration.ofSeconds(20), 1_000);
        CodeGraphTool.Outcome outcome = runner.run(
                List.of("/bin/echo", "a; echo injected $HOME"), dir, new CancelSignal());
        assertEquals("a; echo injected $HOME", outcome.output().strip());
        assertEquals(0, outcome.exitCode());
    }

    @Test
    void theProcessRunnerStopsAtACancelLongBeforeItsTimeout(@TempDir Path dir) throws Exception {
        CodeGraphTool.Runner runner = CodeGraphTool.processRunner(Duration.ofSeconds(40), 1_000);
        CancelSignal signal = new CancelSignal();
        Thread canceller = Thread.ofVirtual().start(() -> {
            try {
                Thread.sleep(500);
            } catch (InterruptedException ignored) {
                return;
            }
            signal.cancel();
        });
        long start = System.nanoTime();
        CodeGraphTool.Outcome outcome = runner.run(List.of("/bin/sleep", "60"), dir, signal);
        long millis = (System.nanoTime() - start) / 1_000_000;
        canceller.join();
        assertTrue(outcome.cancelled(), "cancelled: " + outcome);
        assertFalse(outcome.timedOut(), "a cancel is not a timeout: " + outcome);
        assertTrue(millis < 10_000, "stopped near the cancel, took " + millis + " ms");
    }

    @Test
    void theProcessRunnerStopsTheChildrenOfAProcessAtItsTimeout(@TempDir Path dir) throws Exception {
        CodeGraphTool.Runner runner = CodeGraphTool.processRunner(Duration.ofSeconds(2), 1_000);
        CodeGraphTool.Outcome outcome = runner.run(
                List.of("/bin/sh", "-c", "/bin/sleep 120 & echo $!; wait"), dir, new CancelSignal());
        assertTrue(outcome.timedOut(), "timed out: " + outcome);
        // The pid is the first line; a shell killed at the timeout may print
        // "Killed: 9" after it (measured once in five runs on 2026-10-12).
        long grandchild = Long.parseLong(outcome.output().strip().lines().findFirst().orElse("").strip());
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        boolean alive = true;
        while (System.nanoTime() < deadline) {
            alive = ProcessHandle.of(grandchild).map(ProcessHandle::isAlive).orElse(false);
            if (!alive) {
                break;
            }
            Thread.sleep(100);
        }
        if (alive) {
            ProcessHandle.of(grandchild).ifPresent(ProcessHandle::destroyForcibly);
        }
        assertFalse(alive, "the background sleep " + grandchild + " outlived the timeout");
    }

    @Test
    void theProcessRunnerClosesStdin(@TempDir Path dir) {
        CodeGraphTool.Runner runner = CodeGraphTool.processRunner(Duration.ofSeconds(5), 1_000);
        CodeGraphTool.Outcome outcome = runner.run(List.of("/bin/cat"), dir, new CancelSignal());
        assertFalse(outcome.timedOut(), "cat must read end of input at once: " + outcome);
        assertEquals(0, outcome.exitCode());
        assertEquals("", outcome.output());
    }

    @Test
    void theProcessRunnerPassesOnlyAReducedEnvironment(@TempDir Path dir) {
        Assumptions.assumeTrue(System.getenv().keySet().stream()
                        .anyMatch(key -> !CodeGraphTool.PASSED_ENVIRONMENT.contains(key)),
                "test premise: the test process has a variable the runner must drop");
        CodeGraphTool.Runner runner = CodeGraphTool.processRunner(Duration.ofSeconds(10), 64_000);
        CodeGraphTool.Outcome outcome = runner.run(List.of("/usr/bin/env"), dir, new CancelSignal());
        assertEquals(0, outcome.exitCode(), outcome.output());
        Map<String, String> seen = new TreeMap<>();
        for (String line : outcome.output().split("\n")) {
            int eq = line.indexOf('=');
            if (eq > 0) {
                seen.put(line.substring(0, eq), line.substring(eq + 1));
            }
        }
        assertEquals(ToolPath.resolve().path(), seen.get("PATH"), "PATH is the tool PATH: " + seen.keySet());
        for (String key : seen.keySet()) {
            assertTrue(CodeGraphTool.PASSED_ENVIRONMENT.contains(key),
                    key + " reached graphify; only " + CodeGraphTool.PASSED_ENVIRONMENT + " may");
        }
        assertEquals(List.of("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"), CodeGraphTool.PASSED_ENVIRONMENT);
    }

    @Test
    void theProcessRunnerSetsThePathItIsGivenNotTheServersOwn(@TempDir Path dir) {
        String marker = "/usr/bin:/bin:" + dir.resolve("marker-bin");
        CodeGraphTool.Runner runner = CodeGraphTool.processRunner(Duration.ofSeconds(10), 64_000, () -> marker);
        CodeGraphTool.Outcome outcome = runner.run(List.of("/usr/bin/env"), dir, new CancelSignal());
        assertEquals(0, outcome.exitCode(), outcome.output());
        assertTrue(outcome.output().lines().anyMatch(line -> line.equals("PATH=" + marker)), outcome.output());
    }

    @Test
    void theCapIsGovernedAndHoldsTheLargestBudget() {
        // A budget of MAX_BUDGET tokens printed 12,509 characters on the spectro
        // graph (evidence/547/probe-query-4000.out); the cap keeps room for it.
        assertTrue(CodeGraphTool.MAX_OUTPUT_CHARS >= 12_509);
        assertEquals(4_000, CodeGraphTool.MAX_BUDGET);
    }
}
