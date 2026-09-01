package dev.spectroscope.core.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolOutput;

import java.util.List;
import java.util.function.Supplier;

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

    /** The shared tool-output clamp, read from {@link ToolOutput} rather than
     *  kept as a second copy of the same number. */
    @Governs(kind = Governs.Kind.ALIAS, unit = Governs.Unit.CHARACTERS)
    private static final int MAX_OUTPUT_CHARS = ToolOutput.MAX_OUTPUT_CHARS;

    /** Hits per search when the model does not ask for a count. */
    @Governs(kind = Governs.Kind.MODEL_CHOICE, unit = Governs.Unit.COUNT)
    static final int DEFAULT_MAX_RESULTS = 5;

    /** Hard ceiling on hits per search — more is noise in the context window. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    static final int MAX_MAX_RESULTS = 10;

    private final Supplier<WebSearcher> searcher;

    /**
     * Builds the tool over a fixed search seam — the shape every test wants, and
     * the honest shape for a one-shot caller like {@code spectro doctor}.
     *
     * @param searcher the tiered production backend from {@link #fromConfig}, or an in-memory fake in tests
     */
    public WebSearchTool(WebSearcher searcher) {
        this(() -> searcher);
    }

    /**
     * Builds the tool over a search seam resolved PER CALL.
     *
     * <p>Card 222. The tier is a decision about the current configuration, and a
     * session's registry is built exactly once — so a tier resolved at
     * construction is a decision about the configuration as it stood at the
     * first prompt, which is not what the settings page shows and not what the
     * operator just saved. Both {@link #execute} and {@link #description()} ask
     * again, so the result header and the sentence the model reads name the
     * machine that is going to answer.</p>
     *
     * @param searcher yields the backend for THIS call
     */
    public WebSearchTool(Supplier<WebSearcher> searcher) {
        this.searcher = searcher;
    }

    /**
     * The production wiring: {@link WebSearchTiers} decides, this builds. The
     * config carries the saved SearXNG address; the keys come from the same
     * places every other key does (the process environment, then
     * {@code ~/.spectro/.env}).
     *
     * <p>This overload freezes the decision on the config it is handed — right
     * for a caller that resolves the config and then answers once ({@code spectro
     * doctor}, {@code /api/context}), wrong for a session. Sessions take
     * {@link #fromConfig(Supplier)}.</p>
     *
     * @param config the resolved settings hierarchy
     * @return the tool over the ONE tier the configuration selects
     */
    public static WebSearchTool fromConfig(SpectroConfig config) {
        return fromConfig(() -> config);
    }

    /**
     * The session wiring: the settings are read again on every call, so an
     * address saved while the session is open decides the next search.
     *
     * @param config yields the settings hierarchy as it stands right now
     * @return the tool over whichever tier that configuration selects, per call
     */
    public static WebSearchTool fromConfig(Supplier<SpectroConfig> config) {
        return new WebSearchTool(() -> WebSearchTiers.searcher(
                WebSearchTiers.forConfig(config.get()), SpectroConfig::resolveApiKey));
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
        WebSearcher active = searcher.get();
        return "Searches the web via " + WebSearchTiers.describe(new WebSearchTiers.Choice(
                active.tier(), addressOf(active)))
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

        // ONE resolution for this call, so the tier that searched and the tier
        // the header names are the same object and cannot drift inside a call
        // even if the settings are saved while the search is in flight.
        WebSearcher active = searcher.get();

        // The whole downstream sits in one guard (the WebFetchTool pattern):
        // a throwing seam surfaces as an ERROR string, never as an exception.
        try {
            List<WebSearcher.Hit> hits = active.search(query, maxResults);
            if (hits == null || hits.isEmpty()) {
                return "No results for \"" + query + "\" ("
                        + WebSearchTiers.label(active.tier()) + ").";
            }
            return ToolOutput.clip(format(query, hits, active), MAX_OUTPUT_CHARS);
        } catch (RuntimeException failure) {
            return "ERROR: web_search failed: " + failure.getMessage();
        }
    }

    /**
     * The numbered hit list under a header that names the tier and the query.
     *
     * @param query  the vetted search query, echoed in the header
     * @param hits   the backend's hits in ranking order
     * @param active the backend that produced them — passed in rather than
     *               re-resolved, so the header can only ever name the machine
     *               that actually answered
     * @return the readable result block
     */
    private String format(String query, List<WebSearcher.Hit> hits, WebSearcher active) {
        StringBuilder out = new StringBuilder(
                "Results (" + WebSearchTiers.label(active.tier()) + ") for \"" + query + "\":\n");
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
