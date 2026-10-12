package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 521: the page learns the window its ring divides by from the server,
 * not only from a run. {@code provider_info} carries {@code contextWindow} and
 * {@code windowSource} (additive), on connect, on a resume, on a wake and
 * after a switch of the model, with the values the server derived: the window
 * the operator set for the session, else the window the backend states, else
 * the window the session's own record names for the same model.
 *
 * <p>The backend is a scripted Ollama that answers as ollama 0.32.1 did on
 * 2026-09-24: nothing loaded on {@code /api/ps}, {@code glm-5.3:cloud} marked
 * remote on {@code /api/tags} with a window of 1,048,576 on
 * {@code /api/show}, and {@code qwen3} a local model.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionWindowAnnounceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String TAGS = """
            {"models":[{"name":"glm-5.3:cloud","model":"glm-5.3:cloud","remote_model":"glm-5.3",
              "remote_host":"https://ollama.com","size":293},
             {"name":"qwen3","model":"qwen3","size":5000}]}""";

    private static final String SHOW = "{\"model_info\":{\"general.architecture\":\"glm_dsa_moe\","
            + "\"glm_dsa_moe.context_length\":1048576},\"capabilities\":[\"completion\",\"tools\"]}";

    private HttpServer mock;
    private final List<String> written = new ArrayList<>();

    @AfterEach
    void cleanUp() throws IOException {
        if (mock != null) {
            mock.stop(0);
        }
        for (String id : written) {
            Files.deleteIfExists(SessionStore.SESSIONS_DIR.resolve(id + ".jsonl"));
        }
    }

    private void route(String path, String body) {
        mock.createContext(path, (HttpExchange exchange) -> {
            exchange.getRequestBody().readAllBytes();
            byte[] answer = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
    }

    private SpectroConfig config() throws IOException {
        if (mock == null) {
            mock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            route("/api/ps", "{\"models\":[]}");
            route("/api/tags", TAGS);
            route("/api/show", SHOW);
            route("/api/chat", """
                    {"message":{"content":"ok"},"done":false}
                    {"message":{"content":""},"done":true,"prompt_eval_count":12,"eval_count":3}
                    """);
            mock.start();
        }
        String baseUrl = "http://127.0.0.1:" + mock.getAddress().getPort();
        return SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3", baseUrl, null, null, null));
    }

    private String stored(String id, String body) throws IOException {
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Files.writeString(SessionStore.sessionFile(id), body);
        written.add(id);
        return id;
    }

    /** A main run on {@code provider}/{@code model} whose run_start names {@code window}, plus a child's run. */
    private static String run(String provider, String model, int window, String source) {
        return """
                {"type":"run_start","runId":"r1","agentId":"main","prompt":"first","provider":"%1$s","model":"%2$s","contextWindow":%3$d,"windowSource":"%4$s","ts":1}
                {"type":"usage","agentId":"main","inputTokens":300000,"outputTokens":5,"ts":2}
                {"type":"run_start","runId":"c1","agentId":"worker","parentId":"main","prompt":"sub","provider":"%1$s","model":"%2$s","contextWindow":8192,"windowSource":"window","ts":3}
                {"type":"run_end","runId":"c1","stopReason":"end_turn","ts":4}
                {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":5}
                """.formatted(provider, model, window, source);
    }

    /**
     * A main run recorded before card 521: its run_start names no window, and
     * the window arrives on the main agent's later context_info. A child's
     * context_info with another window comes last.
     */
    private static String runBefore521(String provider, String model) {
        return """
                {"type":"run_start","runId":"r1","agentId":"main","prompt":"first","provider":"%1$s","model":"%2$s","ts":1}
                {"type":"context_info","agentId":"main","turn":1,"messages":1,"estimatedTokens":9,"threshold":175257,"parts":[],"ts":2,"thresholdSource":"window","contextWindow":250368}
                {"type":"run_start","runId":"c1","agentId":"worker","parentId":"main","prompt":"sub","provider":"%1$s","model":"%2$s","ts":3}
                {"type":"context_info","agentId":"worker","turn":1,"messages":1,"estimatedTokens":9,"threshold":5734,"parts":[],"ts":4,"thresholdSource":"model","contextWindow":8192}
                {"type":"run_end","runId":"c1","stopReason":"end_turn","ts":5}
                {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":6}
                """.formatted(provider, model);
    }

    private static List<JsonNode> providerInfos(FakeSocket socket) {
        List<JsonNode> out = new ArrayList<>();
        for (String line : socket.textJoined().lines().toList()) {
            try {
                JsonNode node = JSON.readTree(line);
                if ("provider_info".equals(node.path("type").asText())) {
                    out.add(node);
                }
            } catch (IOException notJson) {
                // not a frame this test reads
            }
        }
        return out;
    }

    private static JsonNode lastProviderInfo(FakeSocket socket) {
        List<JsonNode> all = providerInfos(socket);
        assertThat(all).as("at least one provider_info: %s", socket.textJoined()).isNotEmpty();
        return all.getLast();
    }

    @Test
    void aWakeAnnouncesTheWindowTheSessionsRecordNamesForItsModel() throws Exception {
        String id = stored("20261011-090000-w521wake", run("ollama", "qwen3", 1_000_000, "model"));
        FakeSocket socket = new FakeSocket("ws-521-wake", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config(), null, null, new LiveSessions());
        connection.start();
        int before = providerInfos(socket).size();

        connection.onWakeSession(id);

        assertThat(providerInfos(socket)).as("a wake announces the backend and its window").hasSize(before + 1);
        JsonNode info = lastProviderInfo(socket);
        assertThat(info.path("model").asText()).isEqualTo("qwen3");
        assertThat(info.path("contextWindow").asInt()).as("the main run's window, not the child's")
                .isEqualTo(1_000_000);
        assertThat(info.path("windowSource").asText()).isEqualTo("model");
    }

    @Test
    void aWakeAnnouncesTheWindowTheOperatorSetForTheSession() throws Exception {
        String id = stored("20261011-090100-w521over", run("ollama", "qwen3", 32_768, "window")
                + "{\"type\":\"window_override\",\"tokens\":400000,\"threshold\":280000,"
                + "\"thresholdSource\":\"window_override\",\"contextWindow\":400000,\"ts\":6}\n");
        FakeSocket socket = new FakeSocket("ws-521-over", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config(), null, null, new LiveSessions());
        connection.start();

        connection.onWakeSession(id);

        JsonNode info = lastProviderInfo(socket);
        assertThat(info.path("contextWindow").asInt()).isEqualTo(400_000);
        assertThat(info.path("windowSource").asText()).isEqualTo("window_override");
    }

    @Test
    void aWakeAnnouncesTheSetWindowEvenWhenTheRecordedBackendCannotRun() throws Exception {
        // The backend stays the connect-time one, so nothing about the
        // provider changes; the window set for the session still has to reach
        // the ring.
        String id = stored("20261011-090150-w521keep", run("retired-provider", "old-model", 32_768, "window")
                + "{\"type\":\"window_override\",\"tokens\":400000,\"threshold\":280000,"
                + "\"thresholdSource\":\"window_override\",\"contextWindow\":400000,\"ts\":6}\n");
        FakeSocket socket = new FakeSocket("ws-521-keep", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config(), null, null, new LiveSessions());
        connection.start();
        int before = providerInfos(socket).size();

        connection.onWakeSession(id);

        assertThat(providerInfos(socket)).as("the wake announces, whether or not the backend moved")
                .hasSize(before + 1);
        JsonNode info = lastProviderInfo(socket);
        assertThat(info.path("model").asText()).isEqualTo("qwen3");
        assertThat(info.path("contextWindow").asInt()).isEqualTo(400_000);
        assertThat(info.path("windowSource").asText()).isEqualTo("window_override");
    }

    @Test
    void aResumeAnnouncesTheRecordedWindowWithItsFirstFrame() throws Exception {
        String id = stored("20261011-090200-w521resu", run("ollama", "qwen3", 32_768, "window"));
        FakeSocket socket = new FakeSocket("ws-521-resume", "ws://localhost/ws?resume=" + id);

        new SessionConnection(socket, JSON, config(), id, null, new LiveSessions()).start();

        List<JsonNode> infos = providerInfos(socket);
        assertThat(infos).isNotEmpty();
        assertThat(infos.getFirst().path("contextWindow").asInt()).isEqualTo(32_768);
        assertThat(infos.getFirst().path("windowSource").asText()).isEqualTo("window");
    }

    @Test
    void aWindowRecordedForAnotherModelIsNotAnnouncedForThisOne() throws Exception {
        // The recorded backend cannot run here any more, so the session starts
        // on qwen3; the window its record names belongs to a different model.
        String id = stored("20261011-090300-w521othr", run("retired-provider", "old-model", 1_000_000, "model"));
        FakeSocket socket = new FakeSocket("ws-521-other", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config(), null, null, new LiveSessions());
        connection.start();

        connection.onWakeSession(id);

        JsonNode info = lastProviderInfo(socket);
        assertThat(info.path("model").asText()).isEqualTo("qwen3");
        assertThat(info.has("contextWindow")).as("no window is known for qwen3").isFalse();
        assertThat(info.path("windowSource").asText()).isEqualTo("fallback");
    }

    @Test
    void theWindowASwitchLearnedIsNotUnsaidAtTheFirstMessage() throws Exception {
        // Measured live on 2026-10-11: the session moment re-announces the
        // backend before the first run_start, and it named no window for a
        // cloud model the switch had just announced at 512,000.
        FakeSocket socket = new FakeSocket("ws-521-moment", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config(), null);
        connection.start();
        assertThat(connection.switchProvider("ollama", "glm-5.3:cloud")).isNull();
        int afterSwitch = providerInfos(socket).size();

        connection.onUserMessage("hello", null);
        long deadline = System.currentTimeMillis() + 30_000;
        while (!socket.textJoined().contains("\"type\":\"run_end\"")) {
            if (System.currentTimeMillis() > deadline) {
                throw new AssertionError("no run_end in: " + socket.textJoined());
            }
            Thread.sleep(50);
        }

        List<JsonNode> later = providerInfos(socket).subList(afterSwitch, providerInfos(socket).size());
        assertThat(later).as("premise: the session moment announces the backend again").isNotEmpty();
        for (JsonNode info : later) {
            assertThat(info.path("contextWindow").asInt()).isEqualTo(1_048_576);
            assertThat(info.path("windowSource").asText()).isEqualTo("model");
        }
    }

    @Test
    void aSwitchBeforeTheFirstRunMovesTheRingToTheWindowTheNewModelPublishes() throws Exception {
        FakeSocket socket = new FakeSocket("ws-521-switch", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config(), null);
        connection.start();
        assertThat(lastProviderInfo(socket).has("contextWindow"))
                .as("premise: the local model on connect states no window").isFalse();

        assertThat(connection.switchProvider("ollama", "glm-5.3:cloud")).isNull();

        JsonNode cloud = lastProviderInfo(socket);
        assertThat(cloud.path("model").asText()).isEqualTo("glm-5.3:cloud");
        assertThat(cloud.path("contextWindow").asInt()).isEqualTo(1_048_576);
        assertThat(cloud.path("windowSource").asText()).isEqualTo("model");

        assertThat(connection.switchProvider("ollama", "qwen3")).isNull();

        JsonNode local = lastProviderInfo(socket);
        assertThat(local.path("model").asText()).isEqualTo("qwen3");
        assertThat(local.has("contextWindow")).as("back on a model that publishes none").isFalse();
        assertThat(local.path("windowSource").asText()).isEqualTo("fallback");
    }

    @Test
    void aWakeOfASessionRecordedBefore521AnnouncesTheWindowOfItsMainContextInfo() throws Exception {
        String id = stored("20261011-090400-w521oldw", runBefore521("ollama", "qwen3"));
        FakeSocket socket = new FakeSocket("ws-521-oldwake", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config(), null, null, new LiveSessions());
        connection.start();
        int before = providerInfos(socket).size();

        connection.onWakeSession(id);

        assertThat(providerInfos(socket)).hasSize(before + 1);
        JsonNode info = lastProviderInfo(socket);
        assertThat(info.path("model").asText()).isEqualTo("qwen3");
        assertThat(info.path("contextWindow").asInt()).as("the main agent's window, not the child's 8,192")
                .isEqualTo(250_368);
        assertThat(info.path("windowSource").asText()).isEqualTo("window");
    }

    @Test
    void aResumeOfASessionRecordedBefore521AnnouncesTheWindowOfItsMainContextInfo() throws Exception {
        String id = stored("20261011-090500-w521oldr", runBefore521("ollama", "qwen3"));
        FakeSocket socket = new FakeSocket("ws-521-oldresume", "ws://localhost/ws?resume=" + id);

        new SessionConnection(socket, JSON, config(), id, null, new LiveSessions()).start();

        List<JsonNode> infos = providerInfos(socket);
        assertThat(infos).isNotEmpty();
        assertThat(infos.getFirst().path("contextWindow").asInt()).as("the main agent's window, not the child's 8,192")
                .isEqualTo(250_368);
        assertThat(infos.getFirst().path("windowSource").asText()).isEqualTo("window");
    }
}
