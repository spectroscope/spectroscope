package dev.spectroscope.core.tools;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Stream;

import static dev.spectroscope.core.tools.MeasuredHost.ELECTRON;
import static dev.spectroscope.core.tools.MeasuredHost.GPU_HELPER;
import static dev.spectroscope.core.tools.MeasuredHost.JVM;
import static dev.spectroscope.core.tools.MeasuredHost.LAUNCHD;
import static dev.spectroscope.core.tools.MeasuredHost.NETWORK_HELPER;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 396, criteria 3, 4, 6 and 9: which shell lines the host guard refuses
 * over the process tree measured before the first self-kill, and which it
 * lets through. Everything here is the pure check; nothing is started.
 */
class HostGuardTest {

    /**
     * Criterion 3: the protected set is this JVM, its ancestors up to PID 1 and
     * the children of its direct parent, and nothing else.
     */
    @Test
    void theProtectedSetIsTheJvmItsAncestorsAndItsParentsChildren() {
        List<Long> pids = MeasuredHost.guard().protectedProcesses().stream()
                .map(HostGuard.Proc::pid).toList();
        assertEquals(List.of(JVM, ELECTRON, LAUNCHD, GPU_HELPER, NETWORK_HELPER), pids,
                "self first, then the ancestors nearest first, then the parent's other"
                        + " children; the terminal, vitest and vite are not in it");
    }

