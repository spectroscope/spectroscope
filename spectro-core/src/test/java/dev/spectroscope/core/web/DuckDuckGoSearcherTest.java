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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
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

    /** One-route mock that answers with a CHOSEN status — the 4xx/5xx half of
     *  this endpoint's behaviour, which the 200-only rig above cannot reach. */
    private String startWithStatus(int status, String page) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            byte[] answer = page.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/html");
            exchange.sendResponseHeaders(status, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** The one real response this tier has ever been pinned against.
     *  @return the captured page, verbatim */
    private static String realCapture() throws IOException {
        try (var in = DuckDuckGoSearcherTest.class.getResourceAsStream(
                "/web/duckduckgo-anomaly-page-2026-08-30.html")) {
            assertNotNull(in, "the captured fixture is missing from the test resources");
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
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

        // Card 223. This message is where a person MEETS the scrape, and it is
        // the phrase they carry to the doctor line, the result header and the
        // calibration panel. Those three used to call the same thing "best
        // effort, last resort", which reads as a different subsystem — so the
        // reader goes hunting for a second fault. Named once, checked from both
        // ends: this assertion is the searcher's end.
        assertTrue(failure.getMessage().contains(WebSearchTiers.SCRAPE),
                "the phrase the other surfaces quote, got: " + failure.getMessage());
        assertTrue(WebSearchTiers.label("duckduckgo").contains(WebSearchTiers.SCRAPE),
                "the result header calls it something else: " + WebSearchTiers.label("duckduckgo"));
        String sentence = WebSearchTiers.describe(
                WebSearchTiers.decide(new WebSearchTiers.Configured(null, false, false)));
        assertTrue(sentence.contains(WebSearchTiers.SCRAPE),
                "the doctor line calls it something else: " + sentence);
        // And the remedy travels with the diagnosis, in all three.
        assertTrue(failure.getMessage().contains("Configure a SearXNG instance"),
                "got: " + failure.getMessage());
        assertTrue(sentence.contains("Configure a SearXNG instance"), "got: " + sentence);
    }

    @Test
    void aChallengeUnderAFailureStatusStillReachesTheReaderWithTheRemedy() throws IOException {
        // Card 318. Measured live 2026-08-30: under pressure this endpoint
        // escalates 200 -> 202 -> 403, and it serves the SAME challenge page at
        // every one of them. At 202 the body reaches parse() and the reader gets
        // the remedy; at 403 Spring's default status handler threw before the
        // body was ever looked at, and what the model was handed instead was the
        // raw status plus a fragment of DuckDuckGo's support mailto. The status
        // changed; the thing that happened did not.
        String baseUrl = startWithStatus(403, realCapture());

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> new DuckDuckGoSearcher(baseUrl).search("gradle kotlin dsl", 5));

        assertTrue(failure.getMessage().contains("bot check"),
                "names the bot check, got: " + failure.getMessage());
        assertTrue(failure.getMessage().contains(WebSearchTiers.SCRAPE),
                "the phrase the other surfaces quote, got: " + failure.getMessage());
        assertTrue(failure.getMessage().contains("Configure a SearXNG instance"),
                "the remedy card 223 pinned across four surfaces, got: " + failure.getMessage());
    }

    @Test
    void a202StillCarriesResultsThroughToTheReader() throws IOException {
        // 202 is where this endpoint actually sits under load, and it is a
        // SUCCESS status: a guard that let only 200 through would turn today's
        // working path into a failure sentence. Results at 202 stay results.
        String baseUrl = startWithStatus(202, RESULTS_PAGE);

        List<WebSearcher.Hit> hits = new DuckDuckGoSearcher(baseUrl).search("gradle dsl", 5);

        assertEquals(2, hits.size(), "the 202 path is unmoved, got: " + hits);
        assertEquals("Gradle Kotlin DSL", hits.get(0).title());
    }

    @Test
    void aGenuineServerErrorFailsHonestlyAndIsNotParsedIntoZeroResults() throws IOException {
        // The other direction, and the reason the guard cannot simply swallow
        // every status: a 500 whose body is NOT a challenge has no results in it
        // either, so a guard that hands the body to parse() and returns what it
        // finds would answer "No results" to a broken server. That is a new way
        // to lie, in place of the old one. SearxngSearcher ends the same way —
        // "answered HTTP <status> instead of results" — and so does this.
        String baseUrl = startWithStatus(500,
                "<html><body><h1>500 Internal Server Error</h1></body></html>");

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> new DuckDuckGoSearcher(baseUrl).search("gradle kotlin dsl", 5));

        assertTrue(failure.getMessage().contains("500"),
                "names the status it actually got, got: " + failure.getMessage());
        assertFalse(failure.getMessage().contains("bot check"),
                "a broken server is not a challenge, got: " + failure.getMessage());
    }

    @Test
    void theCanaryPinsTheParserAgainstOneRealCapturedResponse() throws IOException {
        // WHAT THIS PROVES, and it is less than the name of a canary suggests.
        //
        // Every other fixture in this file is hand-written HTML whose own
        // comment calls it "realistic". Nothing anywhere pinned the scrape
        // against a body html.duckduckgo.com actually sent. This one is real:
        // captured 2026-08-30 for the query "gradle kotlin dsl", status 202,
        // 14157 bytes, saved byte-for-byte.
        //
        // It proves that the challenge detector fires on a REAL challenge page —
        // the "anomaly" match is not a guess about DuckDuckGo's markup, it is
        // measured against DuckDuckGo's markup — and that a real challenge yields
        // zero organic hits rather than garbage rows.
        //
        // It is not an independent branch pin either: break the challenge
        // detector and the hand-written test above goes red with it. What this
        // one adds is the direction of proof — that test shows the code finds a
        // word its own author put in the fixture, this one shows DuckDuckGo
        // really puts that word in the page.
        //
        // It does NOT prove the result-row patterns (result__a, the uddg=
        // redirect, result__snippet). Those are still pinned only against
        // hand-written HTML, and i18n's own copy already says out loud that they
        // "break silently the day the page is redesigned". On 2026-08-30 no
        // client tried could obtain a results page to pin them with: the shipped
        // User-Agent, a desktop-browser User-Agent, a POST form submit, the
        // /lite/ endpoint and a real headless browser were each answered with
        // this same challenge. When the endpoint serves results again, the
        // missing half is a second fixture beside this one.
        String captured = realCapture();

        assertFalse(captured.contains("result__a"),
                "a real RESULTS page would carry result anchors — this capture is the "
                        + "challenge, and the row patterns stay unpinned by it");

        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> DuckDuckGoSearcher.parse(captured, 5));
        assertTrue(failure.getMessage().contains("Configure a SearXNG instance"),
                "the remedy, produced from a real body, got: " + failure.getMessage());
    }

    @Test
    void tierIsDuckduckgo() {
        assertEquals("duckduckgo", new DuckDuckGoSearcher().tier());
    }
}
