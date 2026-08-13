package dev.spectroscope.core.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolOutput;

import java.util.List;

/**
 * The {@code web_search} tool: a query in, a numbered hit list (title, URL,
 * snippet) out. The backend is TIERED — {@link SearxngSearcher} for an instance
 * the user runs, {@link TavilySearcher} or {@link BraveSearcher} for a keyed
 * provider, and the keyless {@link DuckDuckGoSearcher} scrape as the labeled
 * last resort — and WHICH tier is chosen is decided in exactly one place,
 * {@link WebSearchTiers}. The active tier is named in the description (the UI's
 * System-Kontext tab reads it), in every result header and in
 * {@code spectroscope doctor}, all from that one resolver, so the four surfaces
 * cannot describe different machines.
 *
 * <p>Exactly one tier ever answers. When the configured tier fails, the failure
 * is what the user gets — no lower tier is tried behind their back (card 203,
 * criterion 8).</p>
 *
 * <p>Network egress on untrusted (model-supplied) input, so it is
 * permission-gated exactly like web_fetch. The search goes through the injected
 * {@link WebSearcher} seam (the resolved backend in production, a fake in
 * tests).</p>
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
     * The production wiring: {@link WebSearchTiers} decides, this builds. The
     * config carries the saved SearXNG address; the keys come from the same
     * places every other key does (the process environment, then
     * {@code ~/.spectro/.env}).
     *
     * @param config the resolved settings hierarchy
     * @return the tool over the ONE tier the configuration selects
     */
    public static WebSearchTool fromConfig(SpectroConfig config) {
        return new WebSearchTool(WebSearchTiers.searcher(
                WebSearchTiers.forConfig(config), SpectroConfig::resolveApiKey));
    }

    /** Wire name: {@code web_search}. */
    @Override
    public String name() {
        return "web_search";
    }

    /** The model-facing one-liner — names the ACTIVE tier in the resolver's own
     *  words, so the model, the settings page and the doctor read the same
     *  sentence about the same machine. */
    @Override
    public String description() {
        return "Searches the web via " + WebSearchTiers.describe(new WebSearchTiers.Choice(
                searcher.tier(), addressOf(searcher)))
                + " and returns titles, URLs and snippets. "
                + "Network egress — guarded by permission.";
    }

    /**
     * The address a self-hosted tier dials, for the sentence above. Only the
     * SearXNG tier has one; every other tier's sentence names a variable or
     * nothing at all.
     *
     * @param searcher the active backend
     * @return the instance address, or null
     */
    private static String addressOf(WebSearcher searcher) {
        return searcher instanceof SearxngSearcher searxng ? searxng.address() : null;
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
                return "No results for \"" + query + "\" ("
                        + WebSearchTiers.label(searcher.tier()) + ").";
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
                "Results (" + WebSearchTiers.label(searcher.tier()) + ") for \"" + query + "\":\n");
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
