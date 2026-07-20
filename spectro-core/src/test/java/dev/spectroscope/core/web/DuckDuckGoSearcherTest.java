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
 * The keyless DuckDuckGo HTML fallback against a local mock server — offline
 * by construction. Proves the hand-rolled result parsing (titles stripped of
 * markup, uddg redirect URLs decoded, snippets flattened), the max_results
 * cut, the ad-row filter, and that a bot-check page answers with a readable
 * error instead of a silent "no results".
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class DuckDuckGoSearcherTest {

    /** A realistic html.duckduckgo.com results page: two organic hits (one with
     *  markup in the title, uddg-encoded hrefs) and one y.js ad row. */
    private static final String RESULTS_PAGE = """
            <html><body>
            <div class="result results_links results_links_deep web-result">
              <h2 class="result__title">
                <a rel="nofollow" class="result__a"
                   href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.gradle.org%2Fdsl&amp;rut=abc">
                   Gradle <b>Kotlin</b> DSL</a>
              </h2>
              <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The <b>reference</b> &amp; guide.</a>
            </div>
            <div class="result result--ad">
              <h2 class="result__title">
                <a rel="nofollow" class="result__a"
                   href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=enc">Sponsored thing</a>
              </h2>
              <a class="result__snippet">Buy now.</a>
            </div>
            <div class="result results_links results_links_deep web-result">
              <h2 class="result__title">
                <a rel="nofollow" class="result__a" href="https://gradle.org/releases">Releases</a>
              </h2>
              <a class="result__snippet">All versions.</a>
            </div>
            </body></html>
            """;

    private HttpServer server;

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    /** One-route mock: records query string + User-Agent, answers the canned page. */
    private String start(String page, AtomicReference<String> seenQuery,
                         AtomicReference<String> seenUserAgent) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            seenQuery.set(exchange.getRequestURI().getRawQuery());
            seenUserAgent.set(exchange.getRequestHeaders().getFirst("User-Agent"));
            byte[] answer = page.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/html");
            exchange.sendResponseHeaders(200, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @Test
    void parsesTitlesDecodedUrlsAndFlattenedSnippets() throws IOException {
        AtomicReference<String> query = new AtomicReference<>();
        AtomicReference<String> userAgent = new AtomicReference<>();
        String baseUrl = start(RESULTS_PAGE, query, userAgent);

        List<WebSearcher.Hit> hits = new DuckDuckGoSearcher(baseUrl).search("gradle dsl", 5);

        assertTrue(query.get().contains("q=gradle"), "query sent, got: " + query.get());
        assertTrue(userAgent.get() != null && !userAgent.get().isBlank(),
                "a User-Agent is sent, got: " + userAgent.get());
        assertEquals(2, hits.size(), "ad row filtered, got: " + hits);
        assertEquals(new WebSearcher.Hit("Gradle Kotlin DSL", "https://docs.gradle.org/dsl",
                "The reference & guide."), hits.get(0));
        assertEquals(new WebSearcher.Hit("Releases", "https://gradle.org/releases",
                "All versions."), hits.get(1));
    }

    @Test
    void respectsMaxResults() throws IOException {
        String baseUrl = start(RESULTS_PAGE, new AtomicReference<>(), new AtomicReference<>());
        List<WebSearcher.Hit> hits = new DuckDuckGoSearcher(baseUrl).search("gradle dsl", 1);
        assertEquals(1, hits.size());
        assertEquals("Gradle Kotlin DSL", hits.get(0).title());
    }

    @Test
    void anEmptyResultsPageIsAnEmptyList() throws IOException {
        String baseUrl = start("<html><body><div class=\"no-results\">No results.</div></body></html>",
                new AtomicReference<>(), new AtomicReference<>());
        assertEquals(List.of(), new DuckDuckGoSearcher(baseUrl).search("xyzzy", 5));
    }

    @Test
    void aBotCheckPageThrowsAReadableErrorInsteadOfSilentEmptiness() throws IOException {
        String baseUrl = start("""
                <html><body><div class="anomaly-modal__modal">
                <p>Unfortunately, bots use DuckDuckGo too. Please complete the following
                challenge to confirm this search was made by a human.</p>
                </div></body></html>
                """, new AtomicReference<>(), new AtomicReference<>());

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> new DuckDuckGoSearcher(baseUrl).search("q", 5));

        assertTrue(failure.getMessage().contains("bot check"),
                "names the bot check, got: " + failure.getMessage());
    }

    @Test
    void tierIsDuckduckgo() {
        assertEquals("duckduckgo", new DuckDuckGoSearcher().tier());
    }
}
