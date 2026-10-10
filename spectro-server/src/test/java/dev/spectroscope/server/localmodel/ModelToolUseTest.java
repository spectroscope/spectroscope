package dev.spectroscope.server.localmodel;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 493, criterion 7: {@code GET /api/models/tool-use} says whether a
 * model can call tools, for the Local mode switch's warning. The bundled
 * catalogue answers from {@code nativeTools}, LM Studio from
 * {@code trained_for_tool_use} in its own listing, Ollama from the
 * {@code capabilities} of {@code /api/show}. Every other backend, and a
 * backend that does not answer, is unknown.
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS)
class ModelToolUseTest {

    private HttpServer server;

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    private String scripted(String path, String json) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext(path, exchange -> {
            exchange.getRequestBody().readAllBytes();
            byte[] body = json.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static ModelCapabilityController with(String ollama, String lmstudio) {
        return new ModelCapabilityController("http://127.0.0.1:1", "http://127.0.0.1:1",
                ollama, null, lmstudio);
    }

    @Test
    void lmStudioIsAskedForItsOwnListing() throws IOException {
        String base = scripted("/api/v1/models", "{\"models\":[{\"key\":\"plain\","
                + "\"capabilities\":{\"trained_for_tool_use\":false},\"loaded_instances\":[]}]}");
        Map<String, String> answer = with("http://127.0.0.1:1", base + "/v1").toolUse("lmstudio", "plain");
        assertEquals("no", answer.get("toolUse"));
        assertEquals("lmstudio", answer.get("source"));
    }

    @Test
    void ollamaIsAskedForShow() throws IOException {
        String base = scripted("/api/show", "{\"capabilities\":[\"completion\",\"tools\"]}");
        Map<String, String> answer = with(base, "http://127.0.0.1:1").toolUse("ollama", "qwen");
        assertEquals("yes", answer.get("toolUse"));
        assertEquals("ollama", answer.get("source"));
    }

    @Test
    void theBundledEngineAnswersFromTheCatalogue() {
        Map<String, String> answer = with("http://127.0.0.1:1", "http://127.0.0.1:1")
                .toolUse("spectro-local", "vibethinker-3b");
        assertEquals("no", answer.get("toolUse"));
        assertEquals("catalogue", answer.get("source"));
    }

    @Test
    void aDarkBackendAndAnyOtherProviderAreUnknown() {
        ModelCapabilityController offline = with("http://127.0.0.1:1", "http://127.0.0.1:1");
        assertEquals("unknown", offline.toolUse("ollama", "qwen").get("toolUse"));
        assertEquals("unknown", offline.toolUse("lmstudio", "plain").get("toolUse"));
        assertEquals("unknown", offline.toolUse("anthropic", "claude-opus-4-8").get("toolUse"));
        assertEquals("none", offline.toolUse("anthropic", "claude-opus-4-8").get("source"));
    }
}
