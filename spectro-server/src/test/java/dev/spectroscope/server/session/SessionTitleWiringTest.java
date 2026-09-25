package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
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
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 445, criterion 6 on the real session path: a new session's first run
 * asks the session's own model for a title in the background, and the run
 * does not wait for it.
 *
 * <p>The model is a scripted Ollama on loopback. It answers the run at once
 * and HOLDS the title request until the test lets it go, so the run's end
 * arriving first is a measurement, not a race the test happened to win.</p>
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionTitleWiringTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path workspace;

    @TempDir
    Path metaHome;

    /** A scripted Ollama: the run gets "ok" at once, the title waits for a latch. */
    private static final class Backend implements AutoCloseable {
        final HttpServer server;
        final List<JsonNode> titleRequests = new CopyOnWriteArrayList<>();
        final List<JsonNode> runRequests = new CopyOnWriteArrayList<>();
        final CountDownLatch releaseTitle = new CountDownLatch(1);
        /** When the title request got its answer; zero while it is held. */
        volatile long titleAnsweredAt;

        Backend() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
            server.createContext("/api/chat", this::answer);
            server.start();
        }

        String baseUrl() {
            return "http://127.0.0.1:" + server.getAddress().getPort();
        }

        private void answer(HttpExchange exchange) throws IOException {
            JsonNode body = JSON.readTree(exchange.getRequestBody().readAllBytes());
            String system = body.path("messages").path(0).path("content").asText("");
            String content;
            if (system.equals(SessionTitles.INSTRUCTION)) {
                titleRequests.add(body);
                try {
                    releaseTitle.await(30, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                titleAnsweredAt = System.nanoTime();
                content = "Subagenten und Workflows Review";
            } else {
                runRequests.add(body);
                content = "ok";
            }
            exchange.getResponseHeaders().set("Content-Type", "application/x-ndjson");
            exchange.sendResponseHeaders(200, 0);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(("{\"message\":{\"role\":\"assistant\",\"content\":" + JSON.writeValueAsString(content)
                        + "},\"done\":false}\n").getBytes(StandardCharsets.UTF_8));
                out.write(("{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,"
                        + "\"done_reason\":\"stop\",\"prompt_eval_count\":9,\"eval_count\":3}\n")
                        .getBytes(StandardCharsets.UTF_8));
            }
        }

        @Override
        public void close() {
            releaseTitle.countDown();
            server.stop(0);
        }
    }

    private SessionConnection connect(Backend backend, FakeSocket socket, String resumeId) throws IOException {
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(backend.baseUrl()));
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", backend.baseUrl(), null, null, workspace.toString()));
        SessionConnection connection = new SessionConnection(socket, JSON, config, resumeId);
        connection.useTitles(new SessionTitles(meta(), SessionTitles.TIME_LIMIT));
        connection.start();
        return connection;
    }

    private SessionMetaStore meta() {
        return new SessionMetaStore(metaHome.resolve("session-meta.json"));
    }

    /** How many run_end frames the socket has seen. */
    private static long runEnds(FakeSocket socket) {
        return socket.frames().stream()
                .map(FakeSocket.Frame::payload)
                .filter(payload -> payload.contains("\"type\":\"run_end\""))
                .count();
    }

    private static void awaitRunEnds(FakeSocket socket, long count) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (runEnds(socket) < count && System.nanoTime() < deadline) {
            Thread.sleep(20);
        }
        assertThat(runEnds(socket)).as("the run ended").isGreaterThanOrEqualTo(count);
    }

    @Test
    void theFirstRunOfANewSessionAsksForATitleAndDoesNotWaitForIt() throws Exception {
        try (Backend backend = new Backend()) {
            FakeSocket socket = new FakeSocket("ws-445-title", "ws://localhost/ws");
            SessionConnection connection = connect(backend, socket, null);
            try {
                connection.onUserMessage(SessionTitlesTest.OWNERS_PROMPT, null);
                awaitRunEnds(socket, 1);

                assertThat(backend.titleAnsweredAt)
                        .as("the run ended while the title request was still held by the model")
                        .isZero();
                assertThat(backend.titleRequests).as("one title request").hasSize(1);

                JsonNode title = backend.titleRequests.getFirst();
                assertThat(title.path("model").asText()).as("the session's own model").isEqualTo("qwen3");
                assertThat(title.path("think").isBoolean() && !title.path("think").asBoolean())
                        .as("thinking off on the wire").isTrue();
                assertThat(title.path("options").path("num_predict").asInt())
                        .isEqualTo(SessionTitles.MAX_OUTPUT_TOKENS);
                assertThat(title.path("messages")).hasSize(2);
                assertThat(title.path("messages").path(1).path("role").asText()).isEqualTo("user");
                assertThat(title.path("messages").path(1).path("content").asText())
                        .as("the first prompt only").isEqualTo(SessionTitlesTest.OWNERS_PROMPT);
                assertThat(title.path("tools").isMissingNode() || title.path("tools").isNull()
                        || title.path("tools").isEmpty()).as("no tools").isTrue();

                backend.releaseTitle.countDown();
                String id = connection.sessionId();
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
                while (meta().get(id).isEmpty() && System.nanoTime() < deadline) {
                    Thread.sleep(20);
                }
                SessionMetaStore.Entry entry = meta().get(id).orElseThrow();
                assertThat(entry.title()).isEqualTo("Subagenten und Workflows Review");
                assertThat(entry.titleSource()).isEqualTo(SessionMetaStore.SUGGESTED);

                connection.onUserMessage("and one more thing", null);
                awaitRunEnds(socket, 2);
                assertThat(backend.titleRequests).as("once per session, not once per prompt").hasSize(1);
                assertThat(backend.runRequests).as("both runs reached the model").hasSizeGreaterThanOrEqualTo(2);
            } finally {
                connection.onClose();
            }
        }
    }

    @Test
    void aResumedSessionIsNotAskedAboutAgain() throws Exception {
        String id = "20260925-120000-" + UUID.randomUUID().toString().substring(0, 8);
        SessionStore stored = new SessionStore(id);
        stored.append(new RunEvent.RunStart("prior", "main", null, "earlier work", "ollama", "qwen3",
                null, null, null, 1L));
        stored.append(new RunEvent.RunEnd("prior", "end_turn", 2L));

        try (Backend backend = new Backend()) {
            FakeSocket socket = new FakeSocket("ws-445-resume", "ws://localhost/ws");
            SessionConnection connection = connect(backend, socket, id);
            try {
                connection.onUserMessage("carry on", null);
                awaitRunEnds(socket, 1);
                Thread.sleep(300);
                assertThat(backend.runRequests).as("the run reached the model").isNotEmpty();
                assertThat(backend.titleRequests).as("a resumed session keeps what it has").isEmpty();
                assertThat(meta().get(id)).isEmpty();
            } finally {
                connection.onClose();
            }
        }
    }
}
