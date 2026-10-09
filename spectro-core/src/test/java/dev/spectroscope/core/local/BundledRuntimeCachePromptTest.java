package dev.spectroscope.core.local;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.OpenAiCompatProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 468: the bundled runtime keeps llama.cpp's prompt cache on. The path
 * under test is the one {@code ServerLocalRuntime} takes, {@link
 * LocalProviderFactory#build}, which builds its options without a caching
 * choice and so relies on the default of {@link OpenAiCompatProvider.Options}.
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class BundledRuntimeCachePromptTest {

    private static final String STREAM = """
            data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}

            data: {"usage":{"prompt_tokens":11,"completion_tokens":1},"choices":[]}

            data: [DONE]

            """;

    private final AtomicReference<String> chatBody = new AtomicReference<>();

    private LocalRuntime.Launcher stub() {
        return (model, port, key) -> {
            HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
            s.createContext("/v1/models", ex -> {
                byte[] b = "{\"data\":[{\"id\":\"bundled\"}]}".getBytes(StandardCharsets.UTF_8);
                ex.sendResponseHeaders(200, b.length);
                ex.getResponseBody().write(b);
                ex.close();
            });
            s.createContext("/v1/chat/completions", ex -> {
                chatBody.set(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                byte[] b = STREAM.getBytes(StandardCharsets.UTF_8);
                ex.getResponseHeaders().add("Content-Type", "text/event-stream");
                ex.sendResponseHeaders(200, b.length);
                try (OutputStream out = ex.getResponseBody()) {
                    out.write(b);
                }
            });
            s.start();
            return (AutoCloseable) () -> s.stop(0);
        };
    }

    @Test
    void theBundledRuntimeAsksItsLlamaServerToReuseThePromptCache(@TempDir Path dir) throws Exception {
        Path model = Files.writeString(dir.resolve("m.gguf"), "gguf");
        LocalRuntime runtime = new LocalRuntime(stub(), "bundled");
        try {
            LlmProvider provider = LocalProviderFactory.build(runtime, model).orElseThrow();
            provider.stream(new ProviderRequest("You are a test.",
                    List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("Hi")))),
                    List.of(), 100, new CancelSignal())).forEach(event -> { });
        } finally {
            runtime.shutdown();
        }
        assertNotNull(chatBody.get(), "the request reached the bundled server");
        JsonNode body = new ObjectMapper().readTree(chatBody.get());
        assertTrue(body.path("cache_prompt").isBoolean(), "the field is on the wire: " + body);
        assertTrue(body.get("cache_prompt").booleanValue(),
                "the bundled runtime keeps the cache on: " + body);
    }
}
