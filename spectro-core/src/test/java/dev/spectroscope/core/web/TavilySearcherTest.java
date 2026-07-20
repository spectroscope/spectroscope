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
 * The Tavily tier against a local mock server — key-free and offline. Proves
 * the wire shape (POST /search, Bearer auth, query + max_results in the JSON
 * body), the tolerant response parsing, and the readable 401 failure that
 * points at TAVILY_API_KEY.
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class TavilySearcherTest {

    private HttpServer server;

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    /** One-route mock: records the request and answers with the canned body. */
    private String start(int status, String body, AtomicReference<String> seenAuth,
                         AtomicReference<String> seenBody, AtomicReference<String> seenPath)
            throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            seenAuth.set(exchange.getRequestHeaders().getFirst("Authorization"));
            seenPath.set(exchange.getRequestURI().getPath());
            seenBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
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
    void postsBearerAuthAndQueryThenParsesTheHits() throws IOException {
        AtomicReference<String> auth = new AtomicReference<>();
        AtomicReference<String> body = new AtomicReference<>();
        AtomicReference<String> path = new AtomicReference<>();
        String baseUrl = start(200, """
                {"query":"gradle dsl","answer":null,"images":[],"response_time":0.9,
                 "results":[
                   {"title":"Gradle Kotlin DSL","url":"https://docs.gradle.org/dsl",
                    "content":"The reference.","score":0.98,"raw_content":null},
                   {"title":"Releases","url":"https://gradle.org/releases",
                    "content":"All versions.","score":0.61}
                 ]}
                """, auth, body, path);

        List<WebSearcher.Hit> hits = new TavilySearcher("tvly-test-key", baseUrl)
                .search("gradle dsl", 2);

        assertEquals("/search", path.get(), "Tavily's search endpoint");
        assertEquals("Bearer tvly-test-key", auth.get(), "Bearer auth header");
        assertTrue(body.get().contains("\"query\":\"gradle dsl\""), "query in body, got: " + body.get());
        assertTrue(body.get().contains("\"max_results\":2"), "max_results in body, got: " + body.get());
        assertEquals(2, hits.size());
        assertEquals(new WebSearcher.Hit("Gradle Kotlin DSL", "https://docs.gradle.org/dsl",
                "The reference."), hits.get(0));
        assertEquals(new WebSearcher.Hit("Releases", "https://gradle.org/releases",
                "All versions."), hits.get(1));
    }

    @Test
    void missingResultFieldsBecomeEmptyStringsNotNulls() throws IOException {
        String baseUrl = start(200, """
                {"results":[{"url":"https://only.url"}]}
                """, new AtomicReference<>(), new AtomicReference<>(), new AtomicReference<>());

        List<WebSearcher.Hit> hits = new TavilySearcher("k", baseUrl).search("q", 1);

        assertEquals(List.of(new WebSearcher.Hit("", "https://only.url", "")), hits);
    }

    @Test
    void anAbsentResultsArrayIsAnEmptyList() throws IOException {
        String baseUrl = start(200, "{\"query\":\"q\"}",
                new AtomicReference<>(), new AtomicReference<>(), new AtomicReference<>());
        assertEquals(List.of(), new TavilySearcher("k", baseUrl).search("q", 3));
    }

    @Test
    void aRejectedKeyThrowsAReadableErrorNamingTheEnvVar() throws IOException {
        String baseUrl = start(401, "{\"detail\":\"Unauthorized\"}",
                new AtomicReference<>(), new AtomicReference<>(), new AtomicReference<>());

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> new TavilySearcher("bad", baseUrl).search("q", 3));

        assertTrue(failure.getMessage().contains("TAVILY_API_KEY"),
                "points at the key, got: " + failure.getMessage());
    }

    @Test
    void tierIsTavily() {
        assertEquals("tavily", new TavilySearcher("k").tier());
    }

    @Test
    void theWireInterfaceIsPublicSoTheProxyBuildsOnAnyLoader() {
        // Found live: a non-public interface can only be JDK-proxied by its
        // EXACT defining loader — fine in tests (same loader), a 500 on the
        // server's Tomcat threads. The house template (OllamaApi) is public
        // for the same reason; this pin keeps TavilyApi that way.
        assertTrue(java.lang.reflect.Modifier.isPublic(
                        TavilySearcher.TavilyApi.class.getModifiers()),
                "TavilyApi must be public — JDK proxies across loaders require it");
    }
}
