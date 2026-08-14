package dev.spectroscope.core.web;

import dev.spectroscope.core.config.SpectroConfig;

import java.util.function.Function;

/**
 * The ONE web_search tier decision (card 203).
 *
 * <p>Before this class the decision existed twice: {@code WebSearchTool.fromEnv}
 * read {@code System.getenv} while {@code spectro doctor} re-derived the same
 * rule from the same variable a few hundred lines away. Two copies of a rule
 * agree exactly as long as nobody changes the inputs — and the moment an
 * address is SAVED in settings rather than exported into the environment, the
 * doctor and the running tool describe different machines. Every surface that
 * names a tier (the tool description the model reads, the header over each
 * result block, {@code /api/config} for the settings page, and the doctor line)
 * now asks this class, so they cannot disagree.</p>
 *
 * <p>The table, which is criterion 3 of the card verbatim:</p>
 *
 * <table border="1">
 *   <caption>the configured state decides, and nothing else does</caption>
 *   <tr><th>configured state</th><th>active tier</th></tr>
 *   <tr><td>SearXNG instance URL saved</td><td>searxng</td></tr>
 *   <tr><td>no instance, Tavily or Brave key present</td><td>that keyed provider</td></tr>
 *   <tr><td>nothing configured</td><td>duckduckgo scrape, labeled best effort</td></tr>
 * </table>
 *
 * <p><b>Reachability is not a column.</b> It never decides which tier answers,
 * only whether that tier's answer is results or a failure sentence. A resolver
 * that probed first would make the active tier depend on a container's mood,
 * and would quietly hand a question to a lower tier — the dishonesty this card
 * exists to remove. There is no fall-through anywhere in this file: a choice
 * builds exactly ONE searcher, and when that one fails the user reads which
 * one failed and at what address.</p>
 */
public final class WebSearchTiers {

    /** A SearXNG instance the user runs — keyless, self-hosted, first in the table. */
    public static final String SEARXNG = "searxng";
    /** The Tavily API — keyed, and the tier that existed before this card. */
    public static final String TAVILY = "tavily";
    /** The Brave Search API — keyed, an independent index. */
    public static final String BRAVE = "brave";
    /** The keyless DuckDuckGo HTML scrape — the {@link #SCRAPE}, last resort. */
    public static final String DUCKDUCKGO = "duckduckgo";

    /**
     * What this product calls the scrape, everywhere it is named.
     *
     * <p>The phrase is {@link DuckDuckGoSearcher}'s, not this class's: when the
     * scrape hits a bot challenge it throws "this is the best-effort scrape
     * tier", and that is the sentence a person has just read when they go
     * looking for the doctor line, the result header or the calibration panel.
     * Those three said "best effort, last resort" instead — near enough to read
     * past, not near enough to recognise as the same subsystem. Card 223's
     * second criterion is that they match, and a constant is how they stay
     * matched; {@code DuckDuckGoSearcherTest} pins the searcher's own message to
     * this value from the other end.</p>
     */
    public static final String SCRAPE = "best-effort scrape";

    /** Where Tavily's key lives. */
    public static final String TAVILY_KEY_ENV = "TAVILY_API_KEY";
    /** Where Brave's key lives. */
    public static final String BRAVE_KEY_ENV = "BRAVE_API_KEY";

    /** Static resolver — never instantiated. */
    private WebSearchTiers() {
    }

    /**
     * What the machine is configured with. Keys appear as PRESENCE only: a tier
     * decision has no business holding a secret, and the two callers that DO
     * need the value (the searcher factory below) read it at build time.
     *
     * @param searxngUrl the saved instance URL; null or blank means none
     * @param tavilyKey  whether {@value #TAVILY_KEY_ENV} resolves to something non-blank
     * @param braveKey   whether {@value #BRAVE_KEY_ENV} resolves to something non-blank
     */
    public record Configured(String searxngUrl, boolean tavilyKey, boolean braveKey) {
    }

    /**
     * The decided tier.
     *
     * @param tier       one of {@link #SEARXNG}, {@link #TAVILY}, {@link #BRAVE},
     *                   {@link #DUCKDUCKGO}
     * @param searxngUrl the instance to dial, trimmed — non-null only for {@link #SEARXNG}
     */
    public record Choice(String tier, String searxngUrl) {
    }

