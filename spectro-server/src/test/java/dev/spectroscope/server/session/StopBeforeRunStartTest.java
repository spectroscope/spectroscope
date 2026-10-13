package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Live check 0.15.3 D6 (card 557): against a host that never answers, a run
 * asks the backend for its window before {@code run_start}, about two seconds
 * per question. The page now offers Stop from the moment the message left, so
 * a Stop in that gap, even one that follows the message at once, must end
 * the run as aborted.
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class StopBeforeRunStartTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Card 557, criterion 1: Stop ends the run within a second. */
    private static final long STOP_BOUND_MS = 1_000;

    /** Rounds of the immediate Stop: the old gap was a race between two threads. */
    private static final int ROUNDS = 20;

    @TempDir Path workspace;

    /** A backend whose window question waits like a black-holed host, until the run's thread is interrupted. */
    private static final class BlackHoleWindow implements LlmProvider {
        final CountDownLatch asked = new CountDownLatch(1);

        @Override
        public int contextWindow() {
            asked.countDown();
            try {
                new CountDownLatch(1).await(10, TimeUnit.SECONDS);
            } catch (InterruptedException stopped) {
                Thread.currentThread().interrupt();
            }
            return 0;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (request.signal() != null && request.signal().isCancelled()) {
                return List.of(new PStop(PStop.StopReason.ABORTED));
            }
            return List.of(new PTextDelta("ok"), new PUsage(1, 1), new PStop(PStop.StopReason.END_TURN));
        }

        @Override
        public String modelName() {
            return "qwen3:8b";
        }
    }

    private SessionConnection session(FakeSocket socket, LlmProvider backend) {
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                        workspace.toString())),
                null);
        connection.providerBuilderForTest(c -> backend);
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.onSetPermissionMode("auto");
        return connection;
    }

    /** The run frames of the socket, in order, as type plus stop reason. */
    private static List<String> runFrames(FakeSocket socket) throws IOException {
        List<String> out = new ArrayList<>();
        for (FakeSocket.Frame f : socket.frames()) {
            JsonNode n = JSON.readTree(f.payload());
            String type = n.path("type").asText();
            if (type.equals("run_start") || type.equals("run_end")) {
                out.add(type + (n.has("stopReason") ? " " + n.path("stopReason").asText() : ""));
            }
        }
        return out;
    }

    /** Waits for the root run_end and returns the frames up to then, or what there is after the wait. */
    private static List<String> awaitRunEnd(FakeSocket socket, long waitMs) throws Exception {
        long until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(waitMs);
        List<String> frames = runFrames(socket);
        while (frames.stream().noneMatch(f -> f.startsWith("run_end")) && System.nanoTime() < until) {
            Thread.sleep(5);
            frames = runFrames(socket);
        }
        return frames;
    }

    @Test
    void aStopWhileTheWindowIsAskedEndsTheRunWithinASecond() throws Exception {
        FakeSocket socket = new FakeSocket("ws-d6-gap", "ws://localhost/ws");
        BlackHoleWindow backend = new BlackHoleWindow();
        SessionConnection connection = session(socket, backend);
        try {
            connection.onUserMessage("hello", null);
            assertThat(backend.asked.await(5, TimeUnit.SECONDS)).as("the run asks for the window").isTrue();
            assertThat(runFrames(socket)).as("no run_start while the window is asked").isEmpty();

            long stopAt = System.nanoTime();
            connection.onStopFrame();
            List<String> frames = awaitRunEnd(socket, 5_000);
            long ms = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - stopAt);

            assertThat(frames).as("Stop to run_end took %d ms", ms).containsExactly("run_start", "run_end aborted");
            assertThat(ms).as("Stop to run_end in ms").isLessThan(STOP_BOUND_MS);
        } finally {
            connection.onClose();
        }
    }

    @Test
    void aStopRightBehindTheMessageEndsTheRunEveryTime() throws Exception {
        List<String> missed = new ArrayList<>();
        for (int round = 0; round < ROUNDS; round++) {
            FakeSocket socket = new FakeSocket("ws-d6-race-" + round, "ws://localhost/ws");
            SessionConnection connection = session(socket, new BlackHoleWindow());
            try {
                // The socket thread handles the two frames one after the other,
                // as Tomcat delivers them; the run's own thread starts between.
                long sentAt = System.nanoTime();
                connection.onUserMessage("hello", null);
                connection.onStopFrame();
                List<String> frames = awaitRunEnd(socket, 3 * STOP_BOUND_MS);
                long ms = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - sentAt);
                if (!frames.contains("run_end aborted") || ms >= STOP_BOUND_MS) {
                    missed.add("round " + round + ": " + frames + " after " + ms + " ms");
                }
            } finally {
                connection.onClose();
            }
        }
        assertThat(missed).as("rounds whose Stop did not end the run as aborted within %d ms", STOP_BOUND_MS)
                .isEmpty();
    }
}
