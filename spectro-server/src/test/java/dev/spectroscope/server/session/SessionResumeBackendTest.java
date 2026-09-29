package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Release 0.14.2, live check defect D1: a stored session continued after a
 * reload ran on the window's last saved model instead of its own.
 *
 * <p>The owner's requirement on card 459 is that sessions are independent,
 * provider and model included. A fresh session keeps the pair it announced
 * ({@link SessionOwnBackendTest}); a resumed session starts on the pair its
 * own record names, the way it already takes its workspace and its context
 * window from the record. A workspace settings file that names a backend
 * still decides, as it does for a fresh session.</p>
 *
 * <p>One loopback ollama stands in for the backend and records the model each
 * request named; nothing leaves the machine.</p>
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionResumeBackendTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path workspace;

    private HttpServer server;
    private final List<String> models = new CopyOnWriteArrayList<>();
    private final List<String> written = new ArrayList<>();
    private byte[] userBefore;

    @BeforeEach
    void startBackendAndSetTheUserDefault() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/api/chat", this::answer);
        server.start();
        Path user = SpectroConfig.USER_SETTINGS_PATH;
        userBefore = Files.exists(user) ? Files.readAllBytes(user) : null;
        Files.createDirectories(user.getParent());
        // Another session's confirmed switch saved this pair as the default
        // for NEW chats. A stored session that ran on model-a must not follow it.
        Files.writeString(user, """
                { "provider": "ollama", "model": "model-b", "baseUrl": "%s" }
                """.formatted(baseUrl()));
    }

    @AfterEach
    void restore() throws IOException {
        server.stop(0);
        for (String id : written) {
            Files.deleteIfExists(SessionStore.sessionFile(id));
        }
        Path user = SpectroConfig.USER_SETTINGS_PATH;
        if (userBefore == null) {
            Files.deleteIfExists(user);
        } else {
            Files.write(user, userBefore);
        }
    }

    private String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private void answer(HttpExchange exchange) throws IOException {
        JsonNode body = JSON.readTree(exchange.getRequestBody().readAllBytes());
        String system = body.path("messages").path(0).path("content").asText("");
        if (!system.equals(SessionTitles.INSTRUCTION)) {
            models.add(body.path("model").asText());
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

    /** A stored session file whose runs name the given provider/model pairs, main runs first. */
    private String storedSession(String id, String... lines) throws IOException {
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Files.writeString(SessionStore.sessionFile(id), String.join("\n", lines) + "\n");
        written.add(id);
        return id;
    }

    private String mainRun(String runId, String provider, String model, long ts) {
        return ("{\"type\":\"run_start\",\"runId\":\"%s\",\"agentId\":\"main\",\"prompt\":\"hi\","
                + "\"provider\":\"%s\",\"model\":\"%s\",\"workspace\":\"%s\",\"ts\":%d}\n"
                + "{\"type\":\"run_end\",\"runId\":\"%s\",\"stopReason\":\"end_turn\",\"ts\":%d}")
                .formatted(runId, provider, model, workspace.toString().replace("\\", "\\\\"), ts, runId, ts + 1);
    }

    /** The connect-time snapshot exactly as the socket handler takes it. */
    private SessionConnection resume(String id, FakeSocket socket) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none());
        assertThat(config.model()).as("the user default the window saved last").isEqualTo("model-b");
        SessionConnection connection = new SessionConnection(socket, JSON, config, id);
        connection.start();
        return connection;
    }

    private static List<String> announcedModels(FakeSocket socket) {
        List<String> out = new ArrayList<>();
        for (FakeSocket.Frame frame : socket.frames()) {
            try {
                JsonNode node = JSON.readTree(frame.payload());
                if ("provider_info".equals(node.path("type").asText())) {
                    out.add(node.path("model").asText());
                }
            } catch (IOException notJson) {
                // not a frame this test reads
            }
        }
        return out;
    }

    private static List<String> runStartModels(FakeSocket socket) {
        List<String> out = new ArrayList<>();
        for (FakeSocket.Frame frame : socket.frames()) {
            try {
                JsonNode node = JSON.readTree(frame.payload());
                if ("run_start".equals(node.path("type").asText())) {
                    out.add(node.path("model").asText());
                }
            } catch (IOException notJson) {
                // not a frame this test reads
            }
        }
        return out;
    }

    private static void awaitRunEnd(FakeSocket socket) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (!socket.textJoined().contains("\"type\":\"run_end\"") && System.nanoTime() < deadline) {
            Thread.sleep(20);
        }
        assertThat(socket.textJoined()).as("the continued run ended").contains("\"type\":\"run_end\"");
    }

    @Test
    void aResumedSessionAnnouncesAndRunsOnThePairItsRecordNamesNotTheUserDefault() throws Exception {
        String id = storedSession("20260929-050000-d1own001", mainRun("r1", "ollama", "model-a", 1));
        FakeSocket socket = new FakeSocket("ws-d1-own", "ws://localhost/ws");
        SessionConnection connection = resume(id, socket);
        try {
            assertThat(announcedModels(socket))
                    .as("the header learns the session's own model on connect, before any prompt")
                    .isNotEmpty()
                    .containsOnly("model-a");

            connection.onUserMessage("one more short sentence", null);
            awaitRunEnd(socket);

            assertThat(models).as("the continuation went out with the session's own model")
                    .isNotEmpty()
                    .containsOnly("model-a");
            assertThat(runStartModels(socket)).as("the record of the continuation names it too")
                    .containsOnly("model-a");
            assertThat(announcedModels(socket)).as("no frame ever named the user default").doesNotContain("model-b");
        } finally {
            connection.onClose();
        }
    }

    @Test
    void theLastMainRunDecidesSoASwitchInsideTheSessionSurvivesTheReload() throws Exception {
        String child = "{\"type\":\"run_start\",\"runId\":\"c1\",\"agentId\":\"worker\",\"parentId\":\"main\","
                + "\"prompt\":\"sub\",\"provider\":\"ollama\",\"model\":\"child-model\",\"ts\":7}";
        String id = storedSession("20260929-050000-d1last01",
                mainRun("r1", "ollama", "model-a", 1),
                mainRun("r2", "ollama", "model-c", 4),
                child);
        FakeSocket socket = new FakeSocket("ws-d1-last", "ws://localhost/ws");
        SessionConnection connection = resume(id, socket);
        try {
            assertThat(announcedModels(socket)).isNotEmpty().containsOnly("model-c");
            connection.onUserMessage("again", null);
            awaitRunEnd(socket);
            assertThat(models).as("the last main run's model; a child's run does not decide")
                    .isNotEmpty()
                    .containsOnly("model-c");
        } finally {
            connection.onClose();
        }
    }

    @Test
    void aWorkspaceThatNamesItsOwnBackendStillWinsOnResume() throws Exception {
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "workspace-model", "baseUrl": "%s" }
                """.formatted(baseUrl()));
        String id = storedSession("20260929-050000-d1wksp01", mainRun("r1", "ollama", "model-a", 1));
        FakeSocket socket = new FakeSocket("ws-d1-ws", "ws://localhost/ws");
        SessionConnection connection = resume(id, socket);
        try {
            connection.onUserMessage("hello", null);
            awaitRunEnd(socket);
            assertThat(models).isNotEmpty().containsOnly("workspace-model");
            assertThat(announcedModels(socket)).as("the header follows the workspace at the session moment")
                    .last().isEqualTo("workspace-model");
        } finally {
            connection.onClose();
        }
    }

    @Test
    void aRecordedProviderThatCannotRunAnyMoreFallsBackToTheFreshSessionPairAndSaysWhich() throws Exception {
        String id = storedSession("20260929-050000-d1gone01", mainRun("r1", "retired-provider", "old-model", 1));
        FakeSocket socket = new FakeSocket("ws-d1-gone", "ws://localhost/ws");
        SessionConnection connection = resume(id, socket);
        try {
            assertThat(announcedModels(socket))
                    .as("the header names the pair that will run, the one a fresh session gets")
                    .isNotEmpty()
                    .containsOnly("model-b");
            connection.onUserMessage("hello", null);
            awaitRunEnd(socket);
            assertThat(models).isNotEmpty().containsOnly("model-b");
        } finally {
            connection.onClose();
        }
    }
}
