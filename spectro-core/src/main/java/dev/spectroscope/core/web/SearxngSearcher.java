package dev.spectroscope.core.web;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.zip.GZIPInputStream;
import java.util.zip.InflaterInputStream;

/**
 * The SearXNG tier of web_search — a metasearch instance the USER runs, and the
 * only tier here that is both keyless and clean to recommend in a public repo.
 * One GET against {@code /search?q=…&format=json}, parsed into hits.
 *
 * <p>Three measured facts shape this class, and each one is a day someone would
 * otherwise spend:</p>
 *
 * <ol>
 *   <li><b>Stock SearXNG does not answer JSON.</b> Its shipped
 *       {@code settings.yml} lists only {@code html} under {@code search.formats},
 *       and a request for an unlisted format is answered <b>403</b>. A plain
 *       {@code docker run} therefore yields a perfectly good search page and an
 *       API that hands this class nothing. {@code samples/07-searxng} is the
 *       setup that turns the format on; the settings page prints it.</li>
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
 * shapes an operator can actually be in — unreachable, JSON not enabled (403),
 * the bot wall (429), and an HTML answer with status 200 (the format switch
 * again, or a challenge page that claims success). That is the honesty rule
 * from card 193; "search failed" would leave a reader guessing between a dead
 * container and a config file.</p>
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

    private static final Duration TIMEOUT = Duration.ofSeconds(15);
    private static final ObjectMapper JSON = new ObjectMapper();

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

    /** One GET for JSON; each failure shape becomes its own sentence, naming this address. */
    @Override
    public List<Hit> search(String query, int maxResults) {
        ResponseEntity<byte[]> response;
        try {
            response = http.get()
                    .uri(builder -> builder.path("/search")
                            .queryParam("q", query)
                            .queryParam("format", "json")
                            .build())
                    // Status handling belongs below, in whole sentences. The
                    // default handler would throw a bare "403 Forbidden", which
                    // is the single most misleading thing this tier can say.
                    .retrieve()
                    .onStatus(status -> true, (request, ignored) -> { })
                    .toEntity(byte[].class);
        } catch (ResourceAccessException unreachable) {
            throw new IllegalStateException("searxng at " + endpoint() + " did not answer: "
                    + rootCause(unreachable) + ". Check that the instance is running and that "
                    + "this address is the one it listens on.");
        }

        int status = response.getStatusCode().value();
        if (status == 403) {
            throw new IllegalStateException("searxng at " + endpoint() + " refused format=json "
                    + "(HTTP 403). Stock SearXNG serves HTML only: add \"json\" under "
                    + "search.formats in its settings.yml and restart the instance.");
        }
        if (status == 429) {
            // Measured 2026-08-13 against an instance with the limiter armed
            // (limiter.toml + valkey): a request carrying Spring's default
            // "Java/21.0.5" User-Agent and no Accept-Encoding is answered 429
            // with an HTML body, while the headers this class sends are
            // answered 200 application/json. Reported as a plain status, this
            // reads like the instance being busy, which sends the operator to
            // wait instead of to look at their limiter.
            throw new IllegalStateException("searxng at " + endpoint() + " answered HTTP 429 — "
                    + "its bot protection refused this request. Either the limiter is rate "
                    + "limiting this client, or the instance is a public one that does not "
                    + "serve JSON to programs at all.");
        }
        if (status != 200) {
            throw new IllegalStateException("searxng at " + endpoint()
                    + " answered HTTP " + status + " instead of results.");
        }

        String body = decode(response);
        if (!looksLikeJson(body)) {
            throw new IllegalStateException("searxng at " + endpoint() + " answered HTML, not JSON, "
                    + "with status 200. Either its settings.yml does not list \"json\" under "
                    + "search.formats, or its bot protection served a challenge page to this client.");
        }
        return parse(body, maxResults);
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
