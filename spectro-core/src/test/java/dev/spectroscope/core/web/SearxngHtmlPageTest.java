package dev.spectroscope.core.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 448: a stock SearXNG answers web_search from its HTML results page.
 *
 * <p>Measured on 2026-09-26 against three releases of the public image with
 * their shipped {@code settings.yml} untouched (2025.3.19-40feede51,
 * 2026.8.12-cdfdaa5a8, 2026.9.25-12f8b6515): every one answered
 * {@code format=json} with 403 and the plain search with a 200 HTML results
 * page. Before this card that 403 ended the search. The pages under
 * {@code /web/searxng/} are those answers, saved byte for byte and named by
 * release, not written by hand.</p>
 *
 * <p>The mock here plays a stock instance: 403 for {@code format=json}, the
 * saved page for the plain search, and it records every request so a test can
 * say which instance was asked and how often.</p>
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class SearxngHtmlPageTest {

    private static final String RESULTS_2026_08 = "searxng-2026.8.12-cdfdaa5a8-results.html";
    private static final String RESULTS_2026_09 = "searxng-2026.9.25-12f8b6515-results.html";
    private static final String NO_RESULTS_2026_08 = "searxng-2026.8.12-cdfdaa5a8-no-results.html";
    private static final String NO_RESULTS_2025_03 = "searxng-2025.3.19-40feede51-no-results.html";
    private static final String REFUSED_JSON = "searxng-2026.8.12-cdfdaa5a8-format-json-403.html";

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The Java side of the contract with the web app's once-per-session note. */
    private static final String CONTRACT = "spectro-web/src/state/fixtures/web-search-searxng-html.txt";

    /** One request as the mock saw it. */
    private record Seen(String path, String query, Map<String, String> headers) {
        boolean asksForJson() {
            return query != null && query.contains("format=json");
        }
    }

    private HttpServer server;
    private final List<Seen> seen = new CopyOnWriteArrayList<>();

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    private static byte[] page(String name) throws IOException {
        try (InputStream in = SearxngHtmlPageTest.class.getResourceAsStream("/web/searxng/" + name)) {
            assertTrue(in != null, "the saved page is missing: " + name);
            return in.readAllBytes();
        }
    }

    /**
     * A two-route instance: one answer for {@code format=json}, another for
     * every other request.
     */
    private String start(int jsonStatus, String jsonType, byte[] jsonBody,
                         int htmlStatus, byte[] htmlBody) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            Map<String, String> headers = new HashMap<>();
            exchange.getRequestHeaders()
                    .forEach((name, values) -> headers.put(name.toLowerCase(Locale.ROOT), values.get(0)));
            Seen request = new Seen(exchange.getRequestURI().getPath(),
                    exchange.getRequestURI().getQuery(), headers);
            seen.add(request);
            boolean json = request.asksForJson();
            byte[] body = json ? jsonBody : htmlBody;
            exchange.getResponseHeaders().add("Content-Type", json ? jsonType : "text/html; charset=utf-8");
            exchange.sendResponseHeaders(json ? jsonStatus : htmlStatus, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** A stock instance as measured: 403 for JSON, the saved page otherwise. */
    private String startStock(String htmlPage) throws IOException {
        return start(403, "text/html; charset=utf-8", page(REFUSED_JSON), 200, page(htmlPage));
    }

    private static ToolContext context() {
        return new ToolContext(Path.of("."), new CancelSignal());
    }

    // ---- criterion 1: red first, at the tool the model calls ----

    @Test
    void aStockInstanceAnswersWebSearchInsteadOfFailing() throws IOException {
        String baseUrl = startStock(RESULTS_2026_08);
        WebSearchTool tool = new WebSearchTool(new SearxngSearcher(baseUrl));

        String result = tool.execute(JSON.createObjectNode().put("query", "gradle kotlin dsl"), context());

        assertFalse(result.startsWith("ERROR"), "a stock instance must answer, got: " + result);
        assertTrue(result.contains("1. Gradle Kotlin DSL Primer"), "the page's first hit, got: " + result);
        assertTrue(result.contains("https://docs.gradle.org/current/userguide/kotlin_dsl.html"),
                "its address, got: " + result);
    }

    // ---- criterion 2: the same instance, in HTML ----

    @Test
    void aRefusedJsonRequestIsFollowedByTheSameInstancesHtmlPage() throws IOException {
        String baseUrl = startStock(RESULTS_2026_08);

        List<WebSearcher.Hit> hits = new SearxngSearcher(baseUrl).search("gradle kotlin dsl", 2);

        assertEquals(List.of(
                new WebSearcher.Hit("Gradle Kotlin DSL Primer",
                        "https://docs.gradle.org/current/userguide/kotlin_dsl.html",
                        "Kotlin DSL Plugin · Applies the Kotlin Plugin, which adds support for compiling "
                                + "Kotlin source files. · Adds the kotlin-stdlib , kotlin-reflect , and ..."),
                new WebSearcher.Hit("Packages - Gradle User Manual",
                        "https://docs.gradle.org/current/kotlin-dsl/index.html",
                        "The org.gradle.kotlin.dsl package contains the Gradle Kotlin DSL public API.")),
                hits);
        assertEquals(2, seen.size(), "one JSON request, one page request, got: " + seen);
        assertTrue(seen.get(0).asksForJson(), "JSON is still asked first, got: " + seen.get(0));
        Seen pageRequest = seen.get(1);
        assertEquals("/search", pageRequest.path(), "the same search endpoint");
        assertFalse(pageRequest.asksForJson(), "the page request asks for no format, got: " + pageRequest);
        assertTrue(pageRequest.query().contains("q=gradle"), "the query travels, got: " + pageRequest);
    }

    @Test
    void thePageRequestCarriesTheBrowserShapedHeadersToo() throws IOException {
        String baseUrl = startStock(RESULTS_2026_08);

        new SearxngSearcher(baseUrl).search("q", 1);

        Map<String, String> headers = seen.get(1).headers();
        assertEquals(SearxngSearcher.USER_AGENT, headers.get("user-agent"));
        assertTrue(headers.get("accept-encoding").contains("gzip"), "got: " + headers);
    }

    @Test
    void noOtherTierIsAskedWhenTheInstanceRefusesJson() throws IOException {
        // Card 203: exactly one tier answers. The HTML page belongs to the
        // configured instance, so every request of this search lands on it and
        // the hits are the ones its page lists, in its order.
        String baseUrl = startStock(RESULTS_2026_08);
        WebSearchTool tool = new WebSearchTool(new SearxngSearcher(baseUrl));

        String result = tool.execute(JSON.createObjectNode().put("query", "gradle kotlin dsl")
                .put("max_results", 3), context());

        assertEquals(2, seen.size(), "both requests reached the configured instance, got: " + seen);
        assertTrue(result.startsWith("Results (searxng at " + baseUrl + ", "),
                "the header names the tier and the address, got: " + result);
        assertTrue(result.contains("1. Gradle Kotlin DSL Primer\n"), "got: " + result);
        assertTrue(result.contains("2. Packages - Gradle User Manual\n"), "got: " + result);
        assertTrue(result.contains("3. org.gradle.kotlin.kotlin-dsl - Gradle Plugin Portal\n"),
                "got: " + result);
    }

    @Test
    void theHeaderSaysTheResultsCameFromTheHtmlPage() throws IOException {
        String baseUrl = startStock(RESULTS_2026_08);
        WebSearchTool tool = new WebSearchTool(new SearxngSearcher(baseUrl));

        String result = tool.execute(JSON.createObjectNode().put("query", "gradle kotlin dsl"), context());

        assertEquals("Results (searxng at " + baseUrl + ", " + WebSearchTool.HTML_PAGE_NOTE
                        + ") for \"gradle kotlin dsl\":",
                result.lines().findFirst().orElse(""));
    }

    @Test
    void aJsonAnswerKeepsTheHeaderItHadBefore() throws IOException {
        String baseUrl = start(200, "application/json",
                "{\"results\":[{\"url\":\"https://a\",\"title\":\"A\",\"content\":\"a\"}]}"
                        .getBytes(StandardCharsets.UTF_8),
                500, new byte[0]);
        WebSearchTool tool = new WebSearchTool(new SearxngSearcher(baseUrl));

        String result = tool.execute(JSON.createObjectNode().put("query", "q"), context());

        assertTrue(result.startsWith("Results (searxng) for \"q\":"), "got: " + result);
        assertEquals(1, seen.size(), "an instance that answers JSON is asked once, got: " + seen);
    }

    @Test
    void aStatus200HtmlAnswerToFormatJsonAlsoReadsTheHtmlPage() throws IOException {
        // The card's second shape: an instance (or a proxy in front of it) that
        // answers format=json with 200 and an HTML body.
        String baseUrl = start(200, "text/html; charset=utf-8", page(RESULTS_2026_08),
                200, page(RESULTS_2026_08));

        List<WebSearcher.Hit> hits = new SearxngSearcher(baseUrl).search("gradle kotlin dsl", 1);

        assertEquals("Gradle Kotlin DSL Primer", hits.get(0).title());
        assertEquals(2, seen.size(), "the page was asked for, got: " + seen);
    }

    // ---- criterion 3: parsed from real pages, two releases ----

    @Test
    void theNewerReleasesLayoutReadsTheSameFields() throws IOException {
        // 2026.9.25 wraps each result in div.result_inner and groups the page
        // by template (template_group_default, template_group_videos); the
        // 2026.8.12 page has neither.
        String baseUrl = startStock(RESULTS_2026_09);

        List<WebSearcher.Hit> hits = new SearxngSearcher(baseUrl).search("gradle kotlin dsl", 2);

        assertEquals(List.of(
                new WebSearcher.Hit("Gradle Kotlin DSL Primer",
                        "https://docs.gradle.org/current/userguide/kotlin_dsl.html",
                        "Gradle's Kotlin DSL offers an alternative to the traditional Groovy DSL, "
                                + "delivering an enhanced editing experience in supported IDEs with features "
                                + "like better content assist, refactoring, and documentation. This chapter "
                                + "explores the key Kotlin DSL constructs and demonstrates how to use them to "
                                + "interact with the Gradle API."),
                new WebSearcher.Hit("Packages - Gradle User Manual",
                        "https://docs.gradle.org/current/kotlin-dsl/index.html",
                        "Gradle Kotlin DSL Reference Gradle's Kotlin DSL provides an enhanced editing "
                                + "experience in supported IDEs, with superior content assistance, refactoring, "
                                + "documentation, and more. For an introduction see the Kotlin DSL Primer. The "
                                + "Kotlin DSL is implemented on top of Gradle's Java API.")),
                hits);
    }

    @Test
    void everyResultOnBothPagesIsRead() throws IOException {
        // Counted in the saved pages: 20 article elements on the 2026.8.12
        // page and 39 on the 2026.9.25 one, each with a title link.
        String older = startStock(RESULTS_2026_08);
        assertEquals(20, new SearxngSearcher(older).search("gradle kotlin dsl", 100).size());
        stop();
        String newer = startStock(RESULTS_2026_09);
        assertEquals(39, new SearxngSearcher(newer).search("gradle kotlin dsl", 100).size());
    }

    @Test
    void anEscapedAmpersandInAResultAddressReachesTheHitDecoded() throws IOException {
        // On the saved pages every href with an ampersand writes it as "&amp;"
        // (the RSS and OpenSearch links), but no title link carries one. This
        // page is the saved 2026.9.25 page with the first result's title link
        // swapped for an address that does, escaped the same way.
        String saved = new String(page(RESULTS_2026_09), StandardCharsets.UTF_8);
        String titleLink = "<h3><a href=\"https://docs.gradle.org/current/userguide/kotlin_dsl.html\"";
        assertEquals(1, saved.split(Pattern.quote(titleLink), -1).length - 1,
                "the first result's title link occurs once in the saved page");
        String withQuery = saved.replace(titleLink, "<h3><a href=\"https://a.example/p?x=1&amp;y=2\"");
        String baseUrl = start(403, "text/html; charset=utf-8", page(REFUSED_JSON),
                200, withQuery.getBytes(StandardCharsets.UTF_8));

        List<WebSearcher.Hit> hits = new SearxngSearcher(baseUrl).search("gradle kotlin dsl", 1);

        assertEquals("Gradle Kotlin DSL Primer", hits.get(0).title(), "the swapped link is the first hit");
        assertEquals("https://a.example/p?x=1&y=2", hits.get(0).url());
    }

    @Test
    void theCutToMaxResultsHoldsOnThePageToo() throws IOException {
        String baseUrl = startStock(RESULTS_2026_09);

        assertEquals(3, new SearxngSearcher(baseUrl).search("gradle kotlin dsl", 3).size());
    }

    @Test
    void aPageWithNoResultsIsAnEmptyListOnBothReleases() throws IOException {
        String older = startStock(NO_RESULTS_2025_03);
        assertEquals(List.of(), new SearxngSearcher(older).search("nothing", 5));
        stop();
        String newer = startStock(NO_RESULTS_2026_08);
        assertEquals(List.of(), new SearxngSearcher(newer).search("nothing", 5));
    }

    @Test
    void noResultsFromThePageReadsLikeNoResultsFromJson() throws IOException {
        String html = startStock(NO_RESULTS_2026_08);
        String fromPage = new WebSearchTool(new SearxngSearcher(html))
                .execute(JSON.createObjectNode().put("query", "nothing"), context());
        stop();
        String json = start(200, "application/json", "{\"results\":[]}".getBytes(StandardCharsets.UTF_8),
                500, new byte[0]);
        String fromJson = new WebSearchTool(new SearxngSearcher(json))
                .execute(JSON.createObjectNode().put("query", "nothing"), context());

        assertEquals("No results for \"nothing\" (searxng).", fromJson);
        assertEquals(fromJson, fromPage);
    }

    // ---- the page is not a results page: say so, never "no results" ----

    @Test
    void anHtmlAnswerThatIsNotAResultsPageFailsAndNamesTheAddress() throws IOException {
        String baseUrl = start(403, "text/html; charset=utf-8", page(REFUSED_JSON),
                200, "<!DOCTYPE html><html><body>Checking your browser</body></html>"
                        .getBytes(StandardCharsets.UTF_8));

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> new SearxngSearcher(baseUrl).search("q", 3));

        String message = failure.getMessage();
        assertTrue(message.contains(baseUrl), "names the address, got: " + message);
        assertTrue(message.contains("not a results page"), "says what came back, got: " + message);
    }

    @Test
    void aResultsPageWhoseResultsCannotBeReadFailsInsteadOfSayingNoResults() throws IOException {
        // A later release that renames the title element must not turn every
        // search into "No results".
        String changed = "<html><body><div id=\"urls\" role=\"main\">"
                + "<article class=\"result result-default\"><h4><a href=\"https://a\">A</a></h4></article>"
                + "</div></body></html>";
        String baseUrl = start(403, "text/html; charset=utf-8", page(REFUSED_JSON),
                200, changed.getBytes(StandardCharsets.UTF_8));

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> new SearxngSearcher(baseUrl).search("q", 3));

        String message = failure.getMessage();
        assertTrue(message.contains(baseUrl), "names the address, got: " + message);
        assertTrue(message.contains("1 result"), "says how many it could not read, got: " + message);
    }

    @Test
    void aBotWallOnThePageKeepsTheBotWallSentence() throws IOException {
        String baseUrl = start(403, "text/html; charset=utf-8", page(REFUSED_JSON),
                429, "<html>Too Many Requests</html>".getBytes(StandardCharsets.UTF_8));

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> new SearxngSearcher(baseUrl).search("q", 3));

        assertTrue(failure.getMessage().contains("bot protection"), "got: " + failure.getMessage());
        assertTrue(failure.getMessage().contains(baseUrl), "got: " + failure.getMessage());
    }

    // ---- criterion 5: the description the model reads ----

    @Test
    void theSearxngDescriptionSaysAnHtmlOnlyInstanceStillAnswers() {
        String description = new WebSearchTool(new SearxngSearcher("http://box.local:8888")).description();

        assertTrue(description.contains(WebSearchTiers.htmlOnlyNote(WebSearchTiers.SEARXNG)),
                "the sentence comes from WebSearchTiers, got: " + description);
        assertTrue(description.contains("serves HTML only"), "got: " + description);
        assertTrue(description.contains("not an error"), "got: " + description);
    }

    @Test
    void noOtherTiersDescriptionCarriesTheSearxngNote() {
        for (String tier : List.of(WebSearchTiers.TAVILY, WebSearchTiers.BRAVE, WebSearchTiers.DUCKDUCKGO)) {
            assertEquals("", WebSearchTiers.htmlOnlyNote(tier), tier);
        }
        String scrape = new WebSearchTool(new DuckDuckGoSearcher()).description();
        assertFalse(scrape.contains("serves HTML only"), "got: " + scrape);
    }

    // ---- criterion 4: the contract with the web app's note ----

    @Test
    void theHeaderIsTheOneTheWebAppRecognises() throws IOException {
        // spectro-web reads this file in its reducer test and draws its
        // once-per-session note from it. The header here must be the line it
        // holds, with the mock's address standing in for the fixture's.
        String baseUrl = startStock(RESULTS_2026_08);
        String result = new WebSearchTool(new SearxngSearcher(baseUrl))
                .execute(JSON.createObjectNode().put("query", "gradle kotlin dsl").put("max_results", 1),
                        context());

        String contract = Files.readString(repoRoot().resolve(CONTRACT), StandardCharsets.UTF_8);
        assertEquals(contract.strip(), result.replace(baseUrl, "http://box.local:8888").strip(),
                CONTRACT + " no longer holds what web_search prints. Change both, or neither.");
    }

    private static Path repoRoot() {
        Path here = Path.of("").toAbsolutePath();
        while (here != null && !Files.exists(here.resolve("settings.gradle.kts"))) {
            here = here.getParent();
        }
        return here == null ? Path.of("").toAbsolutePath() : here;
    }
}
