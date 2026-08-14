package dev.spectroscope.core.web;

import dev.spectroscope.core.web.WebSearchTiers.Choice;
import dev.spectroscope.core.web.WebSearchTiers.Configured;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The ONE tier decision (card 203). Before this class the decision existed
 * twice — once in {@code WebSearchTool.fromEnv} reading {@code System.getenv},
 * once re-derived inside {@code spectro doctor} — so the doctor and the running
 * tool disagreed the moment a URL was saved in settings rather than exported.
 * Every surface that names a tier now asks this class.
 *
 * <p>The table under test is criterion 3 of the card, verbatim:</p>
 *
 * <pre>
 * SearXNG instance URL saved              -> searxng
 * no instance, Tavily or Brave key set    -> that keyed provider
 * nothing configured                      -> duckduckgo, labeled best effort
 * </pre>
 *
 * <p>Reachability is deliberately NOT a column. It never decides which tier
 * answers, only whether that tier's answer is results or a failure sentence.</p>
 */
class WebSearchTiersTest {

    @Test
    void aSavedInstanceUrlWinsOverEveryKey() {
        Choice choice = WebSearchTiers.decide(
                new Configured("http://localhost:8888", true, true));

        assertEquals("searxng", choice.tier());
        assertEquals("http://localhost:8888", choice.searxngUrl());
    }

    @Test
    void withoutAnInstanceTavilyAnswersBeforeBrave() {
        // Both keys present is a real state and needs a defined winner, or the
        // doctor line and the running tool could name different tiers on two
        // reads of the same machine. Tavily is the incumbent tier, so it keeps
        // the seat it already had.
        assertEquals("tavily", WebSearchTiers.decide(new Configured(null, true, true)).tier());
        assertEquals("tavily", WebSearchTiers.decide(new Configured(null, true, false)).tier());
        assertEquals("brave", WebSearchTiers.decide(new Configured(null, false, true)).tier());
    }

    @Test
    void nothingConfiguredIsTheScrapeAndTheScrapeSaysSo() {
        Choice choice = WebSearchTiers.decide(new Configured(null, false, false));

        assertEquals("duckduckgo", choice.tier());
        // The label is what a reader sees. The bare tier name would read like a
        // chosen provider; this one is the last resort and has to admit it.
        // It admits it in the searcher's own words since card 223 — "best
        // effort, last resort" and "best-effort scrape tier" were two names for
        // one thing, and a reader who met the second went looking for a second
        // fault. The threshold is unchanged; the phrase under it moved.
        assertTrue(WebSearchTiers.label("duckduckgo").contains(WebSearchTiers.SCRAPE),
                "got: " + WebSearchTiers.label("duckduckgo"));
        assertEquals("searxng", WebSearchTiers.label("searxng"),
                "a configured tier is named plainly, without an apology");
    }

    @Test
    void aBlankInstanceUrlIsNotAnInstance() {
        // An emptied settings field arrives as "" or as whitespace, and treating
        // that as configured would fail every search against an address of "".
        assertEquals("duckduckgo", WebSearchTiers.decide(new Configured("", false, false)).tier());
        assertEquals("duckduckgo", WebSearchTiers.decide(new Configured("   ", false, false)).tier());
        assertEquals("tavily", WebSearchTiers.decide(new Configured("  ", true, false)).tier());
    }

    @Test
    void theDecisionIgnoresReachabilityBecauseItHasNoWayToKnowIt() {
        // Criterion 3 of the card: reachability is not a column. This is the
        // pin that keeps someone from "improving" the resolver into a probe —
        // a probe would make the active tier depend on a container's mood.
        Choice choice = WebSearchTiers.decide(new Configured("http://127.0.0.1:1/nothing-here", true, true));
        assertEquals("searxng", choice.tier(),
                "a dead address is still the configured address");
    }

    @Test
    void theChoiceBuildsExactlyOneSearcherAndNeverAChain() {
        // Criterion 8: no fall-through. The structural guarantee is that the
        // choice yields ONE searcher object, whose tier is the decided tier —
        // there is no composite with a second backend behind it to reach.
        assertInstanceOf(SearxngSearcher.class, searcherFor(new Configured("http://localhost:8888", true, true)));
        assertInstanceOf(TavilySearcher.class, searcherFor(new Configured(null, true, true)));
        assertInstanceOf(BraveSearcher.class, searcherFor(new Configured(null, false, true)));
        assertInstanceOf(DuckDuckGoSearcher.class, searcherFor(new Configured(null, false, false)));
    }

    @Test
    void theBuiltSearcherReportsTheDecidedTier() {
        for (Configured configured : java.util.List.of(
                new Configured("http://localhost:8888", false, false),
                new Configured(null, true, false),
                new Configured(null, false, true),
                new Configured(null, false, false))) {
            Choice choice = WebSearchTiers.decide(configured);
            assertEquals(choice.tier(), searcherFor(configured).tier(),
                    "the object that answers must be the tier that was named");
        }
    }

    @Test
    void theSentenceForAConfiguredInstanceNamesItsAddress() {
        String sentence = WebSearchTiers.describe(
                WebSearchTiers.decide(new Configured("http://box.local:8888", false, false)));
        assertTrue(sentence.contains("http://box.local:8888"), "got: " + sentence);
    }

    @Test
    void theSentenceForTheScrapeSaysWhatToDoAboutIt() {
        String sentence = WebSearchTiers.describe(WebSearchTiers.decide(new Configured(null, false, false)));
        assertTrue(sentence.contains(WebSearchTiers.SCRAPE), "got: " + sentence);
        assertTrue(sentence.toLowerCase(java.util.Locale.ROOT).contains("searxng"),
                "names the way out, got: " + sentence);
        assertFalse(sentence.contains("http://"), "there is no address to name here, got: " + sentence);
    }

    @Test
    void theKeyedSentencesNameTheVariableTheKeyLivesIn() {
        assertTrue(WebSearchTiers.describe(WebSearchTiers.decide(new Configured(null, true, false)))
                .contains("TAVILY_API_KEY"));
        assertTrue(WebSearchTiers.describe(WebSearchTiers.decide(new Configured(null, false, true)))
                .contains("BRAVE_API_KEY"));
    }

    /** Builds through the production entry point with a stub key lookup — no
     *  key file, no environment, no network. */
    private static WebSearcher searcherFor(Configured configured) {
        return WebSearchTiers.searcher(WebSearchTiers.decide(configured), name -> "stub-key");
    }
}
