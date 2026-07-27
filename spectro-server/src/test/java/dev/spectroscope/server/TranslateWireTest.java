package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.OllamaOptions;
import dev.spectroscope.core.provider.OllamaProvider;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The translate path with a REAL provider underneath it, against a scripted
 * Ollama on loopback. {@link TranslateControllerTest} puts a seam where the
 * provider goes and so can never see what leaves the machine; this one pins the
 * bytes that reach {@code /api/chat}, because the defect it guards lives in the
 * mapping between the two and is invisible from either side alone.
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS)
class TranslateWireTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private HttpServer ollama;
    private String baseUrl;
    private final AtomicReference<String> lastChatBody = new AtomicReference<>();

    @BeforeEach
    void startScriptedOllama() throws IOException {
        ollama = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        ollama.createContext("/api/chat", exchange -> {
            lastChatBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] ndjson = ("""
                    {"message":{"content":"At 04:12 the operator noticed"},"done":false}
                    {"message":{"content":" that worker-alpha stopped answering."},"done":true,\
                    "prompt_eval_count":140,"eval_count":38}
                    """).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            exchange.sendResponseHeaders(200, ndjson.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(ndjson);
            }
        });
        ollama.start();
        baseUrl = "http://127.0.0.1:" + ollama.getAddress().getPort();
    }

    @AfterEach
    void stopScriptedOllama() {
        ollama.stop(0);
    }

    @Test
    void theTranslatePathTellsOllamaNotToReason() throws Exception {
        drainOneTranslation();

        JsonNode sent = mapper.readTree(lastChatBody.get());
        JsonNode think = sent.get("think");
        assertNotNull(think, "translation must say think:false on the wire, the field was absent: " + sent);
        assertFalse(think.isNull(), "think:false, not a null: " + sent);
        assertFalse(think.asBoolean(), "translation must switch reasoning OFF, sent: " + think);
    }

    @Test
    void theCompletionBudgetIsTheTranslationsAlone() throws Exception {
        // The other half of the same defect: num_predict caps EVERYTHING the
        // model generates, reasoning included. MEASURED 2026-07-27 against
        // glm-5.2:cloud with a 181-character passage and this very budget — a
        // reasoning phase spent all 512 tokens (eval_count 512, done_reason
        // "length") and the translation never began. With reasoning off the same
        // budget is the translation's own.
        drainOneTranslation();

        JsonNode sent = mapper.readTree(lastChatBody.get());
        assertTrue(sent.path("options").path("num_predict").asInt() >= 512,
                "the passage keeps its own completion budget: " + sent.path("options"));
    }

    /** One cloud translation through the real Ollama provider. */
    private void drainOneTranslation() throws Exception {
        TranslateController controller = new TranslateController(
                config -> new OllamaProvider(new OllamaOptions(baseUrl, "glm-5.2:cloud")),
                unusableLocalEngine(),
                () -> SpectroConfig.load(SpectroConfig.Overrides.none())
                        .withProvider("ollama", "glm-5.2:cloud"));
        var response = controller.translate(
                new TranslateController.TranslateBody("cloud", "en", List.of(
                        new TranslateController.Unit("answer",
                                "Об 04:12 оператор помітив, що вузол worker-alpha перестав відповідати."))),
                new MockHttpServletRequest());
        ByteArrayOutputStream ndjson = new ByteArrayOutputStream();
        response.getBody().writeTo(ndjson);
    }

    /** The built-in engine is not the subject here — no test spawns a llama-server. */
    private static TranslateController.LocalEngine unusableLocalEngine() {
        return new TranslateController.LocalEngine() {
            @Override
            public boolean binaryAvailable() {
                return false;
            }

            @Override
            public String readyModelId(String selected) {
                return null;
            }

            @Override
            public Optional<LlmProvider> provider(String modelId) {
                return Optional.empty();
            }
        };
    }
}
