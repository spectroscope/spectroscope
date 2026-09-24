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
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
@EnabledOnOs({OS.MAC, OS.LINUX})
class QuitDuringBacklogTest {

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
            assertThat(child.waitFor(30, TimeUnit.SECONDS)).as("the child exits on SIGTERM").isTrue();
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
            String report = "after the quit the file holds " + thinking.length() / 6 + " of "
                    + lines + " thinking lines, " + turnStarts + " of " + requests
                    + " turn starts and " + toolResults + " of " + calls + " tool results; the root"
                    + " run is " + (rootClosed ? "closed" : "still open") + "; the child exited "
                    + quitMillis + " ms after SIGTERM. Child output:\n" + childOutput;
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
            assertThat(quitMillis)
                    .as("the quit cancels the run, so its drain finishes before the bound instead of"
                            + " being sealed at it; " + report)
                    .isLessThan(QuitFlush.BOUND.toMillis());

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
