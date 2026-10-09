package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 468, criterion 4: the {@code promptCaching} setting governs the
 * llama.cpp cache field too, through the one factory every face uses
 * ({@link SpectroConfig#providerFromConfig()}).
 */
class PromptCachingReachesLlamaCppTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private HttpServer server;
    private String baseUrl;
    private final AtomicReference<String> body = new AtomicReference<>();

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            body.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] sse = """
                    data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}

                    data: [DONE]

                    """.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, sse.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(sse);
            }
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    @Test
    void theSettingOnSendsCachePromptTrue(@TempDir Path projectDir) throws IOException {
        JsonNode sent = sendOnce(projectDir, true);
        assertTrue(sent.path("cache_prompt").isBoolean(), "the field is on the wire: " + sent);
        assertTrue(sent.get("cache_prompt").booleanValue());
    }

    @Test
    void theSettingOffSendsNoCachePrompt(@TempDir Path projectDir) throws IOException {
        JsonNode sent = sendOnce(projectDir, false);
        assertTrue(sent.has("messages"), "a real request body was captured: " + sent);
        assertFalse(sent.has("cache_prompt"),
                "promptCaching false leaves the field off the llama.cpp wire: " + sent);
    }

    private JsonNode sendOnce(Path projectDir, boolean promptCaching) throws IOException {
        Path file = projectDir.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(file.getParent());
        Files.writeString(file, "{ \"provider\": \"llamacpp\", \"model\": \"m\", \"maxRetries\": 0, "
                + "\"llamacppBaseUrl\": \"" + baseUrl + "\", \"promptCaching\": " + promptCaching + " }");
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir,
                java.util.Map.of());
        LlmProvider provider = config.providerFromConfig();
        provider.stream(new LlmProvider.ProviderRequest("sys",
                List.of(new LlmProvider.ProviderMessage(LlmProvider.ProviderMessage.Role.USER,
                        List.of(new LlmProvider.TextContent("hi")))),
                List.of(), 50, new CancelSignal())).forEach(event -> { });
        return JSON.readTree(body.get());
    }
}
