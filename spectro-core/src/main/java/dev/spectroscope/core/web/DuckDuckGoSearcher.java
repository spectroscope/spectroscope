package dev.spectroscope.core.web;

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
 * The keyless DuckDuckGo tier of web_search — the fallback when no
 * TAVILY_API_KEY is set. One GET against the {@code html.duckduckgo.com}
 * results page, parsed by hand (regex + {@link HtmlText}; no jsoup, no new
 * dependency): titles come from the {@code result__a} anchors, URLs decode
 * the {@code uddg=} redirect parameter, snippets from the following
 * {@code result__snippet} element. Ad rows (y.js links) are dropped. When
 * DuckDuckGo answers with its bot-check page instead of results, the searcher
 * throws a READABLE error — a silent "no results" would be a lie.
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

    /** One GET on the results page, parsed into hits — HTTP errors propagate for the tool to map. */
    @Override
    public List<Hit> search(String query, int maxResults) {
        String page = http.get()
                .uri(builder -> builder.path("/html/").queryParam("q", query).build())
                .retrieve()
                .body(String.class);
        return parse(page == null ? "" : page, maxResults);
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
            throw new IllegalStateException("duckduckgo answered with a bot check page "
                    + "instead of results — retry later, or set TAVILY_API_KEY for the "
                    + "Tavily tier.");
        }
        return hits;
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
