package dev.spectroscope.core.web;

import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The keyless DuckDuckGo tier of web_search — best effort, LAST resort, and
 * the only tier here that DuckDuckGo's own terms prohibit. It answers when
 * nothing above it in {@link WebSearchTiers}' table is configured: no SearXNG
 * instance, no Tavily key, no Brave key. Everything that names a tier labels
 * this one as what it is, because a silent default that scrapes is the
 * dishonesty card 203 removed. One GET against the {@code html.duckduckgo.com}
 * results page, parsed by hand (regex + {@link HtmlText}; no jsoup, no new
 * dependency): titles come from the {@code result__a} anchors, URLs decode
 * the {@code uddg=} redirect parameter, snippets from the following
 * {@code result__snippet} element. Ad rows (y.js links) are dropped. When
 * DuckDuckGo answers with its bot-check page instead of results, the searcher
 * throws a READABLE error — a silent "no results" would be a lie.
 *
 * <p><b>What this tier is NOT, and card 318 is the reason it says so here.</b>
 * The status guard below makes the failure READABLE. It does not make the tier
 * reliable, and no reader should leave this file believing web_search works
 * without a configured tier above it. Measured 2026-08-30: twenty requests in
 * nine seconds fall to three answers in ten and then to 403, and on that day no
 * client tried — the shipped User-Agent, a desktop-browser User-Agent, a POST
 * form submit, the {@code /lite/} endpoint, a real browser — was served a
 * results page at all. The tier's honest state is "usually refused", and this
 * class's job is to say which refusal it was.</p>
 */
public final class DuckDuckGoSearcher implements WebSearcher {

    /** DuckDuckGo's HTML (no-JS) endpoint; tests point the second constructor at a mock. */
    static final String DEFAULT_BASE_URL = "https://html.duckduckgo.com";

    /** Sent on every request — the endpoint refuses clients without a User-Agent. */
    static final String USER_AGENT = "Mozilla/5.0 (compatible; spectro-web-search)";

    private static final Duration TIMEOUT = Duration.ofSeconds(15);

    /** One organic result anchor: class result__a, href attribute, inner title markup. */
    private static final Pattern RESULT_LINK = Pattern.compile(
            "<a[^>]*class=\"[^\"]*result__a[^\"]*\"[^>]*href=\"([^\"]*)\"[^>]*>(.*?)</a>",
            Pattern.DOTALL);

    /** The snippet element that follows a result anchor. */
    private static final Pattern SNIPPET = Pattern.compile(
            "class=\"[^\"]*result__snippet[^\"]*\"[^>]*>(.*?)</a>", Pattern.DOTALL);

    /** Ad rows resolve through DuckDuckGo's y.js redirect — never a real hit. */
    private static final String AD_REDIRECT_MARKER = "duckduckgo.com/y.js";

    private final RestClient http;

    /** The production searcher against html.duckduckgo.com. */
    public DuckDuckGoSearcher() {
        this(DEFAULT_BASE_URL);
    }

