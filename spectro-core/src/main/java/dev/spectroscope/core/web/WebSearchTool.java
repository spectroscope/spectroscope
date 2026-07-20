package dev.spectroscope.core.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolOutput;

import java.util.List;
import java.util.Map;

/**
 * The {@code web_search} tool: a query in, a numbered hit list (title, URL,
 * snippet) out. The backend is TIERED — {@link TavilySearcher} when
 * TAVILY_API_KEY is set, else the keyless {@link DuckDuckGoSearcher} — and the
 * active tier is named in the description (the UI's System-Kontext tab reads
 * it), in every result header and in {@code spectroscope doctor}. Network egress on
 * untrusted (model-supplied) input, so it is permission-gated exactly like
 * web_fetch. The search goes through the injected {@link WebSearcher} seam
 * (the tiered backend in production, a fake in tests).
 */
public final class WebSearchTool implements Tool {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int MAX_OUTPUT_CHARS = ToolOutput.MAX_OUTPUT_CHARS;

    /** Hits per search when the model does not ask for a count. */
    static final int DEFAULT_MAX_RESULTS = 5;

    /** Hard ceiling on hits per search — more is noise in the context window. */
    static final int MAX_MAX_RESULTS = 10;

    private final WebSearcher searcher;

    /**
     * Builds the tool over the injected search seam.
     *
     * @param searcher the tiered production backend from {@link #fromEnv}, or an in-memory fake in tests
     */
    public WebSearchTool(WebSearcher searcher) {
        this.searcher = searcher;
    }

    /**
     * The production tier decision, in one place: Tavily when TAVILY_API_KEY
     * is set and non-blank, else the keyless DuckDuckGo HTML fallback. The
     * env comes in as a map so tests can steer the tier without touching the
     * real environment.
     *
     * @param env the process environment (System.getenv() in production)
     * @return the tool over the tier the environment selects
     */
    public static WebSearchTool fromEnv(Map<String, String> env) {
        String key = env.get("TAVILY_API_KEY");
        return new WebSearchTool(key != null && !key.isBlank()
                ? new TavilySearcher(key)
                : new DuckDuckGoSearcher());
    }

    /** Wire name: {@code web_search}. */
    @Override
    public String name() {
        return "web_search";
    }

    /** The model-facing one-liner — names the ACTIVE tier; the fallback tier hints at the missing key. */
    @Override
    public String description() {
        String backend = "tavily".equals(searcher.tier())
                ? "the Tavily API"
                : "the keyless DuckDuckGo HTML fallback (set TAVILY_API_KEY for the Tavily tier)";
        return "Searches the web via " + backend + " and returns titles, URLs and "
                + "snippets. Network egress — guarded by permission.";
    }

    /** Required string {@code query}; optional integer {@code max_results} (default 5, max 10). */
    @Override
    public JsonNode inputSchema() {
        ObjectNode schema = JSON.createObjectNode();
        schema.put("type", "object");
        ObjectNode properties = JSON.createObjectNode();
        properties.set("query", JSON.createObjectNode().put("type", "string"));
        properties.set("max_results", JSON.createObjectNode().put("type", "integer")
                .put("description", "how many hits to return (default "
                        + DEFAULT_MAX_RESULTS + ", max " + MAX_MAX_RESULTS + ")"));
        schema.set("properties", properties);
        schema.set("required", JSON.createArrayNode().add("query"));
        return schema;
    }

    /** Untrusted input reaching the network — the human stays in the loop. */
    @Override
    public boolean needsPermission() {
        return true;
    }

    /** Vets the query, searches through the seam and formats the numbered hit list — every failure path is an "ERROR: " string. */
    @Override
    public String execute(JsonNode input, ToolContext context) {
        String query = input.path("query").asText().strip();
        if (query.isBlank()) {
            return "ERROR: web_search needs a non-empty query.";
        }
        int maxResults = clampMaxResults(input.path("max_results").asInt(DEFAULT_MAX_RESULTS));

        // The whole downstream sits in one guard (the WebFetchTool pattern):
        // a throwing seam surfaces as an ERROR string, never as an exception.
        try {
            List<WebSearcher.Hit> hits = searcher.search(query, maxResults);
            if (hits == null || hits.isEmpty()) {
                return "No results for \"" + query + "\" (" + searcher.tier() + ").";
            }
            return ToolOutput.clip(format(query, hits), MAX_OUTPUT_CHARS);
        } catch (RuntimeException failure) {
            return "ERROR: web_search failed: " + failure.getMessage();
        }
    }

    /**
     * The numbered hit list under a header that names the tier and the query.
     *
     * @param query the vetted search query, echoed in the header
     * @param hits  the backend's hits in ranking order
     * @return the readable result block
     */
    private String format(String query, List<WebSearcher.Hit> hits) {
        StringBuilder out = new StringBuilder(
                "Results (" + searcher.tier() + ") for \"" + query + "\":\n");
        for (int i = 0; i < hits.size(); i++) {
            WebSearcher.Hit hit = hits.get(i);
            out.append('\n').append(i + 1).append(". ").append(hit.title()).append('\n')
                    .append("   ").append(hit.url()).append('\n');
            if (!hit.snippet().isBlank()) {
                out.append("   ").append(hit.snippet()).append('\n');
            }
        }
        return out.toString();
    }

    /**
     * Keeps the requested hit count inside [1, {@link #MAX_MAX_RESULTS}].
     *
     * @param requested the model-supplied max_results (or the default)
     * @return the clamped count the backend receives
     */
    private static int clampMaxResults(int requested) {
        return Math.max(1, Math.min(MAX_MAX_RESULTS, requested));
    }
}
