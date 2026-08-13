package dev.spectroscope.core.web;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.support.RestClientAdapter;
import org.springframework.web.service.annotation.GetExchange;
import org.springframework.web.service.invoker.HttpServiceProxyFactory;

import java.time.Duration;
import java.util.List;

/**
 * The Brave tier of web_search — Brave's own independent index, selected when
 * BRAVE_API_KEY is set and no SearXNG instance is configured. One GET to
 * {@code /res/v1/web/search} with the key in {@code X-Subscription-Token},
 * spoken through a declarative HTTP interface + typed wire records (the house
 * style; {@link TavilySearcher} is the sibling).
 *
 * <p>Two statuses get their own sentence, because the two are different jobs
 * for whoever reads them: a 401 is a key to replace, a 429 is the free plan's
 * one-query-per-second limit and the key is fine.</p>
 */
public final class BraveSearcher implements WebSearcher {

    /** Brave's production endpoint; tests point the second constructor at a mock. */
    static final String DEFAULT_BASE_URL = "https://api.search.brave.com";

    /** The env var this tier's key lives in. */
    static final String KEY_ENV = "BRAVE_API_KEY";

    private static final Duration TIMEOUT = Duration.ofSeconds(15);

    private final BraveApi api;

    /**
     * The production searcher against api.search.brave.com.
     *
     * @param apiKey the BRAVE_API_KEY value, sent as the subscription token
     */
    public BraveSearcher(String apiKey) {
        this(apiKey, DEFAULT_BASE_URL);
    }

    /**
     * Visible for tests: same wiring, mock base URL.
     *
     * @param apiKey  the subscription token value
     * @param baseUrl the server to talk to — a local mock in tests
     */
    BraveSearcher(String apiKey, String baseUrl) {
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) TIMEOUT.toMillis());
        factory.setReadTimeout((int) TIMEOUT.toMillis());
        RestClient client = RestClient.builder()
                .requestFactory(factory)
                .baseUrl(baseUrl)
                .defaultHeader("X-Subscription-Token", apiKey)
                .defaultHeader("Accept", "application/json")
                .build();
        this.api = HttpServiceProxyFactory
                .builderFor(RestClientAdapter.create(client))
                .build()
                .createClient(BraveApi.class);
    }

    /** The keyed independent-index tier's name — surfaced in the tool description, results and doctor. */
    @Override
    public String tier() {
        return "brave";
    }

    /** One search call; 401 and 429 are remapped onto the two different things they mean. */
    @Override
    public List<Hit> search(String query, int maxResults) {
        BraveApi.Response response;
        try {
            response = api.search(query, maxResults);
        } catch (RestClientResponseException http) {
            int status = http.getStatusCode().value();
            if (status == 401 || status == 403) {
                throw new IllegalStateException("brave rejected the key (HTTP " + status
                        + ") — check " + KEY_ENV + ".");
            }
            if (status == 429) {
                throw new IllegalStateException("brave answered HTTP 429 — the subscription's "
                        + "rate limit (the free plan allows one query per second). The key is fine; "
                        + "the calls are too close together.");
            }
            throw http;
        }
        if (response == null || response.web() == null || response.web().results() == null) {
            return List.of();
        }
        return response.web().results().stream()
                .map(result -> new Hit(orEmpty(result.title()), orEmpty(result.url()),
                        orEmpty(result.description())))
                .toList();
    }

    /**
     * Null-tolerant field access — Brave omits fields it has no value for.
     *
     * @param value the parsed field, possibly null
     * @return the value, or "" when absent
     */
    private static String orEmpty(String value) {
        return value == null ? "" : value;
    }

    /** Declarative HTTP interface for Brave's web-search endpoint — Spring
     *  generates the implementation at runtime. PUBLIC on purpose (the same
     *  rule that keeps TavilyApi public): a non-public interface can only be
     *  JDK-proxied by its exact defining loader — fine in tests, a 500 on the
     *  server's request threads. */
    public interface BraveApi {

        /**
         * GET /res/v1/web/search — the one call this tier makes.
         *
         * @param query the search query
         * @param count the clamped hit count, Brave's own parameter name
         * @return the parsed response; unknown fields ignored
         */
        @GetExchange("/res/v1/web/search")
        Response search(@RequestParam("q") String query, @RequestParam("count") int count);

        /** The search response body.
         *  @param web the web-results block; null when Brave answers with other verticals only */
        @JsonIgnoreProperties(ignoreUnknown = true)
        record Response(Web web) { }

        /** The web vertical.
         *  @param results the ranked hits; null when Brave sends none */
        @JsonIgnoreProperties(ignoreUnknown = true)
        record Web(List<Result> results) { }

        /** One ranked hit on the wire.
         *  @param title       the page title; may be null
         *  @param url         the page URL; may be null
         *  @param description Brave's snippet field — the one field name that
         *                     differs from {@link Hit}; may be null */
        @JsonIgnoreProperties(ignoreUnknown = true)
        record Result(String title, String url, String description) { }
    }
}
