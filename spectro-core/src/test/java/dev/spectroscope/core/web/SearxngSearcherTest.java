package dev.spectroscope.core.web;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.GZIPOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The SearXNG tier against a local mock — key-free and offline. Most of these
 * tests exist because of facts about stock SearXNG that were measured against
 * real containers on 2026-08-13, not because of symmetry with the other tiers:
 *
 * <ul>
 *   <li>the shipped {@code settings.yml} lists {@code html} under
 *       {@code search.formats} and nothing else, so an API client asking for
 *       {@code format=json} is answered <b>403 text/html</b> while the same
 *       instance answers a browser's plain search with 200;</li>
 *   <li>with its limiter armed, a request carrying Spring's default
 *       {@code Java/21.0.5} User-Agent and no {@code Accept-Encoding} is
 *       answered <b>429 text/html</b>, and the header set this class sends is
 *       answered <b>200 application/json</b>;</li>
 *   <li>there is no result-count parameter, so the cut to {@code maxResults}
 *       is the client's job.</li>
 * </ul>
 *
 * Each failure shape gets its OWN sentence and every sentence names the
 * address that was dialled — the honesty rule from card 193. "Something went
 * wrong" would leave the operator guessing between a dead container, a
 * config file and a bot wall.
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class SearxngSearcherTest {

    private HttpServer server;

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    /** One-route mock: records the request and answers with the canned body. */
    private String start(int status, String contentType, String body,
                         AtomicReference<String> seenPath,
                         AtomicReference<String> seenQuery,
                         AtomicReference<java.util.Map<String, String>> seenHeaders) throws IOException {
        return start(status, contentType, body.getBytes(StandardCharsets.UTF_8), null,
                seenPath, seenQuery, seenHeaders);
    }

    private String start(int status, String contentType, byte[] body, String contentEncoding,
                         AtomicReference<String> seenPath,
                         AtomicReference<String> seenQuery,
                         AtomicReference<java.util.Map<String, String>> seenHeaders) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            seenPath.set(exchange.getRequestURI().getPath());
            seenQuery.set(exchange.getRequestURI().getQuery());
            java.util.Map<String, String> headers = new java.util.HashMap<>();
            exchange.getRequestHeaders()
                    .forEach((name, values) -> headers.put(name.toLowerCase(Locale.ROOT), values.get(0)));
            seenHeaders.set(headers);
            exchange.getResponseHeaders().add("Content-Type", contentType);
            if (contentEncoding != null) {
                exchange.getResponseHeaders().add("Content-Encoding", contentEncoding);
            }
            exchange.sendResponseHeaders(status, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static AtomicReference<String> ref() {
        return new AtomicReference<>();
    }

    private static AtomicReference<java.util.Map<String, String>> headerRef() {
        return new AtomicReference<>();
    }

    @Test
    void asksForJsonAndParsesTheHits() throws IOException {
        AtomicReference<String> path = ref();
        AtomicReference<String> query = ref();
        String baseUrl = start(200, "application/json", """
                {"query":"gradle dsl","number_of_results":0,
                 "results":[
                   {"url":"https://docs.gradle.org/dsl","title":"Gradle Kotlin DSL",
                    "content":"The reference.","engine":"duckduckgo","score":1.0},
                   {"url":"https://gradle.org/releases","title":"Releases",
                    "content":"All versions.","engine":"google","score":0.5}
                 ]}
                """, path, query, headerRef());

        List<WebSearcher.Hit> hits = new SearxngSearcher(baseUrl).search("gradle dsl", 5);

        assertEquals("/search", path.get(), "SearXNG's search endpoint");
        assertTrue(query.get().contains("format=json"),
                "format=json is what turns the page into an API, got: " + query.get());
        assertTrue(query.get().contains("q=gradle"), "the query travels, got: " + query.get());
        assertEquals(List.of(
                new WebSearcher.Hit("Gradle Kotlin DSL", "https://docs.gradle.org/dsl", "The reference."),
                new WebSearcher.Hit("Releases", "https://gradle.org/releases", "All versions.")), hits);
    }

    @Test
    void cutsToMaxResultsItselfBecauseSearxngHasNoCountParameter() throws IOException {
        AtomicReference<String> query = ref();
        String baseUrl = start(200, "application/json", """
                {"results":[
                   {"url":"https://a","title":"A","content":"a"},
                   {"url":"https://b","title":"B","content":"b"},
                   {"url":"https://c","title":"C","content":"c"},
                   {"url":"https://d","title":"D","content":"d"}
                 ]}
                """, ref(), query, headerRef());

        List<WebSearcher.Hit> hits = new SearxngSearcher(baseUrl).search("q", 2);

        assertEquals(2, hits.size(), "the cut is the client's job");
        assertEquals("A", hits.get(0).title());
        assertEquals("B", hits.get(1).title());
        // Pinning the ABSENCE of a count parameter: inventing one would be a
        // request SearXNG ignores, which reads like a working limit until the
        // day someone asks why ten hits came back for max_results=2.
        assertFalse(query.get().contains("count="), "SearXNG has no count parameter, got: " + query.get());
        assertFalse(query.get().contains("max_results="), "nor a max_results one, got: " + query.get());
    }

    @Test
    void sendsABrowserShapedRequestBecauseSearxngsBotWallReadsTheseHeaders() throws IOException {
        AtomicReference<java.util.Map<String, String>> headers = headerRef();
        String baseUrl = start(200, "application/json", "{\"results\":[]}", ref(), ref(), headers);

        new SearxngSearcher(baseUrl).search("q", 3);

        String userAgent = headers.get().get("user-agent");
        // Measured against searxng/botdetection/http_user_agent.py: the shipped
        // regex matches the bare word "Java", and Spring's RestClient default
        // User-Agent is literally "Java/<version>".
        assertFalse(userAgent.contains("Java"),
                "a User-Agent containing \"Java\" is what SearXNG's bot regex blocks, got: " + userAgent);
        assertEquals(SearxngSearcher.USER_AGENT, userAgent);
        // searxng/botdetection/http_accept_encoding.py refuses a request whose
        // Accept-Encoding names neither gzip nor deflate.
        String encoding = headers.get().get("accept-encoding");
        assertTrue(encoding != null && (encoding.contains("gzip") || encoding.contains("deflate")),
                "Accept-Encoding must name gzip or deflate, got: " + encoding);
        assertTrue(headers.get().get("accept").contains("json"), "Accept names JSON");
        assertTrue(headers.get().containsKey("accept-language"), "Accept-Language is sent");
    }

    @Test
    void readsAGzippedAnswerBecauseWeAskedForGzip() throws IOException {
        // The consequence of the header above: a proxy in front of SearXNG may
        // take the offer. The JDK's HTTP stack does NOT decompress for us, so a
        // client that asks and cannot read is a client that fails on exactly the
        // instances that are most carefully set up.
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        try (GZIPOutputStream gzip = new GZIPOutputStream(buffer)) {
            gzip.write("""
                    {"results":[{"url":"https://z","title":"Z","content":"zipped"}]}
                    """.getBytes(StandardCharsets.UTF_8));
        }
        String baseUrl = start(200, "application/json", buffer.toByteArray(), "gzip",
                ref(), ref(), headerRef());

        List<WebSearcher.Hit> hits = new SearxngSearcher(baseUrl).search("q", 3);

        assertEquals(List.of(new WebSearcher.Hit("Z", "https://z", "zipped")), hits);
    }

    @Test
    void a403NamesTheAddressAndTheSettingThatIsMissing() throws IOException {
        String baseUrl = start(403, "text/html", "<html>Forbidden</html>", ref(), ref(), headerRef());

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> new SearxngSearcher(baseUrl).search("q", 3));

        String message = failure.getMessage();
        assertTrue(message.contains(baseUrl), "names the address it tried, got: " + message);
        assertTrue(message.contains("403"), "names the status, got: " + message);
        assertTrue(message.contains("settings.yml"), "names the file to edit, got: " + message);
        assertTrue(message.contains("search.formats"), "names the key to edit, got: " + message);
    }

    @Test
    void anHtmlAnswerWithStatus200IsItsOwnSentence() throws IOException {
        // The anti-bot page and a json-less settings.yml can BOTH land here, and
        // the sentence says so rather than picking one and being wrong half the
        // time. What it must never do is look like a successful empty search.
        String baseUrl = start(200, "text/html; charset=utf-8",
                "<!DOCTYPE html><html><body>Too Many Requests</body></html>", ref(), ref(), headerRef());

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> new SearxngSearcher(baseUrl).search("q", 3));

        String message = failure.getMessage();
        assertTrue(message.contains(baseUrl), "names the address it tried, got: " + message);
        assertTrue(message.toLowerCase(Locale.ROOT).contains("html"),
                "says what came back instead, got: " + message);
        assertFalse(message.contains("403"), "this is not the 403 sentence, got: " + message);
    }

    @Test
    void a429IsTheBotWallAndNotABusyInstance() throws IOException {
        // Measured 2026-08-13 against a real instance with the limiter armed:
        // a request with Spring's default "Java/21.0.5" User-Agent and no
        // Accept-Encoding comes back 429 text/html, while the headers this
        // class sends come back 200 application/json. "HTTP 429" alone reads
        // like a busy server and sends the operator off to wait.
        String baseUrl = start(429, "text/html", "<html>Too Many Requests</html>",
                ref(), ref(), headerRef());

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> new SearxngSearcher(baseUrl).search("q", 3));

        String message = failure.getMessage();
        assertTrue(message.contains(baseUrl), "names the address it tried, got: " + message);
        assertTrue(message.contains("bot protection"), "names the cause, got: " + message);
    }

    @Test
    void anUnreachableInstanceNamesTheAddressItTried() throws IOException {
        String dead;
        try (ServerSocket socket = new ServerSocket(0)) {
            dead = "http://127.0.0.1:" + socket.getLocalPort();
        } // closed: nothing listens there now

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> new SearxngSearcher(dead).search("q", 3));

        String message = failure.getMessage();
        assertTrue(message.contains(dead), "names the address it tried, got: " + message);
        assertFalse(message.contains("settings.yml"),
                "an unreachable host is not a config-file problem, got: " + message);
    }

    @Test
    void aTrailingSlashOnTheConfiguredUrlDoesNotBecomeADoubleSlash() throws IOException {
        AtomicReference<String> path = ref();
        String baseUrl = start(200, "application/json", "{\"results\":[]}", path, ref(), headerRef());

        new SearxngSearcher(baseUrl + "/").search("q", 3);

        assertEquals("/search", path.get(), "the configured URL is normalized, got: " + path.get());
    }

    @Test
    void tierIsSearxng() {
        assertEquals("searxng", new SearxngSearcher("http://localhost:8888").tier());
    }
}
