package dev.spectroscope.cli;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.spectroscope.core.config.SpectroConfig;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

class SpectroCliTest {

    /**
     * The first-run hint is the only onboarding screen a terminal newcomer ever
     * sees, and it offers the free local paths by hand — one row each, because
     * each one is installed differently. The LIST of rows is not allowed to be
     * hand-typed here as well: it is read off
     * {@link SpectroConfig#keylessLocalServers()}, which derives it from the key
     * variable and the address each provider already declares.
     *
     * <p>This test used to name ollama and LM Studio itself. Card 312 made
     * llama.cpp the third such backend, the hint kept offering two, and the
     * suite agreed with it — a hand-typed list guarded by the same hand-typed
     * list cannot go red. Bitten by adding a fourth keyless local server to
     * SpectroConfig (a KNOWN_PROVIDERS entry plus an endpointFor case): the
     * hint stayed untouched and this test failed on the new name, which is the
     * whole point of deriving it.</p>
     */
    @Test
    void firstRunHintOffersEveryKeylessLocalBackendAsItsOwnRow() {
        String hint = SpectroCli.firstRunHint("openrouter");
        List<String> local = SpectroConfig.keylessLocalServers().stream().sorted().toList();
        assertTrue(local.size() >= 2, "no keyless local backends left to offer: " + local);
        for (String provider : local) {
            // The row shape the hint uses: the provider id in the first column,
            // then the free/local tag. A mere mention somewhere in the prose
            // would let a backend "be offered" by a link that names it.
            Pattern row = Pattern.compile(
                    "^\\s+" + Pattern.quote(provider) + "\\s+\\(local, free\\)\\s+\\S",
                    Pattern.MULTILINE);
            assertTrue(row.matcher(hint).find(),
                    "the first-run hint has no \"" + provider + "  (local, free)\" row:\n" + hint);
        }
    }

    /**
     * Every local row has to say WHERE the thing listens, because the reader has
     * not started it yet. Derived the same way as the row list itself: the port
     * comes from {@link SpectroConfig#endpointFor}, so a preset that moves
     * cannot leave a stale number on the first screen a newcomer reads.
     */
    @Test
    void everyLocalRowNamesThePortThatBackendListensOn() {
        String hint = SpectroCli.firstRunHint("anthropic");
        for (String provider : SpectroConfig.keylessLocalServers()) {
            String endpoint = SpectroConfig.presetEndpointFor(provider);
            Matcher port = Pattern.compile(":(\\d+)").matcher(endpoint);
            assertTrue(port.find(), "no port in " + provider + "'s preset " + endpoint);
            assertTrue(hint.contains(":" + port.group(1)),
                    "the " + provider + " row never names its port " + port.group(1) + ":\n" + hint);
        }
    }

    @Test
    void firstRunHintNamesTheConfiguredProvidersOwnKey() {
        String hint = SpectroCli.firstRunHint("openrouter");
        // The exact env var for THIS provider's key — not a generic message.
        assertTrue(hint.contains("OPENROUTER_API_KEY"), hint);
        // Keys go in .env (owner decision), not settings.json.
        assertTrue(hint.contains(".env"), hint);
    }

    @Test
    void firstRunHintUsesTheRightKeyPerProvider() {
        assertTrue(SpectroCli.firstRunHint("anthropic").contains("ANTHROPIC_API_KEY"));
        assertTrue(SpectroCli.firstRunHint("openai").contains("OPENAI_API_KEY"));
    }

    /** The keyed provider is the one row that must NOT wear the free tag. */
    @Test
    void theKeyedProviderIsNotOfferedAsAFreeLocalPath() {
        String hint = SpectroCli.firstRunHint("gemini");
        assertFalse(Pattern.compile("^\\s+gemini\\s+\\(local, free\\)", Pattern.MULTILINE)
                .matcher(hint).find(), hint);
    }
}