    /**
     * Criteria 1, 4 and 9. Each row: the command, the pid the refusal must
     * name, and the pattern it must quote. The single lines of the 19:00 and
     * 19:02 commands stand alone as well, because the whole command is
     * already refused by its first line: only alone does the second line show
     * that the ancestor walk is what catches it.
     */
    static Stream<Arguments> refused() {
        return Stream.of(
                // The three self-kills, verbatim.
                Arguments.of(MeasuredHost.AT_17_09, JVM, "spectroscope\\.app"),
                Arguments.of(MeasuredHost.AT_19_00, GPU_HELPER, "spectroscope Helper"),
                Arguments.of(MeasuredHost.AT_19_02, GPU_HELPER, "spectroscope Helper"),
                // Their lines alone: a sibling case and two ancestor cases.
                Arguments.of("pkill -9 -f \"spectroscope Helper\" 2>/dev/null",
                        GPU_HELPER, "spectroscope Helper"),
                Arguments.of("pkill -9 -f \"spectroscope\\\\.app/Contents/MacOS/spectroscope\"",
                        ELECTRON, "spectroscope\\.app/Contents/MacOS/spectroscope"),
                Arguments.of("pkill -9 -f \"spectroscope.app/Contents/MacOS/spectroscope\"",
                        ELECTRON, "spectroscope.app/Contents/MacOS/spectroscope"),
                // kill with a numeric target in the set.
                Arguments.of("kill 60380", ELECTRON, "60380"),
                Arguments.of("kill -9 60383", JVM, "60383"),
                Arguments.of("kill -KILL 60381", GPU_HELPER, "60381"),
                Arguments.of("kill -s TERM 60382", NETWORK_HELPER, "60382"),
                Arguments.of("/bin/kill -9 -- 60380", ELECTRON, "60380"),
                // A negative number is a process group.
                Arguments.of("kill -9 -- -60380", ELECTRON, "-60380"),
                Arguments.of("kill -TERM -60380", ELECTRON, "-60380"),
                // pkill without -f matches the executable name.
                Arguments.of("pkill spectroscope", ELECTRON, "spectroscope"),
                Arguments.of("pkill -x java", JVM, "java"),
                Arguments.of("pkill -i -f SPECTRO-SERVER.JAR", JVM, "SPECTRO-SERVER.JAR"),
                // killall NAME equal to a protected executable name.
                Arguments.of("killall spectroscope", ELECTRON, "spectroscope"),
                Arguments.of("killall -9 java", JVM, "java"),
                Arguments.of("killall \"spectroscope Helper\"", GPU_HELPER, "spectroscope Helper"),
                // The kernel keeps 16 characters of a name on macOS, 15 on Linux, and
                // that shortened name is what pkill -x and killall compare.
                Arguments.of("pkill -x \"spectroscope Hel\"", GPU_HELPER, "spectroscope Hel"),
                Arguments.of("killall \"spectroscope He\"", GPU_HELPER, "spectroscope He"),
                // pgrep piped into xargs kill.
                Arguments.of("pgrep -f \"spectroscope Helper\" | xargs kill -9",
                        GPU_HELPER, "spectroscope Helper"),
                Arguments.of("pgrep -f spectro-server | xargs -n1 kill", JVM, "spectro-server"),
                // lsof on the server's own port piped into kill.
                Arguments.of("lsof -ti :54704 | xargs kill", JVM, "54704"),
                Arguments.of("lsof -ti tcp:54704 | xargs kill -9", JVM, "54704"),
                Arguments.of("lsof -t -i :54704 | xargs kill", JVM, "54704"),
                Arguments.of("lsof -nP -t -iTCP:54704 -sTCP:LISTEN | xargs kill", JVM, "54704"),
                // Beyond the card's four shapes, the same checks in other clothes.
                Arguments.of("kill 0", JVM, "0"),
                Arguments.of("kill -9 -1", JVM, "-1"),
                Arguments.of("kill -9 $PPID", JVM, "$PPID"),
                Arguments.of("kill $(pgrep -f \"spectroscope Helper\")",
                        GPU_HELPER, "spectroscope Helper"),
                Arguments.of("kill -9 $(lsof -ti :54704)", JVM, "54704"),
                Arguments.of("kill -9 `pgrep -f spectro-server`", JVM, "spectro-server"),
                Arguments.of("ps aux | grep spectroscope | grep -v grep | awk '{print $2}'"
                        + " | xargs kill -9", JVM, "spectroscope"),
                Arguments.of("sh -c 'pkill -f \"spectroscope Helper\"'",
                        GPU_HELPER, "spectroscope Helper"),
                // $PPID inside a shell the line starts. Measured with /bin/sh -c on
                // 2026-09-24: in double quotes run_command's shell expands it, and a
                // sh -c that is the whole line replaces that shell, so each of these
                // prints the process that launched /bin/sh.
                Arguments.of("sh -c \"kill -9 $PPID\"", JVM, "$PPID"),
                Arguments.of("cd /tmp && sh -c \"kill $PPID\"", JVM, "$PPID"),
                Arguments.of("sh -c 'kill -9 $PPID'", JVM, "$PPID"),
                Arguments.of("bash -c 'kill $PPID'", JVM, "$PPID"),
                Arguments.of("sh -c 'kill ${PPID}'", JVM, "${PPID}"),
                Arguments.of("bash -lc \"killall java\"", JVM, "java"),
                Arguments.of("sudo killall java", JVM, "java"),
                Arguments.of("nohup pkill -f spectro-server &", JVM, "spectro-server"),
                Arguments.of("echo $(pkill -f spectro-server)", JVM, "spectro-server"),
                Arguments.of("eval \"killall java\"", JVM, "java"),
                Arguments.of("env LANG=C killall java", JVM, "java"),
                Arguments.of("nice -n 5 killall java", JVM, "java"),
                Arguments.of("timeout 5 killall java", JVM, "java"),
                Arguments.of("exec killall java", JVM, "java"),
                Arguments.of("command killall java", JVM, "java"),
                // pkill -P selects by parent: the Electron main's children are this
                // JVM and the helpers. pkill -v selects what does NOT match.
                Arguments.of("pkill -P 60380", JVM, "-P 60380"),
                Arguments.of("pkill -v -f vitest", JVM, "vitest"));
    }

    @ParameterizedTest
    @MethodSource("refused")
    void aLineThatReachesTheHostIsRefused(String command, long pid, String pattern) {
        Optional<String> refusal = MeasuredHost.guard().refusal(command);
        assertTrue(refusal.isPresent(), "must be refused: " + command);
        String text = refusal.get();
        assertTrue(text.startsWith("ERROR: refused"), text);
        assertTrue(text.contains("protected PID " + pid + " "), "names PID " + pid + ": " + text);
        assertTrue(text.contains("\"" + pattern + "\""), "quotes " + pattern + ": " + text);
        assertTrue(text.contains("would stop the app that runs this agent"), text);
    }

