package dev.spectroscope.core.web;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The Brave tier against a local mock server — key-free and offline. Brave's
 * wire differs from Tavily's in three ways that a test has to hold: a GET
 * rather than a POST, the key in {@code X-Subscription-Token} rather than in
 * an {@code Authorization} header, and the snippet field named
 * {@code description} inside a nested {@code web.results} block.
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class BraveSearcherTest {

    private HttpServer server;

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    /** One-route mock: records the request and answers with the canned body. */
    private String start(int status, String body, AtomicReference<String> seenToken,
                         AtomicReference<String> seenPath, AtomicReference<String> seenQuery)
            throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            seenToken.set(exchange.getRequestHeaders().getFirst("X-Subscription-Token"));
            seenPath.set(exchange.getRequestURI().getPath());
            seenQuery.set(exchange.getRequestURI().getQuery());
            byte[] answer = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @Test
    void sendsTheSubscriptionTokenAndParsesTheNestedResults() throws IOException {
        AtomicReference<String> token = new AtomicReference<>();
        AtomicReference<String> path = new AtomicReference<>();
        AtomicReference<String> query = new AtomicReference<>();
        String baseUrl = start(200, """
                {"type":"search",
                 "web":{"type":"search","results":[
                   {"title":"Gradle Kotlin DSL","url":"https://docs.gradle.org/dsl",
                    "description":"The reference.","is_source_local":false},
                   {"title":"Releases","url":"https://gradle.org/releases",
                    "description":"All versions."}
                 ]}}
                """, token, path, query);

        List<WebSearcher.Hit> hits = new BraveSearcher("brave-test-key", baseUrl).search("gradle dsl", 2);

        assertEquals("/res/v1/web/search", path.get(), "Brave's web search endpoint");
        assertEquals("brave-test-key", token.get(), "the key rides X-Subscription-Token");
        assertTrue(query.get().contains("count=2"), "the hit count travels, got: " + query.get());
        assertEquals(List.of(
                new WebSearcher.Hit("Gradle Kotlin DSL", "https://docs.gradle.org/dsl", "The reference."),
                new WebSearcher.Hit("Releases", "https://gradle.org/releases", "All versions.")), hits);
    }

    @Test
    void anAnswerWithoutAWebBlockIsAnEmptyList() throws IOException {
        String baseUrl = start(200, "{\"type\":\"search\"}",
                new AtomicReference<>(), new AtomicReference<>(), new AtomicReference<>());
        assertEquals(List.of(), new BraveSearcher("k", baseUrl).search("q", 3));
    }

    @Test
    void missingResultFieldsBecomeEmptyStringsNotNulls() throws IOException {
        String baseUrl = start(200, "{\"web\":{\"results\":[{\"url\":\"https://only.url\"}]}}",
                new AtomicReference<>(), new AtomicReference<>(), new AtomicReference<>());
        assertEquals(List.of(new WebSearcher.Hit("", "https://only.url", "")),
                new BraveSearcher("k", baseUrl).search("q", 1));
    }

    @Test
    void aRejectedKeyThrowsAReadableErrorNamingTheEnvVar() throws IOException {
        String baseUrl = start(401, "{\"error\":\"Unauthorized\"}",
                new AtomicReference<>(), new AtomicReference<>(), new AtomicReference<>());

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> new BraveSearcher("bad", baseUrl).search("q", 3));

        assertTrue(failure.getMessage().contains("BRAVE_API_KEY"),
                "points at the key, got: " + failure.getMessage());
    }

    @Test
    void theFreeTiersRateLimitGetsItsOwnSentence() throws IOException {
        // Brave's free plan allows one query per second and answers 429 above
        // it. Reported as a bad key, that sends the operator to rotate a key
        // that was never the problem.
        String baseUrl = start(429, "{\"error\":\"Too Many Requests\"}",
                new AtomicReference<>(), new AtomicReference<>(), new AtomicReference<>());

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> new BraveSearcher("k", baseUrl).search("q", 3));

        String message = failure.getMessage();
        assertTrue(message.contains("429"), "names the status, got: " + message);
        assertTrue(message.contains("rate"), "says what 429 means here, got: " + message);
    }

    @Test
    void tierIsBrave() {
        assertEquals("brave", new BraveSearcher("k").tier());
    }

    @Test
    void theWireInterfaceIsPublicSoTheProxyBuildsOnAnyLoader() {
        // Same pin as TavilyApi: a non-public interface can only be JDK-proxied
        // by its exact defining loader — fine in tests, a 500 on the server's
        // request threads.
        assertTrue(java.lang.reflect.Modifier.isPublic(BraveSearcher.BraveApi.class.getModifiers()),
                "BraveApi must be public — JDK proxies across loaders require it");
    }
}