    /**
     * The table, and nothing else.
     *
     * <p>Both keys present is a real state and needs a defined winner, or two
     * reads of the same machine could name different tiers. Tavily keeps the
     * seat it already had.</p>
     *
     * @param configured what the settings and the key files say
     * @return the tier that will answer
     */
    public static Choice decide(Configured configured) {
        String url = configured.searxngUrl() == null ? "" : configured.searxngUrl().trim();
        if (!url.isEmpty()) {
            return new Choice(SEARXNG, url);
        }
        if (configured.tavilyKey()) {
            return new Choice(TAVILY, null);
        }
        if (configured.braveKey()) {
            return new Choice(BRAVE, null);
        }
        return new Choice(DUCKDUCKGO, null);
    }

    /**
     * What a config plus the key files resolve to — the production entry point,
     * shared by the tool, {@code /api/config} and the doctor.
     *
     * @param config the resolved settings hierarchy
     * @return the tier that will answer
     */
    public static Choice forConfig(SpectroConfig config) {
        return decide(new Configured(
                config == null ? null : config.searxngUrl(),
                SpectroConfig.hasApiKey(TAVILY_KEY_ENV),
                SpectroConfig.hasApiKey(BRAVE_KEY_ENV)));
    }

    /**
     * The ONE searcher a choice names. Never a chain, never a wrapper with a
     * second backend behind it: criterion 8 of the card says a configured tier
     * that cannot be reached FAILS, and the cheapest way to keep that promise
     * is to build nothing that could answer in its place.
     *
     * @param choice    the decided tier
     * @param keyLookup reads an API key by env var name — {@code SpectroConfig::resolveApiKey}
     *                  in production, a stub in tests
     * @return the searcher for that tier
     */
    public static WebSearcher searcher(Choice choice, Function<String, String> keyLookup) {
        return switch (choice.tier()) {
            case SEARXNG -> new SearxngSearcher(choice.searxngUrl());
            case TAVILY -> new TavilySearcher(keyLookup.apply(TAVILY_KEY_ENV));
            case BRAVE -> new BraveSearcher(keyLookup.apply(BRAVE_KEY_ENV));
            default -> new DuckDuckGoSearcher();
        };
    }

    /**
     * The tier as a reader should see it — the same words in the tool
     * description, the result header and the doctor. Only the scrape carries an
     * apology, and it carries it everywhere: criterion 4 of the card asks for
     * the label wherever the tier already surfaces, and a bare "duckduckgo"
     * reads like a provider somebody chose.
     *
     * @param tier the tier name
     * @return the label to print
     */
    public static String label(String tier) {
        return DUCKDUCKGO.equals(tier) ? DUCKDUCKGO + " — " + SCRAPE + ", last resort" : tier;
    }

    /**
     * One sentence about the active tier, for the humans: the doctor prints it,
     * and the model-facing tool description is built from it. Names the address
     * for a self-hosted instance and the variable for a keyed provider, so the
     * reader knows which thing to go and look at.
     *
     * <p><b>This is the ONLY sentence.</b> The web app cannot print it verbatim
     * — it is English and that page is bilingual — so it keeps a translated pair
     * per tier in {@code i18n.ts}, and until card 223 nothing compared the two.
     * They drifted: the panel had dropped the half that says what to DO, on the
     * one surface a person opens after a search misbehaved.
     * {@code WebSearchSentenceDriftTest} now holds the English entries to this
     * method word for word, so editing here without editing there is a red
     * build rather than a second sentence.</p>
     *
     * @param choice the decided tier
     * @return the sentence
     */
    public static String describe(Choice choice) {
        return switch (choice.tier()) {
            case SEARXNG -> "searxng — a metasearch instance you run, at " + choice.searxngUrl();
            case TAVILY -> "the Tavily API (" + TAVILY_KEY_ENV + ")";
            case BRAVE -> "the Brave Search API (" + BRAVE_KEY_ENV + ")";
            // Leads with the searcher's own phrase, and keeps the way out in the
            // same breath: a sentence that names a problem and not its remedy is
            // the half this product kept losing.
            default -> "the " + SCRAPE + " of DuckDuckGo's HTML — keyless, last resort, and "
                    + "against DuckDuckGo's own terms. Configure a SearXNG instance, or a Tavily "
                    + "or Brave key, under Settings.";
        };
    }
}