    /**
     * Visible for tests: same wiring, mock base URL.
     *
     * @param baseUrl the server to talk to — a local mock in tests
     */
    DuckDuckGoSearcher(String baseUrl) {
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) TIMEOUT.toMillis());
        factory.setReadTimeout((int) TIMEOUT.toMillis());
        this.http = RestClient.builder()
                .requestFactory(factory)
                .baseUrl(baseUrl)
                .defaultHeader("User-Agent", USER_AGENT)
                .build();
    }

    /** The fallback tier's name — surfaced in the tool description, results and doctor. */
    @Override
    public String tier() {
        return "duckduckgo";
    }

    /**
     * One GET on the results page, parsed into hits. The status is read here
     * rather than left to Spring, because this endpoint serves the SAME
     * challenge page under several of them.
     *
     * @param query      the search query
     * @param maxResults hard cut on the number of returned hits
     * @return the organic hits in page order
     * @throws IllegalStateException when the answer is a challenge, or a status
     *                               that is not results
     */
    @Override
    public List<Hit> search(String query, int maxResults) {
        ResponseEntity<String> response = http.get()
                .uri(builder -> builder.path("/html/").queryParam("q", query).build())
                // Status handling belongs below, on the body. Spring's default
                // handler throws before the body is ever looked at, and this
                // endpoint answers a challenge under 403 exactly as it does
                // under 202 — so the default handler turns the one message that
                // carries a remedy into a bare status plus a slice of raw HTML.
                // SearxngSearcher took this same seam for the same reason.
                .retrieve()
                .onStatus(status -> true, (request, ignored) -> { })
                .toEntity(String.class);

        String page = response.getBody() == null ? "" : response.getBody();
        int status = response.getStatusCode().value();
        if (status < 200 || status >= 300) {
            if (isBotCheck(page)) {
                // Measured 2026-08-30: under pressure this endpoint escalates
                // 200 -> 202 -> 403 and serves the same challenge at each. The
                // status changed; what happened did not, so neither does what
                // the reader is told.
                throw botCheckFailure();
            }
            // NOT every status is swallowed. A server that is merely broken has
            // no results in it either, and handing that body to parse() would
            // answer "No results" to a 500 — the same lie in a new costume.
            throw new IllegalStateException("duckduckgo answered HTTP " + status
                    + " instead of results — this is the " + WebSearchTiers.SCRAPE + " tier, and "
                    + "it is the one nobody should be relying on. Configure a SearXNG instance, "
                    + "or a Tavily or Brave key, under Settings.");
        }
        return parse(page, maxResults);
    }

    /**
     * The hand-rolled results-page parse — pure and directly testable.
     *
     * @param page       the raw HTML of the results page
     * @param maxResults hard cut on the number of returned hits
     * @return the organic hits in page order; empty for a genuine no-results page
     * @throws IllegalStateException when the page is DuckDuckGo's bot check
     */
    static List<Hit> parse(String page, int maxResults) {
        // Collect every result anchor first — each snippet is searched only in
        // the window between one anchor and the next, so pairs cannot slip.
        record Anchor(String href, String titleHtml, int windowStart) {}
        List<Anchor> anchors = new ArrayList<>();
        Matcher links = RESULT_LINK.matcher(page);
        while (links.find()) {
            anchors.add(new Anchor(links.group(1), links.group(2), links.end()));
        }

        List<Hit> hits = new ArrayList<>();
        for (int i = 0; i < anchors.size() && hits.size() < maxResults; i++) {
            Anchor anchor = anchors.get(i);
            String url = decodeHref(anchor.href());
            if (url.isBlank() || url.contains(AD_REDIRECT_MARKER)) {
                continue; // ad row or unusable link — never a hit
            }
            int windowEnd = i + 1 < anchors.size()
                    ? page.indexOf(anchors.get(i + 1).href(), anchor.windowStart())
                    : page.length();
            String window = page.substring(anchor.windowStart(),
                    windowEnd < 0 ? page.length() : windowEnd);
            Matcher snippet = SNIPPET.matcher(window);
            hits.add(new Hit(HtmlText.strip(anchor.titleHtml()), url,
                    snippet.find() ? HtmlText.strip(snippet.group(1)) : ""));
        }

        if (hits.isEmpty() && isBotCheck(page)) {
            throw botCheckFailure();
        }
        return hits;
    }

    /**
     * The one challenge sentence, built in one place so the 2xx path and the
     * failure-status path cannot drift apart. The phrase is shared, not
     * repeated: a reader who lands here goes looking for the same words in the
     * doctor line, the result header and the calibration panel (card 223).
     *
     * @return the failure to throw
     */
    private static IllegalStateException botCheckFailure() {
        return new IllegalStateException("duckduckgo answered with a bot check page "
                + "instead of results — this is the " + WebSearchTiers.SCRAPE + " tier, and "
                + "it is the one nobody should be relying on. Configure a SearXNG instance, "
                + "or a Tavily or Brave key, under Settings.");
    }

    /**
     * Recognizes DuckDuckGo's anomaly (bot challenge) page.
     *
     * @param page the raw HTML that yielded zero hits
     * @return true when the page is the challenge, not a genuine empty result
     */
    private static boolean isBotCheck(String page) {
        String lower = page.toLowerCase(Locale.ROOT);
        return lower.contains("anomaly") || lower.contains("bots use duckduckgo");
    }

    /**
     * Resolves a result anchor's href to the real destination: the
     * {@code uddg=} redirect parameter is URL-decoded; protocol-relative
     * links get https; anything else passes through.
     *
     * @param rawHref the href exactly as it appears in the page (HTML-escaped)
     * @return the absolute destination URL, or "" when the href carries none
     */
    private static String decodeHref(String rawHref) {
        String href = rawHref.replace("&amp;", "&");
        int uddg = href.indexOf("uddg=");
        if (uddg >= 0) {
            String encoded = href.substring(uddg + "uddg=".length());
            int nextParam = encoded.indexOf('&');
            if (nextParam >= 0) {
                encoded = encoded.substring(0, nextParam);
            }
            return URLDecoder.decode(encoded, StandardCharsets.UTF_8);
        }
        if (href.startsWith("//")) {
            return "https:" + href;
        }
        return href;
    }
}
