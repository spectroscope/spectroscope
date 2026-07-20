package dev.spectroscope.core.web;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.support.RestClientAdapter;
import org.springframework.web.service.annotation.PostExchange;
import org.springframework.web.service.invoker.HttpServiceProxyFactory;

import java.time.Duration;
import java.util.List;

/**
 * The Tavily tier of web_search — the paid, LLM-oriented search API, selected
 * when TAVILY_API_KEY is set. One POST to {@code /search} with Bearer auth,
 * spoken through a declarative HTTP interface + typed wire records (the house
 * style; OllamaApi is the template). Finite connect/read timeouts so a stalled
 * endpoint cannot pin a thread; a 401 answers with a readable pointer at the
 * env var instead of a bare status.
 */
public final class TavilySearcher implements WebSearcher {

    /** Tavily's production endpoint; tests point the second constructor at a mock. */
    static final String DEFAULT_BASE_URL = "https://api.tavily.com";

    private static final Duration TIMEOUT = Duration.ofSeconds(15);

    private final TavilyApi api;

    /**
     * The production searcher against api.tavily.com.
     *
     * @param apiKey the TAVILY_API_KEY value, sent as a Bearer token
     */
    public TavilySearcher(String apiKey) {
        this(apiKey, DEFAULT_BASE_URL);
    }

    /**
     * Visible for tests: same wiring, mock base URL.
     *
     * @param apiKey  the Bearer token value
     * @param baseUrl the server to talk to — a local mock in tests
     */
    TavilySearcher(String apiKey, String baseUrl) {
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) TIMEOUT.toMillis());
        factory.setReadTimeout((int) TIMEOUT.toMillis());
        RestClient client = RestClient.builder()
                .requestFactory(factory)
                .baseUrl(baseUrl)
                .defaultHeader("Authorization", "Bearer " + apiKey)
                .build();
        this.api = HttpServiceProxyFactory
                .builderFor(RestClientAdapter.create(client))
                .build()
                .createClient(TavilyApi.class);
    }

    /** The paid tier's name — surfaced in the tool description, results and doctor. */
    @Override
    public String tier() {
        return "tavily";
    }

    /** One search call; a 401 is remapped onto a message that names TAVILY_API_KEY. */
    @Override
    public List<Hit> search(String query, int maxResults) {
        TavilyApi.Response response;
        try {
            response = api.search(new TavilyApi.Request(query, maxResults));
        } catch (RestClientResponseException http) {
            if (http.getStatusCode().value() == 401) {
                throw new IllegalStateException(
                        "tavily rejected the key (HTTP 401) — check TAVILY_API_KEY.");
            }
            throw http;
        }
        if (response == null || response.results() == null) {
            return List.of();
        }
        return response.results().stream()
                .map(result -> new Hit(orEmpty(result.title()), orEmpty(result.url()),
                        orEmpty(result.content())))
                .toList();
    }

    /**
     * Null-tolerant field access — Tavily omits fields it has no value for.
     *
     * @param value the parsed field, possibly null
     * @return the value, or "" when absent
     */
    private static String orEmpty(String value) {
        return value == null ? "" : value;
    }

    /** Declarative HTTP interface for Tavily's search endpoint — Spring
     *  generates the implementation at runtime. PUBLIC on purpose (the
     *  OllamaApi template rule): a non-public interface can only be
     *  JDK-proxied by its exact defining loader — fine in tests, a 500 on
     *  the server's request threads. */
    public interface TavilyApi {

        /**
         * POST /search — the one call this tier makes.
         *
         * @param request the query plus the clamped hit count
         * @return the parsed response; unknown fields ignored
         */
        @PostExchange("/search")
        Response search(@RequestBody Request request);

        /** The search request body.
         *  @param query      the search query
         *  @param maxResults serialized as {@code max_results} — Tavily's wire name */
        record Request(String query, @JsonProperty("max_results") int maxResults) {}

        /** The search response body, reduced to what web_search needs.
         *  @param results the ranked hits; null when Tavily sends none */
        @JsonIgnoreProperties(ignoreUnknown = true)
        record Response(List<Result> results) {}

        /** One ranked hit on the wire.
         *  @param title   the page title; may be null
         *  @param url     the page URL; may be null
         *  @param content Tavily's extracted snippet; may be null */
        @JsonIgnoreProperties(ignoreUnknown = true)
        record Result(String title, String url, String content) {}
    }
}
