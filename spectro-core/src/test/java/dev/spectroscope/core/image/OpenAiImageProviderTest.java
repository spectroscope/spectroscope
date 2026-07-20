package dev.spectroscope.core.image;

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
 * The OpenAI images wire mapping against a scripted local HTTP server: base64
 * round-trip via {@code b64_json}, bearer authentication, readable HTTP errors.
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class OpenAiImageProviderTest {

    /** A real 1x1 PNG — the smallest honest payload for a byte round-trip. */
    private static final byte[] TINY_PNG = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");

    private HttpServer server;
    private String baseUrl;
    private final AtomicReference<String> lastAuthorization = new AtomicReference<>();
    private volatile int scriptedStatus = 200;
    private volatile String scriptedJson = "{}";

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/images/generations", exchange -> {
            lastAuthorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
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

    private OpenAiImageProvider provider() {
        return new OpenAiImageProvider(new OpenAiImageOptions(baseUrl, "test-key", "gpt-image-1"));
    }

    @Test
    void decodesTheB64JsonPayloadAndSendsTheBearerToken() {
        scriptedJson = "{\"data\":[{\"b64_json\":\""
                + Base64.getEncoder().encodeToString(TINY_PNG) + "\"}]}";

        ImageProvider.Generated generated = provider().generate("a sand-yellow diamond");

        assertArrayEquals(TINY_PNG, generated.bytes());
        assertEquals("image/png", generated.mediaType(), "gpt-image-1 returns PNG by default");
        assertEquals("Bearer test-key", lastAuthorization.get());
    }

    @Test
    void anErrorStatusBecomesAReadableException() {
        scriptedStatus = 500;
        scriptedJson = "{\"error\":{\"message\":\"boom\"}}";

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> provider().generate("anything"));
        assertTrue(failure.getMessage().contains("500"),
                "the message must name the HTTP status, got: " + failure.getMessage());
    }
}
