package dev.spectroscope.core.web;

import java.util.List;

/**
 * The search seam for {@link WebSearchTool} — the port-style analog of
 * image/ImageProvider and tools/HttpFetcher. Production wiring supplies the
 * tiered backend ({@link TavilySearcher} when TAVILY_API_KEY is set, else the
 * keyless {@link DuckDuckGoSearcher}); tests inject an in-memory fake, so the
 * tool is key-free AND network-free.
 */
public interface WebSearcher {

    /** The tier name the tool surfaces to the model, the UI and doctor.
     *  @return {@code "tavily"} or {@code "duckduckgo"} */
    String tier();

    /**
     * One blocking search — the single point where web_search touches the
     * network. Transport failures may throw RuntimeExceptions; the tool maps
     * them onto "ERROR: " strings.
     *
     * @param query      the search query, already vetted non-blank by the tool
     * @param maxResults the maximum number of hits to return, already clamped
     * @return the hits in ranking order; empty when nothing was found
     */
    List<Hit> search(String query, int maxResults);

    /** One search hit, reduced to what web_search shows the model.
     *
     *  @param title   the result's title, plain text
     *  @param url     the result's absolute URL
     *  @param snippet the engine's content snippet, plain text; may be empty */
    record Hit(String title, String url, String snippet) {}
}
