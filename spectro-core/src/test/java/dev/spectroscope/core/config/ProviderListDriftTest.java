package dev.spectroscope.core.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * The provider set across the language boundary.
 *
 * <p>Card 312, round 4. The app's provider list was hand-typed in
 * {@code providerPickerMode.ts} and guarded by the same list hand-typed again
 * in {@code providerPickerMode.test.ts} — the shape this card has been pulling
 * out of the repo all round, this time with a language boundary hiding it. A
 * ninth backend declared in {@link SpectroConfig#KNOWN_PROVIDERS} left the
 * picker silent about it with every test in BOTH languages green, because
 * nothing anywhere compared the two lists.</p>
 *
 * <p>Same instrument as {@code WebSearchSentenceDriftTest}, which reads the
 * TypeScript dictionary from Java and holds it to a Java fact: when a fact is
 * restated in files that cannot import each other, the test has to go and
 * look. It lives on the Java side deliberately — the provider set is declared
 * here, so the comparison should break here, next to the line somebody just
 * edited.</p>
 */
class ProviderListDriftTest {

    /** The app's own copy of the provider set — what the header picker maps over. */
    private static final String PICKER = "spectro-web/src/components/providerPickerMode.ts";

    /** The first-run sheet: the cloud option is the one that names the keyed backends. */
    private static final String ONBOARDING = "spectro-web/src/components/Onboarding.tsx";

    /**
     * The picker offers exactly the backends the config accepts.
     *
     * <p>Bitten the ordered way — {@code "vllm"} added to
     * {@code SpectroConfig.KNOWN_PROVIDERS} alone, no TypeScript and no test
     * file touched:</p>
     *
     * <pre>
     * the header picker's PROVIDERS and SpectroConfig.KNOWN_PROVIDERS have drifted apart.
     * expected: [anthropic, gemini, llamacpp, lmstudio, ollama, openai, openrouter, spectro-local, vllm]
     * but was:  [anthropic, gemini, llamacpp, lmstudio, ollama, openai, openrouter, spectro-local]
     * </pre>
     */
    @Test
    void theHeaderPickerOffersEveryBackendTheConfigKnows() throws IOException {
        assumeTrue(sourceCheckout(), "not running from a source checkout");
        Set<String> drawn = new TreeSet<>(pickerProviders());
        assertEquals(new TreeSet<>(SpectroConfig.knownProviders()), drawn,
                "the header picker's PROVIDERS (" + PICKER + ") and"
                        + " SpectroConfig.KNOWN_PROVIDERS have drifted apart. A backend the"
                        + " config accepts but the picker never lists cannot be switched to"
                        + " from the app at all; one the picker lists but the config refuses"
                        + " is offered and then rejected on Apply. One set, two languages:"
                        + " change both sides, or change neither.");
    }

    /**
     * The first-run sheet's cloud option names every KEYED backend, and names
     * the variable each one's key goes in — in both locales.
     *
     * <p>Derived rather than read off the sheet: a keyed provider is one
     * {@link SpectroConfig#keyEnvFor} answers for, which is the same fact the
     * onboarding status and the launcher's {@code set-key} are built on.
     * Measured before the fix: the sheet offered "anthropic · openai ·
     * openrouter" and their three variables, so a gemini user — whose key IS
     * one you add to {@code .env} — read a sheet saying theirs is not.</p>
     *
     * <p>Bitten the ordered way — {@code "vllm"} added to
     * {@code SpectroConfig.KNOWN_PROVIDERS} plus a {@code keyEnvFor} case for
     * it, no TypeScript touched:</p>
     *
     * <pre>
     * the first-run sheet's cloud option never names "vllm", so a reader whose
     * backend needs a key is told their backend is not one of the ones you add
     * a key for.
     * </pre>
     */
    @Test
    void theFirstRunSheetNamesEveryKeyedBackendAndItsVariableInBothLocales() throws IOException {
        assumeTrue(sourceCheckout(), "not running from a source checkout");
        String cloud = cloudOption();
        for (String provider : new TreeSet<>(SpectroConfig.knownProviders())) {
            String keyEnv = SpectroConfig.keyEnvFor(provider);
            if (keyEnv == null) {
                continue; // a local backend: it has no key to put anywhere
            }
            assertTrue(cloud.contains(provider),
                    "the first-run sheet's cloud option never names \"" + provider
                            + "\", so a reader whose backend needs a key is told their"
                            + " backend is not one of the ones you add a key for. ("
                            + ONBOARDING + ")\n" + cloud);
            // Twice, because the option carries a German body and an English one
            // and a variable dropped from one of them is invisible to the other
            // language's reader — exactly the half the last sweep missed.
            assertTrue(occurrences(cloud, keyEnv) >= 2,
                    "the first-run sheet's cloud option names \"" + keyEnv + "\" "
                            + occurrences(cloud, keyEnv) + " time(s) — it needs one per"
                            + " locale, or the reader of the other language is handed a"
                            + " sheet that cannot get their key into .env. (" + ONBOARDING
                            + ")\n" + cloud);
        }
    }

    /**
     * The first-run sheet's remote-address hint names every KEYLESS LOCAL
     * SERVER — in both locales, and by the id the picker shows.
     *
     * <p>Round 5. The test above guards the cloud option; six lines below it in
     * the same file, the paragraph that tells a reader with the GPU box across
     * the room where the address goes hand-typed "ollama, LM Studio or
     * llama.cpp" — a fourth spelling of {@link SpectroConfig#keylessLocalServers()},
     * in a paragraph whose own comment names this exact failure mode. The
     * sentence is about which PROVIDER to pick, and the picker shows ids, so
     * the ids are what it names and what this reads.</p>
     *
     * <p>Bitten the ordered way — {@code "vllm"} added to
     * {@code SpectroConfig.KNOWN_PROVIDERS}, {@code endpointFor} and
     * {@code isOpenAiCompat}, no TypeScript touched:</p>
     *
     * <pre>
     * the first-run sheet's remote-address hint names "vllm" 0 time(s)
     * </pre>
     */
    @Test
    void theRemoteAddressHintNamesEveryKeylessLocalServerInBothLocales() throws IOException {
        assumeTrue(sourceCheckout(), "not running from a source checkout");
        String hint = remoteHint();
        assertTrue(SpectroConfig.keylessLocalServers().size() >= 2,
                "no keyless local servers left to point at another machine: "
                        + SpectroConfig.keylessLocalServers());
        for (String provider : new TreeSet<>(SpectroConfig.keylessLocalServers())) {
            // Twice, for the same reason as the cloud option above: the
            // paragraph carries a German body and an English one, and a name
            // dropped from one of them is invisible to the other language's
            // reader.
            assertTrue(occurrences(hint, provider) >= 2,
                    "the first-run sheet's remote-address hint names \"" + provider + "\" "
                            + occurrences(hint, provider) + " time(s) — it needs one per"
                            + " locale. A reader whose backend is missing from this"
                            + " sentence is told the local backends are this-machine-only"
                            + " and never finds the address field. (" + ONBOARDING + ")\n"
                            + hint);
        }
    }

    /** The {@code ob-remote} paragraph of the first-run sheet, both locales. */
    private static String remoteHint() throws IOException {
        String source = Files.readString(repoRoot().resolve(ONBOARDING), StandardCharsets.UTF_8);
        int start = source.indexOf("className=\"ob-remote\"");
        assertTrue(start > 0,
                "no `className=\"ob-remote\"` paragraph in " + ONBOARDING + " — a drift"
                        + " test that cannot find its own subject must go red, not quiet");
        int end = source.indexOf("</p>", start);
        assertTrue(end > start, "the ob-remote paragraph in " + ONBOARDING + " never closes");
        return source.substring(start, end);
    }

    /** The provider ids in the app's {@code PROVIDERS} array. */
    private static List<String> pickerProviders() throws IOException {
        String source = Files.readString(repoRoot().resolve(PICKER), StandardCharsets.UTF_8);
        Matcher array = Pattern.compile(
                "export const PROVIDERS = \\[(.*?)\\] as const;", Pattern.DOTALL).matcher(source);
        assertTrue(array.find(),
                "no `export const PROVIDERS = [...] as const;` in " + PICKER + " — a drift"
                        + " test that cannot find its own subject must go red, not quiet");
        return Pattern.compile("\"([^\"]+)\"").matcher(array.group(1)).results()
                .map(result -> result.group(1))
                .toList();
    }

    /** The {@code badge="cloud"} option of the first-run sheet, both locales. */
    private static String cloudOption() throws IOException {
        String source = Files.readString(repoRoot().resolve(ONBOARDING), StandardCharsets.UTF_8);
        int start = source.indexOf("badge=\"cloud\"");
        assertTrue(start > 0,
                "no `badge=\"cloud\"` option in " + ONBOARDING + " — a drift test that"
                        + " cannot find its own subject must go red, not quiet");
        // The element's own closer, which is `/>` alone on a line as prettier
        // writes it — NOT the first "/>" in the text, because the fragment
        // that wraps each locale's body ends in "</>" and would cut the block
        // in half. That mistake reads as "the German half is missing", which
        // is a real failure mode of this very test and must not be faked.
        Matcher close = Pattern.compile("\\R\\s*/>\\R").matcher(source);
        assertTrue(close.find(start), "the cloud option in " + ONBOARDING + " never closes");
        return source.substring(start, close.start());
    }

    private static int occurrences(String haystack, String needle) {
        int count = 0;
        for (int at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
            count++;
        }
        return count;
    }

    private static boolean sourceCheckout() {
        return Files.isDirectory(repoRoot().resolve("spectro-web/src"));
    }

    private static Path repoRoot() {
        Path here = Path.of("").toAbsolutePath();
        while (here != null && !Files.exists(here.resolve("settings.gradle.kts"))) {
            here = here.getParent();
        }
        return here == null ? Path.of("").toAbsolutePath() : here;
    }
}
