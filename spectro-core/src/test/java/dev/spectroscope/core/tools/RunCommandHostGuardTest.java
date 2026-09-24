package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 396, criteria 1, 2, 5 and 6 at the tool: {@code run_command} itself,
 * not the pure check.
 *
 * <p>The three self-kill commands go through a recording shell over the
 * measured tree, so a guard that fails lets them reach the recorder and not
 * the machine. Only lines that are harmless when the guard fails run in a
 * real shell: signal 0 sends nothing, and the pkill below can only match a
 * sleep this test started.</p>
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class RunCommandHostGuardTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A shell that records what reached it and runs nothing. */
    private static final class RecordingShell implements StandardTools.Shell {
        final List<String> reached = new ArrayList<>();

        @Override
        public ShellCommand.Result run(String command, java.util.Map<String, String> extraEnv,
                                       Path cwd, long timeoutSeconds, CancelSignal signal,
                                       int maxOutputChars) {
            reached.add(command);
            return new ShellCommand.Result(0, "", false, null);
        }
    }

    private static ObjectNode command(String line) {
        return JSON.createObjectNode().put("command", line);
    }

    private static String liveRun(Path dir, String line) {
        Tool run = StandardTools.all(10).stream()
                .filter(tool -> tool.name().equals("run_command")).findFirst().orElseThrow();
        return run.execute(command(line), new ToolContext(dir, new CancelSignal()));
    }

    /** Criteria 1 and 5: the three commands of 2026-09-23 never reach a shell. */
    @Test
    void theThreeSelfKillsAreRefusedBeforeAnyShellStarts(@TempDir Path dir) {
        RecordingShell shell = new RecordingShell();
        Tool run = StandardTools.runCommand(10, MeasuredHost::guard, shell);
        for (String line : List.of(MeasuredHost.AT_17_09, MeasuredHost.AT_19_00,
                MeasuredHost.AT_19_02)) {
            String out = run.execute(command(line), new ToolContext(dir, new CancelSignal()));
            assertTrue(out.startsWith("ERROR: refused"), out);
            assertTrue(out.contains("protected PID "), out);
            assertTrue(out.contains("would stop the app that runs this agent"), out);
            assertTrue(out.contains("Nothing in the command ran."), out);
        }
        assertEquals(List.of(), shell.reached, "no part of a refused line reaches the shell");
    }

    /** Criterion 6 at the tool: a line the guard allows reaches the shell unchanged. */
    @Test
    void anAllowedLineReachesTheShellUnchanged(@TempDir Path dir) {
        RecordingShell shell = new RecordingShell();
        Tool run = StandardTools.runCommand(10, MeasuredHost::guard, shell);
        for (String line : List.of("sleep 30 & kill $!; echo done", "pkill -f vitest",
                "lsof -ti :5173 | xargs kill")) {
            run.execute(command(line), new ToolContext(dir, new CancelSignal()));
        }
        assertEquals(List.of("sleep 30 & kill $!; echo done", "pkill -f vitest",
                "lsof -ti :5173 | xargs kill"), shell.reached);
    }

    /** An rtk rewrite does not hide the line the model wrote. */
    @Test
    void theModelsOwnLineIsCheckedBesideARewrite(@TempDir Path dir) {
        RecordingShell shell = new RecordingShell();
        Tool run = StandardTools.runCommand(10, MeasuredHost::guard, shell);
        ObjectNode input = command("rtk proxy true");
        input.put(RtkFilter.ORIGINAL_FIELD, "killall java");
        String out = run.execute(input, new ToolContext(dir, new CancelSignal()));
        assertTrue(out.startsWith("ERROR: refused"), out);
        assertEquals(List.of(), shell.reached);
    }

    /** The report's own red test, on the real process tree: signal 0 sends nothing. */
    @Test
    void signalZeroToThisVeryJvmIsRefused(@TempDir Path dir) {
        long self = ProcessHandle.current().pid();
        String out = liveRun(dir, "kill -0 " + self);
        assertTrue(out.startsWith("ERROR: refused"), out);
        assertTrue(out.contains("protected PID " + self + " "), out);
    }

    /** $PPID in run_command's shell is this JVM. */
    @Test
    void signalZeroToTheShellsParentIsRefused(@TempDir Path dir) {
        String out = liveRun(dir, "kill -0 $PPID");
        assertTrue(out.startsWith("ERROR: refused"), out);
        assertTrue(out.contains("protected PID " + ProcessHandle.current().pid() + " "), out);
    }

    /** Criterion 6, live: a command ending its own child still runs. */
    @Test
    void aKillOfSomethingThisCommandStartedStillRuns(@TempDir Path dir) {
        assertEquals("done\n", liveRun(dir, "sleep 30 & kill $!; echo done"));
    }

    /**
     * Criterion 6, live: a pkill aimed at an unrelated process runs. The
     * target is a sleep with a number no other process carries, and the
     * pattern's bracket keeps the shell's own command line from matching it.
     */
    @Test
    void aPkillOfAnUnrelatedProcessStillRuns(@TempDir Path dir) {
        String digits = Long.toString(ThreadLocalRandom.current().nextLong(1_000_000L, 9_999_999L));
        String line = "N=30.396" + digits + "; sleep $N & P=$!; sleep 0.3;"
                + " pkill -f \"sleep 30[.]396" + digits + "\"; wait $P;"
                + " kill -0 $P 2>/dev/null && echo alive || echo gone";
        String out = liveRun(dir, line);
        // The shell may print its own "Terminated" notice for the job first.
        assertTrue(out.endsWith("gone\n"), "the pkill ran and ended its target: " + out);
        assertTrue(!out.startsWith("ERROR"), out);
    }
}
