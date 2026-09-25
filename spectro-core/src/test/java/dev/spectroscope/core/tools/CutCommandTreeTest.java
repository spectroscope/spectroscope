package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 385: a cut command takes the processes below its shell with it.
 *
 * <p>Before this card a cut killed the one {@code /bin/sh} process. What the
 * shell had started kept running, invisible to the app. The four shapes are
 * the card's table. None of them forks after the cut's census, so these tests
 * do not reach the window {@code ShellCommand.Tree} names. Every count here is taken from outside, by the marker in
 * the command line ({@link MarkedProcesses}), never through
 * {@link ProcessHandle#descendants()} of the killed shell, which finds nothing
 * once the shell is dead.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CutCommandTreeTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** How long a test waits to see the command's processes before it cuts. */
    private static final long SEEN_WITHIN_MS = 5_000;

    /** How long a test waits for a cut run to return. */
    private static final long RETURNS_WITHIN_MS = 10_000;

    /** The card's four command shapes, with the programs each one runs. */
    enum Shape {
        /** The shell replaces itself with the sleep, so killing it is killing the sleep. */
        ALONE("sleep %1$s", "sleep"),
        /** The shell waits on the sleep to decide whether to echo. */
        AND_THEN("sleep %1$s && echo done", "sleep"),
        /** The shell runs the echo, then waits on the sleep. */
        AFTER_A_SEMICOLON("echo hi; sleep %1$s", "sleep"),
        /** Two children of the shell. The reader carries the marker too, so it is counted. */
        PIPE("sleep %1$s | grep -v %1$s", "sleep", "grep");

        private final String template;
        private final String[] programs;

        Shape(String template, String... programs) {
            this.template = template;
            this.programs = programs;
        }

        String command(String marker) {
            return String.format(template, marker);
        }
    }

    private static ShellCommand.Result run(String command, Path cwd, long timeoutSeconds,
                                           CancelSignal signal) {
        return ShellCommand.run(command, Map.of(), cwd, timeoutSeconds, signal, 1_000);
    }

    private static void assertNoSurvivor(String marker, String what) throws InterruptedException {
        List<ProcessHandle> survivors =
                MarkedProcesses.survivorsAfter(marker, ShellCommand.REAP_GRACE_MS);
        assertTrue(survivors.isEmpty(), what + " left " + survivors.size()
                + " process(es) alive " + ShellCommand.REAP_GRACE_MS + " ms after the cut: "
                + MarkedProcesses.describe(survivors));
    }

    @ParameterizedTest
    @EnumSource(Shape.class)
    void aTimeLimitLeavesNoSurvivorCountedFromOutside(Shape shape, @TempDir Path cwd)
            throws InterruptedException {
        String marker = MarkedProcesses.fresh();
        try {
            ThreadedCall<ShellCommand.Result> call = ThreadedCall.start(
                    () -> run(shape.command(marker), cwd, 1, new CancelSignal()));
            assertTrue(MarkedProcesses.awaitRunning(marker, SEEN_WITHIN_MS, shape.programs),
                    "the command's processes were never seen running, so a count of"
                            + " zero afterwards would prove nothing: " + shape.command(marker));
            ShellCommand.Result result = call.join(RETURNS_WITHIN_MS);

            assertTrue(result.timedOut(), "the command was not cut by its limit: " + result);
            assertNoSurvivor(marker, "the time limit on '" + shape.command(marker) + "'");
        } finally {
            MarkedProcesses.reap(marker);
        }
    }

    @Test
    void theBuildDiesWithItsCommandThroughRunCommandCountedFromOutside(@TempDir Path cwd)
            throws InterruptedException {
        // The card's first scenario, through the tool the model calls.
        String marker = MarkedProcesses.fresh();
        try {
            Tool tool = StandardTools.all(1).stream()
                    .filter(candidate -> "run_command".equals(candidate.name()))
                    .findFirst().orElseThrow();
            ObjectNode input = JSON.createObjectNode()
                    .put("command", "sleep " + marker + " && echo done");
            ThreadedCall<String> call = ThreadedCall.start(
                    () -> tool.execute(input, new Tool.ToolContext(cwd, new CancelSignal())));
            assertTrue(MarkedProcesses.awaitRunning(marker, SEEN_WITHIN_MS, "sleep"),
                    "the command's sleep was never seen running, so a count of zero"
                            + " afterwards would prove nothing");
            String result = call.join(RETURNS_WITHIN_MS);

            assertTrue(result.startsWith("ERROR: command timed out after 1 s."),
                    "the tool result is not the timed out error: " + result);
            assertNoSurvivor(marker, "run_command's time limit");
        } finally {
            MarkedProcesses.reap(marker);
        }
    }

    @ParameterizedTest
    @EnumSource(Shape.class)
    void aCancelLeavesNoSurvivorCountedFromOutside(Shape shape, @TempDir Path cwd)
            throws InterruptedException {
        String marker = MarkedProcesses.fresh();
        try {
            CancelSignal signal = new CancelSignal();
            ThreadedCall<ShellCommand.Result> call = ThreadedCall.start(
                    () -> run(shape.command(marker), cwd, 60, signal));
            assertTrue(MarkedProcesses.awaitRunning(marker, SEEN_WITHIN_MS, shape.programs),
                    "the command's processes were never seen running, so a count of"
                            + " zero afterwards would prove nothing: " + shape.command(marker));

            signal.cancel();
            ShellCommand.Result result = call.join(RETURNS_WITHIN_MS);

            assertFalse(result.timedOut(), "a cancel is not a time limit: " + result);
            assertNoSurvivor(marker, "a cancel of '" + shape.command(marker) + "'");
        } finally {
            MarkedProcesses.reap(marker);
        }
    }

    @ParameterizedTest
    @EnumSource(Shape.class)
    void anInterruptLeavesNoSurvivorCountedFromOutside(Shape shape, @TempDir Path cwd)
            throws InterruptedException {
        String marker = MarkedProcesses.fresh();
        try {
            ThreadedCall<ShellCommand.Result> call = ThreadedCall.start(
                    () -> run(shape.command(marker), cwd, 60, new CancelSignal()));
            assertTrue(MarkedProcesses.awaitRunning(marker, SEEN_WITHIN_MS, shape.programs),
                    "the command's processes were never seen running, so a count of"
                            + " zero afterwards would prove nothing: " + shape.command(marker));

            call.interrupt();
            ShellCommand.Result result = call.join(RETURNS_WITHIN_MS);

            assertEquals("interrupted", result.failure(), "the run did not end on the interrupt: "
                    + result);
            assertNoSurvivor(marker, "an interrupt of '" + shape.command(marker) + "'");
        } finally {
            MarkedProcesses.reap(marker);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"echo started", "sleep 0.3; echo started"})
    void aCommandThatEndsOnItsOwnKeepsItsBackgroundJobCountedFromOutside(String rest,
                                                                         @TempDir Path cwd)
            throws InterruptedException {
        // The card's default for its owner question: a command that ends
        // within its limit loses nothing it left in the background. A stop
        // pressed after it ended does not reach the job either. The second
        // command keeps its shell alive beside the job for 0.3 s, so a runner
        // that noted the shell's children while it ran would have seen it.
        String marker = MarkedProcesses.fresh();
        try {
            CancelSignal signal = new CancelSignal();
            ShellCommand.Result result = run("sleep " + marker + " > /dev/null 2>&1 & " + rest,
                    cwd, 10, signal);
            assertEquals(0, result.exitCode(), "the command did not end on its own: " + result);
            assertFalse(result.timedOut());
            assertEquals("started\n", result.output());

            signal.cancel();
            List<ProcessHandle> stillThere =
                    MarkedProcesses.survivorsAfter(marker, ShellCommand.REAP_GRACE_MS);

            assertEquals(1, stillThere.size(), "the background job is gone: "
                    + MarkedProcesses.describe(stillThere));
            assertTrue(stillThere.get(0).info().command().orElse("").endsWith("/sleep"),
                    "the process left alive is not the background sleep: "
                            + MarkedProcesses.describe(stillThere));
        } finally {
            MarkedProcesses.reap(marker);
        }
    }

    // The review of card 385: the JDK's native walk over the processes below
    // the shell can throw (on macOS "sysctl failed", or an OutOfMemoryError).
    // The shell is killed whatever the walk does. What was below it is then
    // out of reach, so these tests count the shell alone, and reap the rest.

    /**
     * A census that fails the way the JDK's walk can, after noting the shell
     * it was asked about.
     */
    private static Function<ProcessHandle, List<ProcessHandle>> failingCensus(
            AtomicReference<ProcessHandle> askedAbout, Throwable failure) {
        return shell -> {
            askedAbout.set(shell);
            if (failure instanceof RuntimeException runtime) {
                throw runtime;
            }
            throw (Error) failure;
        };
    }

    private static ShellCommand.Result run(String command, Path cwd, long timeoutSeconds,
                                           CancelSignal signal,
                                           Function<ProcessHandle, List<ProcessHandle>> census) {
        return ShellCommand.run(command, Map.of(), cwd, timeoutSeconds, signal, 1_000, false,
                census);
    }

    /** Waits for the command's processes and returns the pids the outside census saw. */
    private static Set<Long> awaitSeen(String marker, Shape shape) throws InterruptedException {
        assertTrue(MarkedProcesses.awaitRunning(marker, SEEN_WITHIN_MS, shape.programs),
                "the command's processes were never seen running, so a count of"
                        + " zero afterwards would prove nothing: " + shape.command(marker));
        return MarkedProcesses.alive(marker).stream()
                .map(ProcessHandle::pid)
                .collect(Collectors.toSet());
    }

    private static void assertShellGone(String marker, ProcessHandle shell, Set<Long> seen,
                                        String what) throws InterruptedException {
        assertNotNull(shell, what + ": the cut never asked for the processes below the shell");
        assertTrue(seen.contains(shell.pid()), what + ": the shell " + shell.pid()
                + " was not in the outside census before the cut, so its absence afterwards"
                + " would prove nothing: " + seen);
        assertTrue(MarkedProcesses.goneWithin(marker, shell.pid(), ShellCommand.REAP_GRACE_MS),
                what + " left the shell " + shell.pid() + " alive "
                        + ShellCommand.REAP_GRACE_MS + " ms after the cut");
    }

    @Test
    void aTimeLimitWhoseCensusFailsStillKillsTheShellCountedFromOutside(@TempDir Path cwd)
            throws InterruptedException {
        String marker = MarkedProcesses.fresh();
        try {
            AtomicReference<ProcessHandle> asked = new AtomicReference<>();
            ThreadedCall<ShellCommand.Result> call = ThreadedCall.start(() -> run(
                    Shape.AND_THEN.command(marker), cwd, 1, new CancelSignal(),
                    failingCensus(asked, new RuntimeException("sysctl failed (test)"))));
            Set<Long> seen = awaitSeen(marker, Shape.AND_THEN);
            ShellCommand.Result result = call.join(RETURNS_WITHIN_MS);

            assertShellGone(marker, asked.get(), seen, "a time limit with a failed census");
            assertTrue(result.timedOut(), "a failed census turned the time limit into"
                    + " something else: " + result);
        } finally {
            MarkedProcesses.reap(marker);
        }
    }

    @Test
    void aCancelWhoseCensusFailsStillKillsTheShellCountedFromOutside(@TempDir Path cwd)
            throws InterruptedException {
        String marker = MarkedProcesses.fresh();
        try {
            AtomicReference<ProcessHandle> asked = new AtomicReference<>();
            CancelSignal signal = new CancelSignal();
            ThreadedCall<ShellCommand.Result> call = ThreadedCall.start(() -> run(
                    Shape.AND_THEN.command(marker), cwd, 60, signal,
                    failingCensus(asked, new RuntimeException("sysctl failed (test)"))));
            Set<Long> seen = awaitSeen(marker, Shape.AND_THEN);

            signal.cancel();

            assertShellGone(marker, asked.get(), seen, "a cancel with a failed census");
            ShellCommand.Result result = call.join(RETURNS_WITHIN_MS);
            assertFalse(result.timedOut(), "a cancel is not a time limit: " + result);
        } finally {
            MarkedProcesses.reap(marker);
        }
    }

    @Test
    void anInterruptWhoseCensusFailsStillKillsTheShellCountedFromOutside(@TempDir Path cwd)
            throws InterruptedException {
        String marker = MarkedProcesses.fresh();
        try {
            AtomicReference<ProcessHandle> asked = new AtomicReference<>();
            ThreadedCall<ShellCommand.Result> call = ThreadedCall.start(() -> run(
                    Shape.AND_THEN.command(marker), cwd, 60, new CancelSignal(),
                    failingCensus(asked, new RuntimeException("sysctl failed (test)"))));
            Set<Long> seen = awaitSeen(marker, Shape.AND_THEN);

            call.interrupt();
            ShellCommand.Result result = call.join(RETURNS_WITHIN_MS);

            assertEquals("interrupted", result.failure(), "the run did not end on the"
                    + " interrupt: " + result);
            assertShellGone(marker, asked.get(), seen, "an interrupt with a failed census");
        } finally {
            MarkedProcesses.reap(marker);
        }
    }

    @Test
    void aTimeLimitWhoseCensusThrowsAnErrorStillKillsTheShellCountedFromOutside(
            @TempDir Path cwd) throws InterruptedException {
        // An Error is not turned into a result: it leaves run, after the kill.
        String marker = MarkedProcesses.fresh();
        try {
            AtomicReference<ProcessHandle> asked = new AtomicReference<>();
            Error failure = new Error("a test's stand in for an OutOfMemoryError");
            ThreadedCall<ShellCommand.Result> call = ThreadedCall.start(() -> run(
                    Shape.AND_THEN.command(marker), cwd, 1, new CancelSignal(),
                    failingCensus(asked, failure)));
            Set<Long> seen = awaitSeen(marker, Shape.AND_THEN);

            AssertionError thrown = assertThrows(AssertionError.class,
                    () -> call.join(RETURNS_WITHIN_MS));
            assertSame(failure, thrown.getCause(), "run did not end with the census's Error: "
                    + thrown);
            assertShellGone(marker, asked.get(), seen, "a time limit whose census threw an Error");
        } finally {
            MarkedProcesses.reap(marker);
        }
    }
}