    /**
     * Criterion 6, the other edge: lines that stop only what they started, or
     * something unrelated, and lines that only mention a kill.
     */
    static Stream<String> allowed() {
        return Stream.of(
                "sleep 30 & kill $!; echo done",
                "pkill -f vitest",
                // A redirection is not a pattern: a "2" or "1" read as one would match
                // the digits in a helper's command line.
                "pkill -f vitest 2>/dev/null",
                "pkill -f vitest >/tmp/pkill.log 2>&1",
                "lsof -ti :5173 | xargs kill",
                "kill 71001",
                "kill -9 -- -71001",
                "killall node",
                "pgrep -fl \"spectroscope\" | grep -v -E \"pgrep|grep\" | head",
                "ps -eo pid,etime,stat,command | grep -E \"spectroscope\\.app\" | grep -v grep",
                "kill -l",
                "kill -0 $$",
                // A lookup: command -v prints where each name lives and runs none.
                "command -v killall java",
                "pgrep -f spectroscope | xargs echo",
                "ps aux | grep vitest | grep -v grep | awk '{print $2}' | xargs kill",
                // A grep after pgrep only narrows what pgrep found; it adds nothing.
                "pgrep -f vitest | grep spectroscope | xargs kill",
                "echo \"pkill -f spectroscope\"",
                "git commit -m \"kill 60380\"",
                "grep -rn 'killall java' docs",
                "cat > stop.sh <<'EOF'\npkill -f spectroscope\nEOF\nchmod +x stop.sh");
    }

    @ParameterizedTest
    @MethodSource("allowed")
    void aLineThatLeavesTheHostAloneRuns(String command) {
        assertEquals(Optional.empty(), MeasuredHost.guard().refusal(command),
                "must run unchanged: " + command);
    }

    /**
     * Where the boundary falls on the far side: these reach the host and are
     * NOT refused, because the guard reads the line and does not run it. Pinned
     * so that a later reader does not take the guard for a sandbox.
     */
    static Stream<String> notSeen() {
        return Stream.of(
                "kill $(cat /tmp/app.pid)",
                "P=60380; kill $P",
                "python3 -c 'import os; os.kill(60380, 9)'",
                "./stop.sh");
    }

    @ParameterizedTest
    @MethodSource("notSeen")
    void aLineThatHidesItsTargetIsNotSeen(String command) {
        assertEquals(Optional.empty(), MeasuredHost.guard().refusal(command), command);
    }

    /**
     * A server whose parent is PID 1, as after {@code ./spectro-serve start}
     * or when its desktop parent died, has launchd's children as siblings:
     * every app on the machine. Those are not its host, and they stay out of
     * the set.
     */
    @Test
    void underPidOneTheSiblingsAreNotProtected() {
        HostGuard guard = HostGuard.over(
                MeasuredHost.atTheFirstSelfKill().withParent(JVM, LAUNCHD), Set.of());
        assertEquals(List.of(JVM, LAUNCHD),
                guard.protectedProcesses().stream().map(HostGuard.Proc::pid).toList());
        assertEquals(Optional.empty(), guard.refusal("killall spectroscope"));
        assertTrue(guard.refusal("kill -0 " + JVM).isPresent());
    }

    /**
     * After {@code cd /tmp &&} the inner shell is started as a child, and its
     * {@code $PPID} is run_command's own shell (measured with /bin/sh -c on
     * 2026-09-24), which is not protected. The guard does not tell a replaced
     * shell from a child shell and reads {@code $PPID} in any nested shell as
     * this JVM; the refusal says that it read it so. In run_command's own
     * shell the refusal carries no such note.
     */
    @Test
    void aNestedShellsPpidIsReadAsThisJvmAlsoWhenThatShellIsAChild() {
        String nested = MeasuredHost.guard().refusal("cd /tmp && sh -c 'kill $PPID'")
                .orElseThrow();
        assertTrue(nested.startsWith("ERROR: refused: kill target \"$PPID\", inside a nested"
                + " shell and read as this JVM, matches protected PID " + JVM + " "), nested);
        String own = MeasuredHost.guard().refusal("kill $PPID").orElseThrow();
        assertTrue(own.startsWith("ERROR: refused: kill target \"$PPID\" matches protected PID "
                + JVM + " "), own);
    }

    @Test
    void aGroupIsCheckedByItsNumberEvenWhenItsLeaderIsGone() {
        // The JVM keeps the group of an Electron main that already exited.
        HostGuard guard = HostGuard.over(
                MeasuredHost.atTheFirstSelfKill().withGroup(JVM, 60379), Set.of());
        String text = guard.refusal("kill -- -60379").orElseThrow();
        assertTrue(text.contains("protected PID " + JVM + " "), text);
    }
}
