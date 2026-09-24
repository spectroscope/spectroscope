package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.AfterEach;
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
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 391 on the face the owner uses: a browser session on an Ollama cloud
 * model, through a real {@link SessionConnection}, so the provider the run
 * holds is the one a session builds (the retry wrapper, the logging proxy and
 * the mid-session switch around {@code OllamaProvider}).
 *
 * <p>The scripted Ollama answers as ollama 0.32.1 did on 2026-09-24 for
 * {@code glm-5.3:cloud}: nothing on {@code /api/ps}, the model marked remote on
 * {@code /api/tags}, {@code glm_dsa_moe.context_length} 1,048,576 on
 * {@code /api/show}.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class OllamaCloudWindowThroughTheDoorTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String TAGS = """
            {"models":[{"name":"glm-5.3:cloud","model":"glm-5.3:cloud","remote_model":"glm-5.3",
              "remote_host":"https://ollama.com","size":293}]}""";

    private static final String SHOW = "{\"model_info\":{\"general.architecture\":\"glm_dsa_moe\","
            + "\"general.parameter_count\":753329940480,\"glm_dsa_moe.context_length\":1048576,"
            + "\"glm_dsa_moe.embedding_length\":0},\"capabilities\":[\"completion\",\"thinking\",\"tools\"]}";

    private static final String CHAT = """
            {"message":{"content":"hello back"},"done":false}
            {"message":{"content":""},"done":true,"prompt_eval_count":12,"eval_count":3}
            """;

    private HttpServer mock;
    private final Map<String, AtomicInteger> hits = new ConcurrentHashMap<>();

    @AfterEach
    void stopMock() {
        if (mock != null) {
            mock.stop(0);
        }
    }

    private void route(String path, String contentType, String body) {
        hits.put(path, new AtomicInteger());
        mock.createContext(path, (HttpExchange exchange) -> {
            hits.get(path).incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            byte[] answer = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", contentType);
            exchange.sendResponseHeaders(200, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
    }

    private String startCloudOllama() throws IOException {
        mock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        route("/api/ps", "application/json", "{\"models\":[]}");
        route("/api/tags", "application/json", TAGS);
        route("/api/show", "application/json", SHOW);
        route("/api/chat", "application/x-ndjson", CHAT);
        mock.start();
        return "http://127.0.0.1:" + mock.getAddress().getPort();
    }

    private static List<JsonNode> frames(FakeSocket socket, String type) {
        return socket.textJoined().lines()
                .map(OllamaCloudWindowThroughTheDoorTest::parse)
                .filter(node -> type.equals(node.path("type").asText()))
                .toList();
    }

    private static JsonNode parse(String line) {
        try {
            return JSON.readTree(line);
        } catch (IOException notJson) {
            return JSON.createObjectNode();
        }
    }

    /** A connection on the scripted cloud model that has finished one prompt. */
    private SessionConnection afterOnePrompt(FakeSocket socket, Path workspace) throws Exception {
        String baseUrl = startCloudOllama();
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "glm-5.3:cloud", "baseUrl": "%s" }
                """.formatted(baseUrl));
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "glm-5.3:cloud", baseUrl, null, null, workspace.toString()));
        SessionConnection connection = new SessionConnection(socket, JSON, config, null);
        connection.start();
        connection.onUserMessage("hello", null);
        long deadline = System.currentTimeMillis() + 30_000;
        while (frames(socket, "run_end").isEmpty()) {
            if (System.currentTimeMillis() > deadline) {
                throw new AssertionError("no run_end in: " + socket.textJoined());
            }
            Thread.sleep(50);
        }
        return connection;
    }

    @Test
    void aRunOnACloudModelDerivesItsThresholdFromTheWindowOllamaPublishes(@TempDir Path workspace)
            throws Exception {
        FakeSocket socket = new FakeSocket("ws-391-run", "ws://localhost/ws");

        afterOnePrompt(socket, workspace);

        JsonNode info = frames(socket, "context_info").getFirst();
        assertThat(info.path("threshold").asInt()).isEqualTo(734_003);
        assertThat(info.path("thresholdSource").asText()).isEqualTo("model");
        assertThat(info.path("contextWindow").asInt()).isEqualTo(1_048_576);
        assertThat(hits.get("/api/show").get()).as("one show question for the session").isEqualTo(1);
    }

    @Test
    void aClearedSessionWindowHandsBackToThePublishedWindowAtOnce(@TempDir Path workspace)
            throws Exception {
        FakeSocket socket = new FakeSocket("ws-391-clear", "ws://localhost/ws");
        SessionConnection connection = afterOnePrompt(socket, workspace);

        connection.onSetWindowOverride(JSON.createObjectNode().numberNode(512_000));
        connection.onSetWindowOverride(JSON.nullNode());

        List<JsonNode> answers = frames(socket, "window_override");
        assertThat(answers).hasSize(2);
        JsonNode cleared = answers.get(1);
        assertThat(cleared.has("tokens")).as("a clear carries no tokens").isFalse();
        assertThat(cleared.path("threshold").asInt()).isEqualTo(734_003);
        assertThat(cleared.path("thresholdSource").asText()).isEqualTo("model");
        assertThat(cleared.path("contextWindow").asInt()).isEqualTo(1_048_576);
    }
}
