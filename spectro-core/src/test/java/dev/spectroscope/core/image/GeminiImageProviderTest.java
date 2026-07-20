package dev.spectroscope.core.image;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The Gemini wire mapping, proven against a scripted local HTTP server — no API
 * key and no network beyond loopback. Covers the happy path (base64 in, bytes
 * out), the mixed text-then-image parts list, and both error shapes (HTTP status,
 * response without an image).
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class GeminiImageProviderTest {

    /** A real 1x1 PNG — the smallest honest payload for a byte round-trip. */
    private static final byte[] TINY_PNG = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");

    private static final ObjectMapper JSON = new ObjectMapper();

    private HttpServer server;
    private String baseUrl;
    private final AtomicReference<String> lastPath = new AtomicReference<>();
    private final AtomicReference<String> lastApiKeyHeader = new AtomicReference<>();
    private final AtomicReference<String> lastBody = new AtomicReference<>();
    private volatile int scriptedStatus = 200;
    private volatile String scriptedJson = "{}";

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            lastPath.set(exchange.getRequestURI().getPath());
            lastApiKeyHeader.set(exchange.getRequestHeaders().getFirst("x-goog-api-key"));
            lastBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] body = scriptedJson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(scriptedStatus, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    private GeminiImageProvider provider() {
        return new GeminiImageProvider(
                new GeminiImageOptions(baseUrl, "test-key", "gemini-2.5-flash-image"));
    }

    private static String inlineDataResponse() {
        String base64 = Base64.getEncoder().encodeToString(TINY_PNG);
        return """
                {"candidates":[{"content":{"parts":[
                  {"inlineData":{"mimeType":"image/png","data":"%s"}}
                ]}}]}""".formatted(base64);
    }

    @Test
    void decodesTheInlineImageAndCarriesKeyAndPath() throws IOException {
        scriptedJson = inlineDataResponse();

        ImageProvider.Generated generated = provider().generate("a coral diamond on ebony");

        assertArrayEquals(TINY_PNG, generated.bytes());
        assertEquals("image/png", generated.mediaType());
        assertEquals("/v1beta/models/gemini-2.5-flash-image:generateContent", lastPath.get());
        assertEquals("test-key", lastApiKeyHeader.get(),
                "Gemini authenticates via the x-goog-api-key header");

        JsonNode sent = JSON.readTree(lastBody.get());
        assertEquals("a coral diamond on ebony",
                sent.get("contents").get(0).get("parts").get(0).get("text").asText());
    }

    @Test
    void aTextPartBeforeTheImageStillFindsTheImage() {
        String base64 = Base64.getEncoder().encodeToString(TINY_PNG);
        scriptedJson = """
                {"candidates":[{"content":{"parts":[
                  {"text":"Here is your image."},
                  {"inlineData":{"mimeType":"image/webp","data":"%s"}}
                ]}}]}""".formatted(base64);

        ImageProvider.Generated generated = provider().generate("anything");

        assertArrayEquals(TINY_PNG, generated.bytes());
        assertEquals("image/webp", generated.mediaType());
    }

    @Test
    void anErrorStatusBecomesAReadableException() {
        scriptedStatus = 400;
        scriptedJson = "{\"error\":{\"message\":\"bad request\"}}";

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> provider().generate("anything"));
        assertTrue(failure.getMessage().contains("400"),
                "the message must name the HTTP status, got: " + failure.getMessage());
    }

    @Test
    void aResponseWithoutInlineDataBecomesAReadableException() {
        scriptedJson = """
                {"candidates":[{"content":{"parts":[{"text":"I cannot draw that."}]}}]}""";

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> provider().generate("anything"));
        assertTrue(failure.getMessage().contains("no image"),
                "the message must say the response contained no image, got: " + failure.getMessage());
    }
}
