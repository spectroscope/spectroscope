package dev.spectroscope.core.web;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.governing.Governs;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;
import java.util.zip.InflaterInputStream;

/**
 * The SearXNG tier of web_search — a metasearch instance the USER runs, and the
 * only tier here that is both keyless and clean to recommend in a public repo.
 * One GET against {@code /search?q=…&format=json}, parsed into hits; when the
 * instance does not serve JSON, one more GET for the same instance's HTML
 * results page, parsed into the same hits (card 448).
 *
 * <p>Three measured facts shape this class, and each one is a day someone would
 * otherwise spend:</p>
 *
 * <ol>
 *   <li><b>Stock SearXNG does not answer JSON.</b> Its shipped
 *       {@code settings.yml} lists only {@code html} under {@code search.formats},
 *       and a request for an unlisted format is answered <b>403</b>. Measured
 *       again on 2026-09-26 against three releases of the public image with
 *       that file untouched (2025.3.19-40feede51, 2026.8.12-cdfdaa5a8,
 *       2026.9.25-12f8b6515): each answered {@code format=json} with 403 and
 *       the plain search with a 200 HTML page. Until card 448 that 403 ended
 *       the search. Now this class reads that HTML page instead, from the same
 *       instance, so a plain {@code docker run} answers. {@code samples/09-searxng} still turns
 *       the JSON format on, because JSON is one request instead of two and
 *       carries the fields as data rather than as markup.</li>
 *   <li><b>A naive client is refused by its bot detection.</b> Spring's
 *       RestClient sends {@code User-Agent: Java/<version>}, and the shipped
 *       regex in {@code searx/botdetection/http_user_agent.py} matches the bare
 *       word {@code Java}; {@code http_accept_encoding.py} additionally refuses
 *       a request whose {@code Accept-Encoding} names neither gzip nor deflate.
 *       Measured 2026-08-13 against an instance with the limiter armed: the
 *       naive request is answered <b>429 text/html</b>, the request this class
 *       sends is answered <b>200 application/json</b>. So a real UA and
 *       browser-shaped Accept headers go on every request — and because we ask
 *       for compression, the answer is decompressed here (the JDK's HTTP stack
 *       does not do it for us).</li>
 *   <li><b>There is no result-count parameter.</b> The cut to {@code maxResults}
 *       happens on this side.</li>
 * </ol>
 *
 * <p>Every failure names the address that was dialled and distinguishes the
 * shapes an operator can actually be in: unreachable, the bot wall (429), any
 * other status, and an HTML page that is not a results page (a challenge page
 * that claims success). A 403 to {@code format=json}, or a 200 whose body is
 * HTML, is no longer a failure of its own: it sends this class to the HTML
 * page, and only that page's answer can still fail the search. That is the
 * honesty rule from card 193; "search failed" would leave a reader guessing
 * between a dead container and a config file.</p>
 *
 * <p>No other tier is ever asked (card 203). The HTML page belongs to the
 * configured instance, and a page this class cannot read is a failure, never
 * "no results".</p>
 *
 * <p>Public instances are not a plan: measured 2026-08-12, of 75 healthy public
 * instances exactly ONE answered {@code application/json}. This field is for an
 * instance you run.</p>
 */
public final class SearxngSearcher implements WebSearcher {

    /** Sent on every request — SearXNG's bot regex matches the word "Java",
     *  which is exactly what Spring's default User-Agent contains. Same string
     *  the DuckDuckGo tier already uses. */
    static final String USER_AGENT = "Mozilla/5.0 (compatible; spectro-web-search)";

    /** How long a single SearXNG query may take before this tier is treated as
     *  dead and the next one is tried. Short on purpose: the tiers fall through
     *  in order, so a slow tier costs every tier behind it. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.SECONDS)
    private static final Duration TIMEOUT = Duration.ofSeconds(15);
    private static final ObjectMapper JSON = new ObjectMapper();

    /** One result on the HTML page. Every result template of the simple theme
     *  renders as an {@code article} with class {@code result}; counted on the
     *  saved pages, 20 of 20 and 39 of 39. */
    private static final Pattern ARTICLE = Pattern.compile(
            "<article\\b[^>]*class=\"[^\"]*\\bresult\\b[^\"]*\"[^>]*>(.*?)</article>", Pattern.DOTALL);

