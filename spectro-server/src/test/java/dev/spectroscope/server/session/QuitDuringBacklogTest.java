package dev.spectroscope.server.session;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 395, criterion 3: a graceful quit while events are still queued writes
 * every queued event to the session file and closes the open run there.
 *
 * <p>A unit test can call a method and read a file. It cannot show what a JVM
 * does on its way out, and that is where the field lost 73 turns: three quits
 * during a GLM backlog left the session file without the events still queued,
 * and the next resume rebuilt the conversation without them. So a real child
 * JVM ({@link QuitDuringBacklogChild}) builds a backlog and gets SIGTERM, the
 * signal the desktop sends on quit, and the file is read afterwards.</p>
 *
 * <p>Card 540: whether the drain finished or was sealed is read from what the
 * child's quit hook counted ({@code flushed <drained> <sealed> <millis>}), not
 * from this JVM's clock. The clock measured SIGTERM to process exit, which
 * holds JVM teardown and reaping as well as the drain, and it went past the
 * 3 s bound under load with every event in the file (card 498). The hook's own
 * flush time, which leaves the teardown out, is held to that bound
 * ({@link #HOOK_FLUSH_BOUND_MILLIS}).</p>
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
@EnabledOnOs({OS.MAC, OS.LINUX})
class QuitDuringBacklogTest {

    /**
     * Card 540: the quit hook's flush of this backlog must end inside the
     * production bound, {@link QuitFlush#BOUND}; past it, a real quit seals the
     * drain and loses the queued events. The time is the hook's own, quit to last
     * drain, so JVM teardown is not in it. Measured on 2026-10-11 and 2026-10-12
     * on this Mac, 54 runs of this test (the {@code flushed} line of each run,
     * kanban/evidence/540/fix1-flush-distribution.txt): 708 to 1771 ms at load
     * averages 2.9 to 164.8 before the run, every run {@code flushed 1 0}. The
     * bound is 1.7 times the slowest of them. A red here says a quit under that
     * load would lose events, not that the test is slow.
     */
    static final long HOOK_FLUSH_BOUND_MILLIS = QuitFlush.BOUND.toMillis();

    @Test
    void aQuitDuringABacklogWritesEveryQueuedEventAndClosesTheRun(@TempDir Path workspace)
            throws Exception {
        Process child = new ProcessBuilder(
                System.getProperty("java.home") + "/bin/java",
                "-Duser.home=" + System.getProperty("user.home"),
                "-cp", System.getProperty("java.class.path"),
                QuitDuringBacklogChild.class.getName(), workspace.toString())
                .redirectErrorStream(true)
                .start();
        StringBuilder output = new StringBuilder();
        try {
            BufferedReader out = new BufferedReader(
                    new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8));
            String ready = null;
            String line;
            while (ready == null && (line = out.readLine()) != null) {
                output.append(line).append('\n');
                if (line.startsWith("ready ")) {
                    ready = line;
                }
            }
            assertThat(ready).as("the child builds its backlog; output:\n" + output).isNotNull();
            Thread.ofVirtual().start(() -> {
                try {
                    String rest;
                    while ((rest = out.readLine()) != null) {
                        synchronized (output) {
                            output.append(rest).append('\n');
                        }
                    }
                } catch (java.io.IOException gone) {
                    // the child exited
                }
            });
            String[] parts = ready.split(" ");
            String sessionId = parts[1];
            int requests = Integer.parseInt(parts[2]);

            long quitAt = System.nanoTime();
            child.destroy(); // SIGTERM, what the desktop sends on quit
            assertThat(child.waitFor(QuitDuringBacklogChild.REPORT_WAIT.toSeconds() + 30, TimeUnit.SECONDS))
                    .as("the child exits on SIGTERM").isTrue();
            long quitMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - quitAt);

            int turns = QuitDuringBacklogChild.TURNS;
            int lines = turns * QuitDuringBacklogChild.LINES_PER_TURN;
            int calls = turns * QuitDuringBacklogChild.CALLS_PER_TURN;
            List<RunEvent> events = SessionStore.readSessionEvents(sessionId);
            StringBuilder thinking = new StringBuilder();
            int turnStarts = 0;
            int toolResults = 0;
            String rootRun = null;
            boolean rootClosed = false;
            for (RunEvent event : events) {
                if (event instanceof RunEvent.RunStart start && start.parentId() == null) {
                    rootRun = start.runId();
                } else if (event instanceof RunEvent.RunEnd end && end.runId().equals(rootRun)) {
                    rootClosed = true;
                } else if (event instanceof RunEvent.TurnStart turn && "main".equals(turn.agentId())) {
                    turnStarts++;
                } else if (event instanceof RunEvent.ThinkingDelta delta
                        && "main".equals(delta.agentId())) {
                    thinking.append(delta.text());
                } else if (event instanceof RunEvent.ToolResult result
                        && "main".equals(result.agentId())) {
                    toolResults++;
                }
            }
            String childOutput;
            synchronized (output) {
                childOutput = output.toString();
            }
            // Card 540: the quit hook's line comes through a file. Over the pipe it did
            // not arrive in seven runs of seven; a read after the exit said "Stream closed"
            // (kanban/evidence/540, green-quit-first, green-quit-second, diag-quit-file).
            Path flushedFile = workspace.resolve(QuitDuringBacklogChild.FLUSHED_FILE);
            String flushed = java.nio.file.Files.exists(flushedFile)
                    ? java.nio.file.Files.readString(flushedFile).strip()
                    : "flushed (no file)";
            String report = "after the quit the file holds " + thinking.length() / 6 + " of "
                    + lines + " thinking lines, " + turnStarts + " of " + requests
                    + " turn starts and " + toolResults + " of " + calls + " tool results; the root"
                    + " run is " + (rootClosed ? "closed" : "still open") + "; the quit hook says '"
                    + flushed + "' (drained, sealed, ms); the child exited " + quitMillis
                    + " ms after SIGTERM. Child output:\n" + childOutput;
            System.out.println("card 395 quit: " + report);

            assertThat(requests).as("test premise: the child reached the held request").isEqualTo(turns + 1);
            assertThat(thinking.toString())
                    .as("every queued thinking line is in the file, in order; " + report)
                    .isEqualTo(ThinkingFloodBackend.textOf(lines));
            assertThat(turnStarts)
                    .as("one turn start per request the backend received; " + report)
                    .isEqualTo(requests);
            assertThat(toolResults).as("every tool result is in the file; " + report).isEqualTo(calls);
            assertThat(rootClosed).as("the open run got its run_end in the file; " + report).isTrue();
            assertThat(flushed)
                    .as("the quit cancels the run, so its one drain finishes instead of being sealed"
                            + " at the bound; " + report)
                    .startsWith("flushed 1 0 ");
            long hookMillis = Long.parseLong(flushed.split(" ")[3]);
            assertThat(hookMillis)
                    .as("the drain the quit cancelled finishes inside the production bound, "
                            + HOOK_FLUSH_BOUND_MILLIS + " ms; " + report)
                    .isLessThan(HOOK_FLUSH_BOUND_MILLIS);

            List<ProviderMessage> resumed = SessionStore.loadSession(sessionId);
            long resumedResults = resumed.stream()
                    .flatMap(message -> message.content().stream())
                    .filter(ToolResultContent.class::isInstance)
                    .count();
            assertThat(resumedResults)
                    .as("a resume after the quit rebuilds every tool round the model made")
                    .isEqualTo(calls);
        } finally {
            child.destroyForcibly();
        }
    }
}
