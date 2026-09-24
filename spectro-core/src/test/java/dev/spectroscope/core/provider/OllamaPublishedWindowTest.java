package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 391 on the wire: what {@code OllamaProvider.publishedWindow()} asks a
 * server, in which order, and what it makes of the answers.
 *
 * <p>The fixtures are trimmed from what ollama 0.32.1 answered on this machine
 * on 2026-09-24. {@code /api/tags} marks a cloud model with {@code remote_host}
 * and {@code remote_model} (5 of 13 entries, all five cloud models, none of the
 * 8 local ones). {@code /api/show} names the window under
 * {@code model_info["<architecture>.context_length"]}: 1,048,576 for
 * {@code glm-5.3:cloud} (architecture {@code glm_dsa_moe}) and 512,000 for
 * {@code minimax-m3:cloud}. The show answers are verbatim; the listing keeps
 * three of its entries.</p>
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class OllamaPublishedWindowTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String TAGS = """
            {"models":[
              {"name":"glm-5.3:cloud","model":"glm-5.3:cloud","remote_model":"glm-5.3",
               "remote_host":"https://ollama.com","size":293,
               "details":{"parameter_size":"753B","context_length":1048576}},
              {"name":"minimax-m3:cloud","model":"minimax-m3:cloud","remote_model":"minimax-m3",
               "remote_host":"https://ollama.com","size":293},
              {"name":"qwen2.5:3b","model":"qwen2.5:3b","size":1929912432,
               "details":{"parameter_size":"3.1B","context_length":32768}}
            ]}""";

    private static final String SHOW_GLM = "{\"details\":{\"parent_model\":\"glm-5.3\",\"format\":\"\","
            + "\"family\":\"glm_dsa_moe\",\"families\":null,\"parameter_size\":\"753329940480\","
            + "\"quantization_level\":\"FP8\"},\"model_info\":{\"general.architecture\":\"glm_dsa_moe\","
            + "\"general.parameter_count\":753329940480,\"glm_dsa_moe.context_length\":1048576,"
            + "\"glm_dsa_moe.embedding_length\":0},\"capabilities\":[\"completion\",\"thinking\",\"tools\"],"
            + "\"modified_at\":\"2026-08-28T08:00:00-07:00\"}";

    private static final String SHOW_MINIMAX = "{\"details\":{\"parent_model\":\"minimax-m3\",\"format\":\"\","
            + "\"family\":\"minimax-m3\",\"families\":null,\"parameter_size\":\"0\",\"quantization_level\":\"\"},"
            + "\"model_info\":{\"general.architecture\":\"minimax-m3\",\"general.parameter_count\":0,"
            + "\"minimax-m3.context_length\":512000,\"minimax-m3.embedding_length\":0},"
            + "\"capabilities\":[\"completion\",\"tools\",\"thinking\",\"vision\"],"
            + "\"modified_at\":\"2026-06-01T00:00:00Z\"}";

    /** A show answer with no key ending in {@code .context_length}. */
    private static final String SHOW_WITHOUT_WINDOW = """
            {"model_info":{"general.architecture":"glm_dsa_moe","glm_dsa_moe.embedding_length":0},
             "capabilities":["completion"]}""";

    /**
     * A fake ollama that answers per path, counts hits per path, keeps the
     * order of the paths it saw and the bodies posted to {@code /api/show}.
     * A path with no answer set gets a 404, as ollama gives for a route it
     * does not serve.
     */
    private static final class RoutedServer {
        private final HttpServer server;
        private final Map<String, Integer> status = new ConcurrentHashMap<>();
        private final Map<String, String> body = new ConcurrentHashMap<>();
        private final List<String> paths = new CopyOnWriteArrayList<>();
        private final List<String> showBodies = new CopyOnWriteArrayList<>();

        RoutedServer() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", this::answer);
            server.start();
        }

        private void answer(HttpExchange exchange) throws IOException {
            String path = exchange.getRequestURI().getPath();
            paths.add(path);
            String posted = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if ("/api/show".equals(path)) {
                showBodies.add(posted);
            }
            byte[] payload = body.getOrDefault(path, "404 page not found")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status.getOrDefault(path, 404), payload.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(payload);
            }
        }

        void answers(String path, int code, String payload) {
            status.put(path, code);
            body.put(path, payload);
        }

        long hits(String path) {
            return paths.stream().filter(path::equals).count();
        }

        String baseUrl() {
            return "http://127.0.0.1:" + server.getAddress().getPort();
        }

        void stop() {
            server.stop(0);
        }
    }

    private RoutedServer server;

    @BeforeEach
    void start() throws IOException {
        server = new RoutedServer();
    }

    @AfterEach
    void stop() {
        server.stop();
    }

    private OllamaProvider provider(String model) {
        return new OllamaProvider(new OllamaOptions(server.baseUrl(), model));
    }

    @Test
    void aCloudModelReadsItsWindowOffApiShow() throws IOException {
        server.answers("/api/tags", 200, TAGS);
        server.answers("/api/show", 200, SHOW_GLM);

        assertEquals(1_048_576, provider("glm-5.3:cloud").publishedWindow());
        assertEquals(List.of("/api/tags", "/api/show"), server.paths,
                "the listing says the model is remote, then the show answer names its window");
        assertEquals("glm-5.3:cloud", JSON.readTree(server.showBodies.getFirst()).path("model").asText(),
                "the show question names the model this provider sends to");
    }

    @Test
    void theKeyIsFoundWhateverTheArchitectureIsCalled() {
        server.answers("/api/tags", 200, TAGS);
        server.answers("/api/show", 200, SHOW_MINIMAX);

        assertEquals(512_000, provider("minimax-m3:cloud").publishedWindow());
    }

    @Test
    void aLocalModelNeverAsksApiShow() {
        // For a local model /api/show names the TRAINED length, and the
        // loaded window on /api/ps stays the truth (card 263).
        server.answers("/api/tags", 200, TAGS);
        server.answers("/api/show", 200, SHOW_GLM);

        assertEquals(0, provider("qwen2.5:3b").publishedWindow());
        assertEquals(List.of("/api/tags"), server.paths);
    }

    @Test
    void aShowAnswerWithoutAContextLengthGivesZero() {
        server.answers("/api/tags", 200, TAGS);
        server.answers("/api/show", 200, SHOW_WITHOUT_WINDOW);

        assertEquals(0, provider("glm-5.3:cloud").publishedWindow(),
                "the listing's own context_length is not read; the show answer is the source");
        assertEquals(1, server.hits("/api/show"));
    }

    @Test
    void anHttpErrorOnShowGivesZeroAndIsAskedAgainNextTime() {
        server.answers("/api/tags", 200, TAGS);
        server.answers("/api/show", 500, "{\"error\":\"upstream\"}");
        OllamaProvider provider = provider("glm-5.3:cloud");

        assertEquals(0, provider.publishedWindow());
        server.answers("/api/show", 200, SHOW_GLM);
        assertEquals(1_048_576, provider.publishedWindow(), "a failure is not remembered");
        assertEquals(2, server.hits("/api/show"));
    }

    @Test
    void anHttpErrorOnTheListingGivesZeroAndAsksNoShow() {
        server.answers("/api/show", 200, SHOW_GLM);

        assertEquals(0, provider("glm-5.3:cloud").publishedWindow());
        assertEquals(List.of("/api/tags"), server.paths, "a 404 on the listing ends the question");
    }

    @Test
    void anAnswerIsRememberedForTheLifeOfTheProvider() {
        server.answers("/api/tags", 200, TAGS);
        server.answers("/api/show", 200, SHOW_GLM);
        OllamaProvider provider = provider("glm-5.3:cloud");

        assertEquals(1_048_576, provider.publishedWindow());
        assertEquals(1_048_576, provider.publishedWindow());
        assertEquals(1_048_576, provider.publishedWindow());

        assertEquals(1, server.hits("/api/tags"));
        assertEquals(1, server.hits("/api/show"));
    }

    @Test
    void aLocalVerdictIsRememberedToo() {
        server.answers("/api/tags", 200, TAGS);
        OllamaProvider provider = provider("qwen2.5:3b");

        assertEquals(0, provider.publishedWindow());
        assertEquals(0, provider.publishedWindow());

        assertEquals(1, server.hits("/api/tags"));
    }

    @Test
    void aModelTheListingDoesNotNameTeachesNothingAndIsAskedAgain() {
        server.answers("/api/tags", 200, TAGS);
        server.answers("/api/show", 200, SHOW_GLM);
        OllamaProvider provider = provider("kimi-k3:cloud");

        assertEquals(0, provider.publishedWindow());
        assertEquals(0, provider.publishedWindow());

        assertEquals(2, server.hits("/api/tags"), "a model pulled later must still be found");
        assertEquals(0, server.hits("/api/show"));
    }

    @Test
    void onlyAPositiveWholeNumberUnderTheFirstMatchingKeyIsAWindow() throws IOException {
        assertEquals(0, OllamaProvider.publishedContextLength(
                JSON.readTree("{\"model_info\":{\"x.context_length\":-1}}")), "negative");
        assertEquals(0, OllamaProvider.publishedContextLength(
                JSON.readTree("{\"model_info\":{\"x.context_length\":1.5}}")), "a fraction");
        assertEquals(0, OllamaProvider.publishedContextLength(
                JSON.readTree("{\"model_info\":{\"x.context_length\":1099511627781}}")),
                "2^40 + 5 does not fit an int, and its low 32 bits must not be read as 5");
        assertEquals(0, OllamaProvider.publishedContextLength(
                JSON.readTree("{\"model_info\":{\"x.context_length\":\"1048576\"}}")), "a string");
        assertEquals(0, OllamaProvider.publishedContextLength(
                JSON.readTree("{\"model_info\":{\"a.context_length\":0,\"b.context_length\":5}}")),
                "the first key ending in .context_length is the one read");
        assertEquals(5, OllamaProvider.publishedContextLength(
                JSON.readTree("{\"model_info\":{\"general.architecture\":\"b\",\"b.context_length\":5}}")),
                "the positive twin: a key that is not first in model_info but first to match");
    }

    @Test
    void aBodyThatIsNotJsonIsSurvived() {
        server.answers("/api/tags", 200, TAGS);
        server.answers("/api/show", 200, "<html><body>gateway</body></html>");

        assertEquals(0, provider("glm-5.3:cloud").publishedWindow());
    }
}