    /** The result's title link: the first anchor inside its {@code h3}. */
    private static final Pattern TITLE = Pattern.compile(
            "<h3\\b[^>]*>\\s*<a\\b[^>]*\\bhref=\"([^\"]*)\"[^>]*>(.*?)</a>", Pattern.DOTALL);

    /** The snippet, when the engine had one. */
    private static final Pattern CONTENT = Pattern.compile(
            "<p\\b[^>]*class=\"content\"[^>]*>(.*?)</p>", Pattern.DOTALL);

    /** The results column. The theme renders it on every results page, with
     *  results or with the no-results notice, and a challenge page has none. */
    private static final String RESULTS_COLUMN = "id=\"urls\"";

    /** A character reference: decimal, hexadecimal, or one of the named ones
     *  the theme's escaping emits. */
    private static final Pattern ENTITY = Pattern.compile(
            "&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);");

    private final String baseUrl;
    private final RestClient http;

    /**
     * The searcher against one instance.
     *
     * @param baseUrl the instance root as the operator configured it, e.g.
     *                {@code http://localhost:8888}; a trailing slash is trimmed
     *                so the request path cannot become {@code //search}
     */
    public SearxngSearcher(String baseUrl) {
        this.baseUrl = normalize(baseUrl);
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) TIMEOUT.toMillis());
        factory.setReadTimeout((int) TIMEOUT.toMillis());
        this.http = RestClient.builder()
                .requestFactory(factory)
                .baseUrl(this.baseUrl)
                .defaultHeader("User-Agent", USER_AGENT)
                .defaultHeader("Accept", "application/json,text/html;q=0.9,*/*;q=0.8")
                .defaultHeader("Accept-Language", "en-US,en;q=0.9")
                // Named because the bot check demands it, honoured because we
                // decode the answer ourselves below.
                .defaultHeader("Accept-Encoding", "gzip, deflate")
                .build();
    }

    /** The self-hosted tier's name — surfaced in the tool description, results and doctor. */
    @Override
    public String tier() {
        return "searxng";
    }

    /** The instance this searcher dials, as configured — every failure sentence names it.
     *  @return the normalized base URL */
    public String address() {
        return baseUrl;
    }

    /** One GET for JSON, and the HTML page when the instance serves none;
     *  each failure shape becomes its own sentence, naming this address. */
    @Override
    public List<Hit> search(String query, int maxResults) {
        return answer(query, maxResults).hits();
    }

    /**
     * The hits, and which of the instance's two answers carried them. The
     * tool's result header reads the second half; {@link #search} drops it.
     *
     * @param query      the search query
     * @param maxResults hard cut on the number of returned hits
     * @return the hits and whether they came from the HTML results page
     */
    Answer answer(String query, int maxResults) {
        ResponseEntity<byte[]> response = get(query, true);

        int status = response.getStatusCode().value();
        if (status == 403) {
            // Stock SearXNG: html is the only listed format, so JSON is refused
            // and the same instance's results page is the answer (card 448).
            return new Answer(readHtmlPage(query, maxResults, "refused format=json (HTTP 403)"), true);
        }
        if (status == 429) {
            // Measured 2026-08-13 against an instance with the limiter armed
            // (limiter.toml + valkey): a request carrying Spring's default
            // "Java/21.0.5" User-Agent and no Accept-Encoding is answered 429
            // with an HTML body, while the headers this class sends are
            // answered 200 application/json. Reported as a plain status, this
            // reads like the instance being busy, which sends the operator to
            // wait instead of to look at their limiter.
            throw botWall(endpoint());
        }
        if (status != 200) {
            throw new IllegalStateException("searxng at " + endpoint()
                    + " answered HTTP " + status + " instead of results.");
        }

        String body = decode(response);
        if (!looksLikeJson(body)) {
            // HTML under status 200: the format switch again, or a proxy or a
            // challenge in front of the instance. The results page decides
            // which, and says so if it is not one.
            return new Answer(readHtmlPage(query, maxResults, "answered format=json with HTML"), true);
        }
        return new Answer(parse(body, maxResults), false);
    }

    /**
     * What one search produced.
     *
     * @param hits         the hits in the instance's order
     * @param fromHtmlPage whether they were read from the HTML results page
     *                     rather than from JSON
     */
    record Answer(List<Hit> hits, boolean fromHtmlPage) { }

    /**
     * The same search against the same instance, as the page a browser gets.
     *
     * @param query      the search query
     * @param maxResults hard cut on the number of returned hits
     * @param jsonFate   what the JSON request met, for the sentence a refused
     *                   page produces
     * @return the hits on the page; empty for a genuine no-results page
     */
    private List<Hit> readHtmlPage(String query, int maxResults, String jsonFate) {
        ResponseEntity<byte[]> response = get(query, false);
        int status = response.getStatusCode().value();
        if (status == 429) {
            throw botWall(pageEndpoint());
        }
        if (status != 200) {
            throw new IllegalStateException("searxng at " + baseUrl + " " + jsonFate
                    + ", and its HTML results page at " + pageEndpoint()
                    + " answered HTTP " + status + " instead of results.");
        }
        HtmlPage page = readResultsPage(decode(response), maxResults);
        if (!page.resultsPage()) {
            throw new IllegalStateException("searxng at " + baseUrl + " " + jsonFate
                    + ", and what " + pageEndpoint() + " sent is not a results page: most likely a "
                    + "challenge from its bot protection, or a proxy in front of the instance.");
        }
        if (page.hits().isEmpty() && page.articles() > 0) {
            throw new IllegalStateException("searxng at " + pageEndpoint() + " sent a results page with "
                    + page.articles() + (page.articles() == 1 ? " result" : " results")
                    + " this build cannot read. The page layout may have changed in this release of "
                    + "SearXNG; switching on \"json\" under search.formats in its settings.yml avoids "
                    + "the page altogether.");
        }
        return page.hits();
    }

    /**
     * One GET on {@code /search}, with every status handed back rather than
     * thrown, so each one can become its own sentence.
     *
     * @param query the search query
     * @param json  whether to ask for {@code format=json}; the HTML page when false
     * @return the raw answer
     */
    private ResponseEntity<byte[]> get(String query, boolean json) {
        try {
            return http.get()
                    .uri(builder -> {
                        builder.path("/search").queryParam("q", query);
                        if (json) {
                            builder.queryParam("format", "json");
                        }
                        return builder.build();
                    })
                    // Status handling belongs above, in whole sentences. The
                    // default handler would throw a bare "403 Forbidden", which
                    // is the single most misleading thing this tier can say.
                    .retrieve()
                    .onStatus(status -> true, (request, ignored) -> { })
                    .toEntity(byte[].class);
        } catch (ResourceAccessException unreachable) {
            throw new IllegalStateException("searxng at " + (json ? endpoint() : pageEndpoint())
                    + " did not answer: " + rootCause(unreachable) + ". Check that the instance is "
                    + "running and that this address is the one it listens on.");
        }
    }

    /**
     * The 429 sentence, for whichever of the two requests met the bot wall.
     *
     * @param address the endpoint that answered 429
     * @return the failure to throw
     */
    private static IllegalStateException botWall(String address) {
        return new IllegalStateException("searxng at " + address + " answered HTTP 429 — "
                + "its bot protection refused this request. Either the limiter is rate "
                + "limiting this client, or the instance is a public one that does not "
                + "serve JSON to programs at all.");
    }

    /**
     * What the HTML page held.
     *
     * @param hits        the results read, cut to size
     * @param resultsPage whether the page is a results page at all
     * @param articles    how many result elements the page carried, read or not
     */
    record HtmlPage(List<Hit> hits, boolean resultsPage, int articles) { }

    /**
     * Reads SearXNG's HTML results page (the simple theme, the only one the
     * releases since 2023 ship). Each result is an {@code article}; its title
     * link is the anchor in its {@code h3}, its snippet the paragraph with class
     * {@code content}. Pinned to pages saved from releases 2026.8.12-cdfdaa5a8
     * and 2026.9.25-12f8b6515; the later one wraps each result in an extra
     * {@code div} and groups the page by template, and both read the same.
     *
     * @param page       the decoded HTML
     * @param maxResults hard cut on the number of returned hits
     * @return what the page held
     */
    static HtmlPage readResultsPage(String page, int maxResults) {
        List<Hit> hits = new ArrayList<>();
        int articles = 0;
        Matcher article = ARTICLE.matcher(page);
        while (article.find()) {
            articles++;
            if (hits.size() >= maxResults) {
                continue;
            }
            String body = article.group(1);
            Matcher title = TITLE.matcher(body);
            if (!title.find()) {
                continue;
            }
            Matcher content = CONTENT.matcher(body);
            hits.add(new Hit(text(title.group(2)), decodeEntities(title.group(1)).strip(),
                    content.find() ? text(content.group(1)) : ""));
        }
        return new HtmlPage(List.copyOf(hits), page.contains(RESULTS_COLUMN), articles);
    }

    /**
     * Markup to one line of text. Tags go without a trace, because inside a
     * title or snippet they are inline: SearXNG wraps each query term in a
     * {@code span}, and a space in its place would split "kotlin-stdlib" into
     * two words. Character references are decoded in one pass after the tags
     * are gone, so an escaped ampersand never decodes twice. Every run of
     * whitespace, the no-break space included, becomes one space.
     *
     * @param html a title or snippet as the page carries it
     * @return plain text with whitespace collapsed
     */
    private static String text(String html) {
        String noTags = html.replaceAll("(?s)<[^>]*>", "");
        // U+00A0 as well: the 2026.8.12 page puts a raw no-break space before
        // a snippet's closing "...", and "\\s" alone does not match it.
        return decodeEntities(noTags).replaceAll("[\\s\u00A0]+", " ").strip();
    }

    /**
     * Decodes the character references the theme's escaping emits.
     *
     * @param escaped text with references
     * @return the text with each reference replaced by its character
     */
    private static String decodeEntities(String escaped) {
        Matcher m = ENTITY.matcher(escaped);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            String name = m.group(1);
            String replacement = switch (name) {
                case "amp" -> "&";
                case "lt" -> "<";
                case "gt" -> ">";
                case "quot" -> "\"";
                case "apos" -> "'";
                case "nbsp" -> " ";
                default -> {
                    int code = name.startsWith("#x")
                            ? Integer.parseInt(name.substring(2), 16)
                            : Integer.parseInt(name.substring(1));
                    yield Character.isValidCodePoint(code) ? Character.toString(code) : m.group();
                }
            };
            m.appendReplacement(out, Matcher.quoteReplacement(replacement));
        }
        m.appendTail(out);
        return out.toString();
    }

    /**
     * The concrete address every sentence above names — the instance plus the
     * one path this tier ever calls. The query itself is deliberately left out:
     * it is the user's text, and a failure sentence is read by a human who
     * already knows what they asked.
     *
     * @return e.g. {@code http://localhost:8888/search?format=json}
     */
    private String endpoint() {
        return baseUrl + "/search?format=json";
    }

    /**
     * The HTML results page's address, named the same way: the path, without
     * the user's query.
     *
     * @return e.g. {@code http://localhost:8888/search}
     */
    private String pageEndpoint() {
        return baseUrl + "/search";
    }

    /**
     * The hits, cut to size. SearXNG has no count parameter, so the instance
     * always sends its full page and the cut happens here.
     *
     * @param body       the JSON answer
     * @param maxResults hard cut on the number of returned hits
     * @return the hits in ranking order; empty for a genuine no-results answer
     */
    private List<Hit> parse(String body, int maxResults) {
        Response parsed;
        try {
            parsed = JSON.readValue(body, Response.class);
        } catch (IOException notParseable) {
            throw new IllegalStateException("searxng at " + endpoint()
                    + " answered JSON this build cannot read: " + notParseable.getMessage());
        }
        if (parsed == null || parsed.results() == null) {
            return List.of();
        }
        return parsed.results().stream()
                .limit(maxResults)
                .map(result -> new Hit(orEmpty(result.title()), orEmpty(result.url()),
                        orEmpty(result.content())))
                .toList();
    }

    /**
     * The response body as text, decompressed when the instance took the gzip
     * or deflate offer this client makes. The JDK's HTTP stack hands back the
     * raw bytes, so asking for compression without decoding it here would turn
     * a well-proxied instance into an unreadable one.
     *
     * @param response the raw answer
     * @return the body as UTF-8 text; the raw bytes when no encoding was named
     */
    private static String decode(ResponseEntity<byte[]> response) {
        byte[] raw = response.getBody();
        if (raw == null || raw.length == 0) {
            return "";
        }
        String encoding = response.getHeaders().getFirst(HttpHeaders.CONTENT_ENCODING);
        String coding = encoding == null ? "" : encoding.toLowerCase(Locale.ROOT).trim();
        try {
            if (coding.contains("gzip")) {
                try (var in = new GZIPInputStream(new ByteArrayInputStream(raw))) {
                    return new String(in.readAllBytes(), StandardCharsets.UTF_8);
                }
            }
            if (coding.contains("deflate")) {
                try (var in = new InflaterInputStream(new ByteArrayInputStream(raw))) {
                    return new String(in.readAllBytes(), StandardCharsets.UTF_8);
                }
            }
        } catch (IOException notCompressedAfterAll) {
            // A header that lies about the body is not worth a crash: fall
            // through to the raw bytes, which the JSON check below judges.
            return new String(raw, StandardCharsets.UTF_8);
        }
        return new String(raw, StandardCharsets.UTF_8);
    }

    /**
     * Whether a 200 body is the JSON we asked for or a page meant for a browser.
     * Judged on the body rather than on Content-Type because the anti-bot page
     * is the case this exists for, and a challenge page is free to claim any
     * content type it likes.
     *
     * @param body the decoded response body
     * @return true when the body opens as a JSON object or array
     */
    private static boolean looksLikeJson(String body) {
        String head = body.stripLeading();
        return head.startsWith("{") || head.startsWith("[");
    }

    /**
     * The innermost cause's message — a bare {@code ResourceAccessException}
     * message repeats the URL we are already printing.
     *
     * @param failure the transport failure
     * @return the deepest cause's message, or the failure's own
     */
    private static String rootCause(Throwable failure) {
        Throwable cause = failure;
        while (cause.getCause() != null) {
            cause = cause.getCause();
        }
        String message = cause.getMessage();
        return message == null || message.isBlank() ? cause.getClass().getSimpleName() : message;
    }

    /**
     * Trims a trailing slash off the configured URL.
     *
     * @param url the address as configured
     * @return the same address without a trailing slash
     */
    private static String normalize(String url) {
        String trimmed = url == null ? "" : url.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }

    /**
     * Null-tolerant field access — SearXNG omits fields an engine had no value for.
     *
     * @param value the parsed field, possibly null
     * @return the value, or "" when absent
     */
    private static String orEmpty(String value) {
        return value == null ? "" : value;
    }

    /** SearXNG's JSON answer, reduced to what web_search needs.
     *  @param results the merged, ranked hits; null when the instance sends none */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Response(List<Result> results) { }

    /** One merged hit on the wire.
     *  @param title   the page title; may be null
     *  @param url     the page URL; may be null
     *  @param content SearXNG's snippet field — the one field name that differs
     *                 from {@link Hit}; may be null */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Result(String title, String url, String content) { }
}
