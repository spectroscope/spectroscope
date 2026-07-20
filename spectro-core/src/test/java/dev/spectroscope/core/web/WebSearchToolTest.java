package dev.spectroscope.core.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * web_search against an in-memory WebSearcher — no HTTP at all. Proves the
 * numbered hit formatting with the tier named in the header, the blank-query /
 * thrown-exception ERROR paths (never throws), the max_results clamp, the
 * output cap, the tier-specific description (the DuckDuckGo fallback names the
 * missing TAVILY_API_KEY) and the permission flag. Key-free and network-free
 * by construction — the WebFetchTool test pattern.
 */
class WebSearchToolTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Answers instantly from memory and records the forwarded maxResults. */
    private static final class FakeSearcher implements WebSearcher {
        private final String tier;
        private final List<Hit> hits;
        final AtomicInteger lastMaxResults = new AtomicInteger(-1);

        FakeSearcher(String tier, List<Hit> hits) {
            this.tier = tier;
            this.hits = hits;
        }

        @Override
        public String tier() {
            return tier;
        }

        @Override
        public List<Hit> search(String query, int maxResults) {
            lastMaxResults.set(maxResults);
            return hits;
        }
    }

    private static ToolContext context() {
        return new ToolContext(Path.of("."), new CancelSignal());
    }

    private static JsonNode queryInput(String query) {
        return JSON.createObjectNode().put("query", query);
    }

    @Test
    void formatsHitsAsANumberedListWithTitleUrlAndSnippet() {
        Tool tool = new WebSearchTool(new FakeSearcher("tavily", List.of(
                new WebSearcher.Hit("Gradle Kotlin DSL", "https://docs.gradle.org/dsl",
                        "The Kotlin DSL reference."),
                new WebSearcher.Hit("Gradle Releases", "https://gradle.org/releases",
                        "All Gradle versions."))));

        String result = tool.execute(queryInput("gradle dsl"), context());

        assertTrue(result.startsWith("Results (tavily) for \"gradle dsl\":"),
                "header names tier and query, got: " + result);
        assertTrue(result.contains("1. Gradle Kotlin DSL"), "numbered title, got: " + result);
        assertTrue(result.contains("https://docs.gradle.org/dsl"), "url, got: " + result);
        assertTrue(result.contains("The Kotlin DSL reference."), "snippet, got: " + result);
        assertTrue(result.contains("2. Gradle Releases"), "second hit numbered, got: " + result);
    }

    @Test
    void blankQueryIsAnError() {
        Tool tool = new WebSearchTool(new FakeSearcher("tavily", List.of()));
        assertEquals("ERROR: web_search needs a non-empty query.",
                tool.execute(queryInput("   "), context()));
    }

    @Test
    void emptyHitsBecomeAReadableNoResultsAnswer() {
        Tool tool = new WebSearchTool(new FakeSearcher("duckduckgo", List.of()));
        assertEquals("No results for \"xyzzy\" (duckduckgo).",
                tool.execute(queryInput("xyzzy"), context()));
    }

    @Test
    void aThrowingSearcherBecomesAnErrorStringNeverAnException() {
        WebSearcher broken = new WebSearcher() {
            @Override
            public String tier() {
                return "tavily";
            }

            @Override
            public List<Hit> search(String query, int maxResults) {
                throw new RuntimeException("connect timed out");
            }
        };
        assertEquals("ERROR: web_search failed: connect timed out",
                new WebSearchTool(broken).execute(queryInput("anything"), context()));
    }

    @Test
    void maxResultsDefaultsToFiveAndClampsToTen() {
        FakeSearcher searcher = new FakeSearcher("tavily", List.of());
        Tool tool = new WebSearchTool(searcher);

        tool.execute(queryInput("a"), context());
        assertEquals(5, searcher.lastMaxResults.get(), "default max_results");

        tool.execute(((com.fasterxml.jackson.databind.node.ObjectNode) queryInput("a"))
                .put("max_results", 50), context());
        assertEquals(10, searcher.lastMaxResults.get(), "clamped max_results");
    }

    @Test
    void longOutputsAreClippedToTheSharedCap() {
        String longSnippet = "s".repeat(2_000);
        List<WebSearcher.Hit> many = java.util.stream.IntStream.rangeClosed(1, 10)
                .mapToObj(i -> new WebSearcher.Hit("Title " + i, "https://x/" + i, longSnippet))
                .toList();
        Tool tool = new WebSearchTool(new FakeSearcher("tavily", many));

        String result = tool.execute(queryInput("big"), context());

        assertEquals(10_000, result.length(), "output capped at MAX_OUTPUT_CHARS");
    }

    @Test
    void theTavilyTierDescriptionNamesTavily() {
        Tool tool = new WebSearchTool(new FakeSearcher("tavily", List.of()));
        assertTrue(tool.description().contains("Tavily"),
                "got: " + tool.description());
    }

    @Test
    void theFallbackTierDescriptionNamesTheMissingKey() {
        Tool tool = new WebSearchTool(new FakeSearcher("duckduckgo", List.of()));
        assertTrue(tool.description().contains("DuckDuckGo"),
                "names the fallback, got: " + tool.description());
        assertTrue(tool.description().contains("TAVILY_API_KEY"),
                "hints at the better tier, got: " + tool.description());
    }

    @Test
    void inputSchemaRequiresTheQueryString() {
        Tool tool = new WebSearchTool(new FakeSearcher("tavily", List.of()));
        JsonNode schema = tool.inputSchema();
        assertEquals("string", schema.path("properties").path("query").path("type").asText());
        assertTrue(schema.path("required").toString().contains("query"));
    }

    @Test
    void networkEgressNeedsPermission() {
        assertTrue(new WebSearchTool(new FakeSearcher("tavily", List.of())).needsPermission());
    }

    @Test
    void fromEnvPicksTavilyWhenTheKeyIsSet() {
        Tool tool = WebSearchTool.fromEnv(java.util.Map.of("TAVILY_API_KEY", "tvly-x"));
        assertTrue(tool.description().contains("Tavily API"), "got: " + tool.description());
    }

    @Test
    void fromEnvFallsBackToDuckduckgoWithoutAKey() {
        Tool noKey = WebSearchTool.fromEnv(java.util.Map.of());
        assertTrue(noKey.description().contains("DuckDuckGo"), "got: " + noKey.description());

        Tool blankKey = WebSearchTool.fromEnv(java.util.Map.of("TAVILY_API_KEY", "  "));
        assertTrue(blankKey.description().contains("DuckDuckGo"),
                "a blank key is no key, got: " + blankKey.description());
    }
}
