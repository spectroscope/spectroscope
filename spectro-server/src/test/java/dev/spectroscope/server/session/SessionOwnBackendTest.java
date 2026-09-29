package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
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
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 459, the owner's added requirement of 2026-09-29: sessions that run at
 * once in one window are independent, provider and model included. One on a
 * local model, one on a cloud model, one on another API; a message sent in one
 * session never goes out with another session's backend.
 *
 * <p>Two loopback backends stand in for two providers; nothing leaves the
 * machine. Each counts the requests it served and the model each named.</p>
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionOwnBackendTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path workspaceA;

    @TempDir
    Path workspaceB;

    /** A loopback ollama that can hold its answer until told to give it. */
    private static final class Backend implements AutoCloseable {
        final HttpServer server;
        final List<String> models = new CopyOnWriteArrayList<>();
        final CountDownLatch release;

        Backend(boolean holdAnswers) throws IOException {
            release = new CountDownLatch(holdAnswers ? 1 : 0);
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
            if (!system.equals(SessionTitles.INSTRUCTION)) {
                models.add(body.path("model").asText());
                try {
                    release.await(60, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            exchange.getResponseHeaders().set("Content-Type", "application/x-ndjson");
            exchange.sendResponseHeaders(200, 0);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(("{\"message\":{\"role\":\"assistant\",\"content\":\"ok\"},\"done\":false}\n")
                        .getBytes(StandardCharsets.UTF_8));
                out.write(("{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,"
                        + "\"done_reason\":\"stop\",\"prompt_eval_count\":9,\"eval_count\":3}\n")
                        .getBytes(StandardCharsets.UTF_8));
            }
        }

        @Override
        public void close() {
            release.countDown();
            server.stop(0);
        }
    }

    /** A connection whose workspace names its own provider, model and address. */
    private static SessionConnection connectIn(Path workspace, Backend backend, String model, FakeSocket socket)
            throws IOException {
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "%s", "baseUrl": "%s" }
                """.formatted(model, backend.baseUrl()));
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", model, backend.baseUrl(), null, null, workspace.toString()));
        SessionConnection connection = new SessionConnection(socket, JSON, config, null);
        connection.start();
        return connection;
    }

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

    private static void awaitRequests(Backend backend, int count) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (backend.models.size() < count && System.nanoTime() < deadline) {
            Thread.sleep(20);
        }
        assertThat(backend.models).as("the backend was asked").hasSizeGreaterThanOrEqualTo(count);
    }

    @Test
    void twoSessionsRunAtOnceEachOnItsOwnBackendAndModel() throws Exception {
        try (Backend slow = new Backend(true); Backend quick = new Backend(false)) {
            FakeSocket socketA = new FakeSocket("ws-459-a", "ws://localhost/ws");
            FakeSocket socketB = new FakeSocket("ws-459-b", "ws://localhost/ws");
            SessionConnection a = connectIn(workspaceA, slow, "model-a", socketA);
            SessionConnection b = connectIn(workspaceB, quick, "model-b", socketB);
            try {
                a.onUserMessage("a long job", null);
                awaitRequests(slow, 1); // A is now waiting on its own backend

                b.onUserMessage("a short question", null);
                awaitRunEnds(socketB, 1);
                assertThat(runEnds(socketA)).as("B finished while A was still running").isZero();

                slow.release.countDown();
                awaitRunEnds(socketA, 1);

                assertThat(slow.models).as("A's backend served only A's model").containsOnly("model-a");
                assertThat(quick.models).as("B's backend served only B's model").containsOnly("model-b");
                assertThat(a.sessionId()).isNotEqualTo(b.sessionId());
            } finally {
                a.onClose();
                b.onClose();
            }
        }
    }

    @Test
    void aSessionKeepsTheModelItAnnouncedWhenTheUserDefaultChangesBeforeItsFirstPrompt() throws Exception {
        Path user = SpectroConfig.USER_SETTINGS_PATH;
        byte[] before = Files.exists(user) ? Files.readAllBytes(user) : null;
        try (Backend backend = new Backend(false)) {
            Files.createDirectories(user.getParent());
            Files.writeString(user, """
                    { "provider": "ollama", "model": "model-a", "baseUrl": "%s" }
                    """.formatted(backend.baseUrl()));
            // The connect-time snapshot as the socket handler takes it: the user
            // scope, and a workspace whose own settings name no backend.
            SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                    null, null, null, null, null, workspaceA.toString()));
            assertThat(config.model()).isEqualTo("model-a");
            FakeSocket socket = new FakeSocket("ws-459-default", "ws://localhost/ws");
            SessionConnection connection = new SessionConnection(socket, JSON, config, null);
            connection.start();
            try {
                assertThat(socket.textJoined()).as("the chip names model-a").contains("\"model\":\"model-a\"");
                // Another session's confirmed switch saves its pair as the default
                // for new chats. This session announced model-a and keeps it.
                Files.writeString(user, """
                        { "provider": "ollama", "model": "model-b", "baseUrl": "%s" }
                        """.formatted(backend.baseUrl()));

                connection.onUserMessage("hello", null);
                awaitRunEnds(socket, 1);

                assertThat(backend.models).as("the run went out with the model this session announced")
                        .isNotEmpty()
                        .containsOnly("model-a");
            } finally {
                connection.onClose();
            }
        } finally {
            if (before == null) {
                Files.deleteIfExists(user);
            } else {
                Files.write(user, before);
            }
        }
    }

    @Test
    void aWorkspaceThatNamesItsOwnModelStillWinsOverTheConnectSnapshot() throws Exception {
        try (Backend backend = new Backend(false)) {
            Files.createDirectories(workspaceB.resolve(".spectro"));
            Files.writeString(workspaceB.resolve(".spectro/settings.json"), """
                    { "provider": "ollama", "model": "workspace-model", "baseUrl": "%s" }
                    """.formatted(backend.baseUrl()));
            SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                    "ollama", "connect-model", backend.baseUrl(), null, null, workspaceB.toString()));
            FakeSocket socket = new FakeSocket("ws-459-ws", "ws://localhost/ws");
            SessionConnection connection = new SessionConnection(socket, JSON, config, null);
            connection.start();
            try {
                connection.onUserMessage("hello", null);
                awaitRunEnds(socket, 1);
                assertThat(backend.models).isNotEmpty().containsOnly("workspace-model");
            } finally {
                connection.onClose();
            }
        }
    }
}
