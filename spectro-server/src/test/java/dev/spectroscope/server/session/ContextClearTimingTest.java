package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 471, the non-functional criterion: {@code /clear} returns within one
 * second on a session of 10,000 events.
 *
 * <p>The clock starts when the frame's handler is called and stops when the
 * {@code context_cleared} frame has left on the socket, so it covers the
 * history drop, the append to the session file and the send. Both shapes of a
 * resumed session are measured: before the first prompt (the history still
 * waits in the connection) and after the agent was built from it. The measured
 * values are printed as {@code MEASURE} lines into the test's standard output,
 * which Gradle keeps in the result XML.</p>
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class ContextClearTimingTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** 2,500 runs of four events each: 10,000 lines. */
    private static final int RUNS = 2_500;

    private static String tenThousandEvents() {
        StringBuilder out = new StringBuilder();
        long ts = 1;
        for (int run = 0; run < RUNS; run++) {
            String runId = "r" + run;
            out.append("{\"type\":\"run_start\",\"runId\":\"").append(runId)
                    .append("\",\"agentId\":\"main\",\"prompt\":\"question number ").append(run)
                    .append(" with some words in it\",\"ts\":").append(ts++).append("}\n");
            out.append("{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":").append(ts++).append("}\n");
            out.append("{\"type\":\"text_delta\",\"agentId\":\"main\",\"text\":\"answer number ").append(run)
                    .append(" with a sentence of reply text\",\"ts\":").append(ts++).append("}\n");
            out.append("{\"type\":\"run_end\",\"runId\":\"").append(runId)
                    .append("\",\"stopReason\":\"end_turn\",\"ts\":").append(ts++).append("}\n");
        }
        return out.toString();
    }

    private static SessionConnection resumed(FakeSocket socket, Path workspace, String id) throws IOException {
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"),
                "{ \"provider\": \"ollama\", \"model\": \"qwen3:latest\" }\n");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:latest", null,
                        null, null, workspace.toString())),
                id);
        connection.start();
        return connection;
    }

    private static long clearMillis(SessionConnection connection, FakeSocket socket) {
        long started = System.nanoTime();
        connection.onClearContext();
        long elapsed = (System.nanoTime() - started) / 1_000_000;
        assertThat(socket.textJoined())
                .as("the clock measured a clear that really dropped the whole history: 2,500 prompts"
                        + " and 2,500 answers")
                .contains("\"type\":\"context_cleared\"")
                .contains("\"removedMessages\":5000");
        return elapsed;
    }

    @Test
    void aClearOnASessionOfTenThousandEventsReturnsWithinOneSecond(@TempDir Path workspace)
            throws IOException {
        String id = "20261009-120000-c471time";
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Files.writeString(SessionStore.sessionFile(id), tenThousandEvents());
        try {
            int events = SessionStore.eventCount(id);
            assertThat(events).as("premise: the session holds 10,000 events").isEqualTo(10_000);

            FakeSocket before = new FakeSocket("ws-471-time-a", "ws://localhost/ws");
            SessionConnection unbuilt = resumed(before, workspace, id);
            long unbuiltMs = clearMillis(unbuilt, before);

            // The marker just written is the file's last line; a second resume
            // would start empty, so the built case reads the file without it.
            Files.writeString(SessionStore.sessionFile(id), tenThousandEvents());
            FakeSocket after = new FakeSocket("ws-471-time-b", "ws://localhost/ws");
            SessionConnection built = resumed(after, workspace, id);
            built.buildAgentOnce();
            long builtMs = clearMillis(built, after);

            System.out.println("MEASURE events=" + events
                    + " clear_before_first_prompt_ms=" + unbuiltMs
                    + " clear_with_agent_built_ms=" + builtMs);
            assertThat(unbuiltMs).isLessThan(1_000);
            assertThat(builtMs).isLessThan(1_000);
        } finally {
            Files.deleteIfExists(SessionStore.sessionFile(id));
        }
    }
}
