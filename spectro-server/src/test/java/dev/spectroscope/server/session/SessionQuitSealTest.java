package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 395, criterion 3, the fallback: a drain that cannot finish inside the
 * quit's bound is sealed. Every run it holds open gets a terminal
 * {@code run_end} in the file before the quit returns, and nothing the drain
 * takes afterwards lands behind it.
 *
 * <p>The drain is made unable to finish the way a client that stopped reading
 * does it: its send does not return while the quit waits.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionQuitSealTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The explore child's system prompt opener, which tells its calls from the parent's. */
    private static final String CHILD_PROMPT_MARKER = "You are a research subagent (type explore)";

    @Test
    void aDrainThatCannotFinishInTimeIsSealedAndWritesNothingAfterItsRunEnd(@TempDir Path workspace)
            throws Exception {
        try (ThinkingFloodBackend backend =
                     new ThinkingFloodBackend(new ThinkingFloodBackend.Shape(0, 150, 90_000))) {
            FakeSocket socket = new FakeSocket("ws-395-seal", "ws://localhost/ws");
            SessionConnection connection = session(workspace, backend.baseUrl(), socket);
            try {
                connection.onUserMessage("think it through", null);
                awaitFrame(socket, "\"thinking_delta\"");
                String sessionId = connection.sessionId();

                sealWhileTheClientIsStuck(connection, socket);
                List<RunEvent> atTheQuit = SessionStore.readSessionEvents(sessionId);
                String rootRun = rootRunId(atTheQuit);
                assertThat(runEndsOf(atTheQuit, rootRun))
                        .as("the run still open at the deadline is closed in the file when the quit returns")
                        .hasSize(1);

                socket.costPerFrame(Duration.ZERO); // the stuck send returns
                awaitDrainFinished(connection);

                List<RunEvent> events = SessionStore.readSessionEvents(sessionId);
                List<Integer> rootEnds = runEndsOf(events, rootRun);
                assertThat(rootEnds).as("the sealed run is closed in the file exactly once").hasSize(1);
                RunEvent.RunEnd end = (RunEvent.RunEnd) events.get(rootEnds.getFirst());
                assertThat(end.stopReason()).as("owner call 2: the existing stop reason")
                        .isEqualTo("aborted");
                assertThat(events.subList(0, rootEnds.getFirst()))
                        .as("positive control: the drain wrote the stream before the seal")
                        .anyMatch(RunEvent.ThinkingDelta.class::isInstance);
                assertThat(events.subList(rootEnds.getFirst() + 1, events.size()))
                        .as("nothing the drain took after the seal lands behind the terminal run_end")
                        .noneMatch(event -> event instanceof RunEvent.ThinkingDelta
                                || event instanceof RunEvent.TextDelta
                                || event instanceof RunEvent.TurnStart
                                || event instanceof RunEvent.RunEnd);
            } finally {
                socket.costPerFrame(Duration.ZERO);
                connection.onClose();
            }
        }
    }

    @Test
    void aSealClosesAChildBeforeTheRunThatSpawnedIt(@TempDir Path workspace) throws Exception {
        HttpServer backend = spawningBackend();
        FakeSocket socket = new FakeSocket("ws-395-seal-child", "ws://localhost/ws");
        SessionConnection connection = session(workspace,
                "http://127.0.0.1:" + backend.getAddress().getPort(), socket);
        try {
            connection.onUserMessage("Delegate: start exactly one explore subagent.", null);
            awaitFrame(socket, "\"run_start\"", "\"agentId\":\"explore-1\"");
            String sessionId = connection.sessionId();

            sealWhileTheClientIsStuck(connection, socket);

            List<RunEvent> events = SessionStore.readSessionEvents(sessionId);
            String rootRun = rootRunId(events);
            String childRun = events.stream()
                    .filter(RunEvent.RunStart.class::isInstance)
                    .map(RunEvent.RunStart.class::cast)
                    .filter(start -> "explore-1".equals(start.agentId()))
                    .map(RunEvent.RunStart::runId)
                    .findFirst().orElseThrow(() -> new AssertionError("test premise: the child's"
                            + " run_start is in the file"));
            List<Integer> childEnds = runEndsOf(events, childRun);
            List<Integer> rootEnds = runEndsOf(events, rootRun);
            assertThat(childEnds).as("the open child run is closed by the seal").hasSize(1);
            assertThat(rootEnds).as("the open root run is closed by the seal").hasSize(1);
            assertThat(childEnds.getFirst())
                    .as("the child closes before the run that spawned it")
                    .isLessThan(rootEnds.getFirst());
        } finally {
            socket.costPerFrame(Duration.ZERO);
            connection.onClose();
            backend.stop(0);
        }
    }

    // ---- helpers --------------------------------------------------------------

    private static SessionConnection session(Path workspace, String baseUrl, FakeSocket socket)
            throws IOException {
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(baseUrl));
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", baseUrl, null, null, workspace.toString()));
        SessionConnection connection = new SessionConnection(socket, JSON, config, null);
        connection.start();
        connection.onSetThinking(true);
        return connection;
    }

    /** The client stops reading, so the drain's next send does not return; then a quit with a short bound. */
    private static void sealWhileTheClientIsStuck(SessionConnection connection, FakeSocket socket)
            throws InterruptedException {
        QuitFlush.Drain drain = connection.drain();
        assertThat(drain).as("test premise: a run is in flight").isNotNull();
        socket.costPerFrame(Duration.ofHours(1));
        Thread.sleep(300);
        QuitFlush.flush(List.of(drain), Duration.ofMillis(300));
    }

    /** Waits for one frame that carries every marker; the file holds that frame's event by then. */
    private static void awaitFrame(FakeSocket socket, String... markers) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            if (socket.frames().stream().anyMatch(frame -> java.util.Arrays.stream(markers)
                    .allMatch(frame.payload()::contains))) {
                return;
            }
            Thread.sleep(10);
        }
        throw new AssertionError("test premise: no frame carries " + java.util.Arrays.toString(markers)
                + "; frames:\n" + socket.textJoined());
    }

    private static void awaitDrainFinished(SessionConnection connection) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (connection.drain() != null && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        assertThat(connection.drain()).as("the run's drain finished").isNull();
    }

    private static String rootRunId(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.RunStart.class::isInstance)
                .map(RunEvent.RunStart.class::cast)
                .filter(start -> start.parentId() == null)
                .map(RunEvent.RunStart::runId)
                .findFirst().orElseThrow();
    }

    private static List<Integer> runEndsOf(List<RunEvent> events, String runId) {
        List<Integer> at = new ArrayList<>();
        for (int i = 0; i < events.size(); i++) {
            if (events.get(i) instanceof RunEvent.RunEnd end && end.runId().equals(runId)) {
                at.add(i);
            }
        }
        return at;
    }

    /**
     * A scripted Ollama: the parent's first call spawns one explore child, the
     * child thinks at 150 lines per second until it is cancelled, and a parent
     * call after the tool result closes the run.
     */
    private static HttpServer spawningBackend() throws IOException {
        HttpServer mock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        mock.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        mock.createContext("/api/chat", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            exchange.sendResponseHeaders(200, 0);
            try (OutputStream out = exchange.getResponseBody()) {
                if (body.contains(CHILD_PROMPT_MARKER)) {
                    for (int i = 0; i < 90_000; i++) {
                        out.write(("{\"message\":{\"role\":\"assistant\",\"content\":\"\",\"thinking\":\""
                                + ThinkingFloodBackend.piece(i) + "\"},\"done\":false}\n")
                                .getBytes(StandardCharsets.UTF_8));
                        out.flush();
                        Thread.sleep(7);
                    }
                } else if (body.contains("\"role\":\"tool\"")) {
                    out.write("""
                            {"message":{"content":"Delegated and done."},"done":false}
                            {"message":{"content":""},"done":true,"prompt_eval_count":9,"eval_count":2}
                            """.getBytes(StandardCharsets.UTF_8));
                } else {
                    out.write("""
                            {"message":{"content":"","tool_calls":[{"function":{"name":"spawn_agent","arguments":{"type":"explore","task":"look around the workspace"}}}]},"done":false}
                            {"message":{"content":""},"done":true,"prompt_eval_count":8,"eval_count":4}
                            """.getBytes(StandardCharsets.UTF_8));
                }
            } catch (IOException | InterruptedException hungUp) {
                // The provider closed the connection: that is how a cancel ends a stream.
            } finally {
                exchange.close();
            }
        });
        mock.start();
        return mock;
    }
}
