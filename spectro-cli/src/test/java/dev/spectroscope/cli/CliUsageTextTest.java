package dev.spectroscope.cli;

import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;
import picocli.CommandLine;

/**
 * What {@code spectro --help} prints about {@code --provider}.
 *
 * <p>Card 312, round 4. Nothing under {@code spectro-cli/src/test} looked at
 * the usage text at all, and the option's description was hand-typed:
 * "anthropic, ollama or openai (overrides the config)". Measured absurdity on
 * one screen — {@code spectro --provider bogus} is refused by
 * {@link SpectroConfig}'s validation, which prints
 * {@link SpectroConfig#KNOWN_PROVIDERS_DISPLAY} and therefore all eight names,
 * llamacpp included, while {@code spectro --help} one line above says three
 * exist. This card's thesis was that the onboarding screen a terminal newcomer
 * actually sees had not learnt llama.cpp; {@code --help} is that screen too.</p>
 *
 * <p>The assertion is made against the RENDERED usage message rather than the
 * annotation, because the rendered text is what the reader gets: an option
 * whose description no longer reaches the help screen (moved, hidden, or
 * wrapped away) would pass a read of the constant and fail the person.</p>
 */
class CliUsageTextTest {

    /** Wide enough that picocli wraps nothing — the point is the words, not the fold. */
    private static final int NO_WRAP = 400;

    private static String usage() {
        return new CommandLine(new SpectroCli()).setUsageHelpWidth(NO_WRAP).getUsageMessage();
    }

    /**
     * Every provider the config accepts is offered by the help screen.
     *
     * <p>Bitten the ordered way — a ninth name added to
     * {@code SpectroConfig.KNOWN_PROVIDERS} alone, no test file touched:</p>
     *
     * <pre>
     * spectro --help offers no "vllm", but spectro --provider vllm is accepted:
     * the help screen and the config's own refusal message disagree about what
     * exists, on one terminal.
     * </pre>
     */
    @Test
    void theHelpScreenOffersEveryProviderTheConfigAccepts() {
        String usage = usage();
        for (String provider : SpectroConfig.knownProviders()) {
            assertTrue(usage.contains(provider),
                    "spectro --help offers no \"" + provider + "\", but spectro --provider "
                            + provider + " is accepted: the help screen and the config's own"
                            + " refusal message disagree about what exists, on one terminal.\n"
                            + usage);
        }
    }

    /**
     * And it offers them as the shared listing SPELLS them, not in a sentence
     * of its own — the test above is satisfied by any text with the eight
     * names somewhere in it, including a hand-typed one that happens to be
     * complete today.
     *
     * <p>What this holds, exactly: the description carries
     * {@link SpectroConfig#KNOWN_PROVIDERS_DISPLAY} as one unbroken run of
     * characters. It cannot distinguish the constant from a copy of it that is
     * byte-identical — measured, by replacing the reference with exactly those
     * characters, and this stayed green. It goes red the moment the copy is
     * re-worded, which is what a hand-typed list does the first time somebody
     * edits it:</p>
     *
     * <pre>
     * got: anthropic, ollama, openai, lmstudio, llamacpp, openrouter, gemini and
     *      spectro-local (overrides the config).
     * </pre>
     */
    @Test
    void theProviderOptionPrintsTheSharedListingVerbatim() {
        String description = String.join(" ",
                new CommandLine(new SpectroCli()).getCommandSpec()
                        .findOption("--provider").description());
        assertTrue(description.contains(SpectroConfig.KNOWN_PROVIDERS_DISPLAY),
                "--provider's help text does not carry KNOWN_PROVIDERS_DISPLAY ("
                        + SpectroConfig.KNOWN_PROVIDERS_DISPLAY + ") — it is a second"
                        + " spelling of the provider set and will drift from the first.\n"
                        + "got: " + description);
    }
}
