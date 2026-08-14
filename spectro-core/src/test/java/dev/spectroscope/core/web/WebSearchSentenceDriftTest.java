package dev.spectroscope.core.web;

import dev.spectroscope.core.web.WebSearchTiers.Configured;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The sentence about the active tier exists ONCE, in two languages (card 223).
 *
 * <p>Card 203 reduced the tier DECISION to one place and every surface now asks
 * {@link WebSearchTiers}. The sentence did not follow. The web app cannot print
 * {@link WebSearchTiers#describe} verbatim — it is English, and that page is
 * bilingual — so it keeps a translated pair per tier in {@code i18n.ts}, and a
 * translated pair drifts silently. It did. Measured on the same build, the same
 * second, English, nothing configured:</p>
 *
 * <pre>
 * /api/config and spectro doctor : the keyless DuckDuckGo HTML scrape — best effort,
 *                                  last resort, and against DuckDuckGo's own terms.
 *                                  Configure a SearXNG instance, or a Tavily or Brave
 *                                  key, under Settings.
 * the calibration panel          : the best-effort scrape of DuckDuckGo's HTML —
 *                                  keyless, last resort, and against DuckDuckGo's own
 *                                  terms.
 * </pre>
 *
 * <p>Two sentences about one thing, on the one surface a person opens after a
 * search misbehaved — and the panel's had dropped the only half that says what
 * to do about it. Nothing compared them, so nothing noticed. Card 223's first
 * criterion forbids exactly this, and its second one is why the wording moved:
 * {@link DuckDuckGoSearcher} throws "this is the best-effort scrape tier", and a
 * reader who has just read that must recognise the words on the panel. Both are
 * satisfiable at once only if the SERVER says it that way too, which is what
 * this test now holds shut.</p>
 *
 * <p>The English string in the dictionary is therefore not a translation of
 * anything — it is this class's own output, byte for byte, and the German one is
 * a translation of it. This test is the seam between the two repositories'
 * halves of one product, and it lives on the Java side deliberately: the
 * sentence's author is here, so the comparison should break here, next to the
 * string somebody just edited.</p>
 */
class WebSearchSentenceDriftTest {

    /** A hostname, never a dotted quad — see NoOperatorAddressesInTheRepoTest. */
    private static final String ADDRESS = "http://box.local:8888";

    /** Where the app keeps its half of the sentence. */
    private static final String DICT = "spectro-web/src/i18n/i18n.ts";

    /** The English sentence for every tier, as the server tells it. */
    private static Map<String, String> served() {
        Map<String, String> byTier = new LinkedHashMap<>();
        byTier.put(WebSearchTiers.SEARXNG, describe(new Configured(ADDRESS, false, false)));
        byTier.put(WebSearchTiers.TAVILY, describe(new Configured(null, true, false)));
        byTier.put(WebSearchTiers.BRAVE, describe(new Configured(null, false, true)));
        byTier.put(WebSearchTiers.DUCKDUCKGO, describe(new Configured(null, false, false)));
        return byTier;
    }

    private static String describe(Configured configured) {
        return WebSearchTiers.describe(WebSearchTiers.decide(configured));
    }

    @Test
    void theAppDrawsTheSentenceTheServerServes() throws IOException {
        String dict = Files.readString(repoRoot().resolve(DICT), StandardCharsets.UTF_8);
        for (Map.Entry<String, String> entry : served().entrySet()) {
            String tier = entry.getKey();
            // The app writes the instance address as a placeholder because it
            // renders the sentence itself; filling it in is what makes the two
            // comparable at all.
            String drawn = english(dict, tier).replace("{addr}", ADDRESS);
            assertEquals(entry.getValue(), drawn,
                    "set.tier." + tier + " in " + DICT + " is a SECOND sentence about the tier.\n"
                            + "One sentence, two languages: the English entry is "
                            + "WebSearchTiers.describe() verbatim, and the German one translates it.\n"
                            + "Change both sides, or change neither.");
        }
    }

    @Test
    void theGermanSentenceKeepsEveryFactTheEnglishOneCarries() throws IOException {
        // A translation may choose its own words; it may not quietly drop the
        // address, the variable a key lives in, or the way out of the scrape.
        // Those are the parts a reader acts on, and they are the parts that
        // survive translation unchanged, so they can be checked.
        String dict = Files.readString(repoRoot().resolve(DICT), StandardCharsets.UTF_8);
        Map<String, String> mustSurvive = Map.of(
                WebSearchTiers.SEARXNG, "{addr}",
                WebSearchTiers.TAVILY, WebSearchTiers.TAVILY_KEY_ENV,
                WebSearchTiers.BRAVE, WebSearchTiers.BRAVE_KEY_ENV,
                WebSearchTiers.DUCKDUCKGO, "SearXNG");
        for (Map.Entry<String, String> entry : mustSurvive.entrySet()) {
            String german = german(dict, entry.getKey());
            assertTrue(german.contains(entry.getValue()),
                    "set.tier." + entry.getKey() + " loses \"" + entry.getValue()
                            + "\" in German — a reader of that language is handed a "
                            + "sentence they cannot act on.\ngot: " + german);
        }
    }

    /** The `en:` string of one `set.tier.*` entry. */
    private static String english(String dict, String tier) {
        return read(dict, tier, 2);
    }

    /** The `de:` string of one `set.tier.*` entry. */
    private static String german(String dict, String tier) {
        return read(dict, tier, 1);
    }

    /**
     * Pull one side of a dictionary entry out of the TypeScript source.
     *
     * <p>The pattern demands the shape prettier enforces — {@code de} first,
     * then {@code en} — and a miss is a failure rather than an empty string.
     * A drift test that cannot find its own subject must go red, not quiet;
     * that is the whole failure mode it exists to prevent, one level up.</p>
     */
    private static String read(String dict, String tier, int group) {
        Pattern entry = Pattern.compile(
                "\"set\\.tier\\." + Pattern.quote(tier) + "\":\\s*\\{\\s*"
                        + "de:\\s*\"((?:[^\"\\\\]|\\\\.)*)\",\\s*"
                        + "en:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"",
                Pattern.DOTALL);
        Matcher m = entry.matcher(dict);
        assertTrue(m.find(), "no set.tier." + tier + " entry with a de/en pair in " + DICT);
        return m.group(group).replace("\\\"", "\"").replace("\\\\", "\\");
    }

    private static Path repoRoot() {
        Path here = Path.of("").toAbsolutePath();
        while (here != null && !Files.exists(here.resolve("settings.gradle.kts"))) {
            here = here.getParent();
        }
        return here == null ? Path.of("").toAbsolutePath() : here;
    }
}
