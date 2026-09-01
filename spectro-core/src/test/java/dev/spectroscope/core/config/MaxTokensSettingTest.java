package dev.spectroscope.core.config;

import dev.spectroscope.core.Agent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 364, criterion 2: {@code maxTokens} becomes reachable.
 *
 * <p>Before this card {@code AgentOptions.Builder.maxTokens(...)} was called
 * <b>zero</b> times across {@code spectro-core}, {@code spectro-server},
 * {@code spectro-cli} and {@code spectro-orchestrator} main sources. Every
 * shipped run spent {@code Agent.DEFAULT_MAX_TOKENS} and nothing could change
 * it — while the method was public, documented, and named in the javadoc of
 * {@code maxTurns} as one of the two options it was joining. The card offered
 * two honest ends: wire it, or delete it and say the number is fixed. This is
 * the first, because card 266's owner call names the field as the model
 * {@code maxTurns} was built to follow, and because deleting a component from a
 * record published to Maven Central is a compatibility decision that is not a
 * bug fix.</p>
 *
 * <p><b>What is pinned elsewhere, deliberately not restated here.</b> The
 * backend ceiling ABOVE this number is
 * {@code OpenAiCompatProviderTest.theCompletionCapIsClampedForOpenAisPerModelLimits},
 * which sends 32,000 and reads 16,000 off the wire. That the CONFIGURED number
 * reaches a provider call at all is
 * {@code HeadlessRunnerReachTest.theConfiguredCompletionBudgetReachesTheProviderCall}
 * and {@code SubagentReachTest.aChildsProviderCallCarriesTheConfiguredCompletionBudget},
 * which read it off the request an actual run sends. This file is about the
 * chain: the key resolves, the writer accepts it, and provenance knows it.</p>
 */
class MaxTokensSettingTest {

    @Test
    void theShippedBudgetIsTheOneTheHarnessHasAlwaysSpent() {
        // The number does not move in this card, and a second copy of it would
        // be two numbers the day one of them did. Pinned against Agent's own
        // constant rather than against 32,000, exactly the way
        // MaxTurnsSettingTest pins the turn ceiling.
        assertEquals(Agent.DEFAULT_MAX_TOKENS, SpectroConfig.DEFAULT_MAX_TOKENS,
                "the config default and the harness fallback are the same budget seen"
                        + " from two sides — a settings default moved alone would move"
                        + " nothing for a face that passes nothing");
    }

    @Test
    void theShippedValueIsTheOneTheHarnessFallsBackTo(@TempDir Path dir) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), dir);
        assertEquals(Agent.DEFAULT_MAX_TOKENS, config.maxTokens());
    }

    @Test
    void aSettingsFileMovesIt(@TempDir Path dir) throws Exception {
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), """
                { "maxTokens": 8000 }
                """);
        assertEquals(8000, SpectroConfig.load(SpectroConfig.Overrides.none(), dir).maxTokens());
    }

    @Test
    void theSettingsApiAcceptsTheKeyRatherThanRefusingIt() {
        // The card-203-F2 class of defect: a key the record knows and the writer
        // does not is a silent refusal on the one working save path.
        assertTrue(SettingsWriter.knownKeys().contains("maxTokens"),
                "the settings page could not save the key this half of the card exists for");
    }

    @Test
    void provenanceKnowsTheField(@TempDir Path dir) throws Exception {
        // /api/settings' origins view is driven off FIELD_PROBES — a field with
        // no probe resolves fine and then lies about where it came from, so the
        // page draws a "from defaults" chip over the operator's own value.
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), """
                { "maxTokens": 8000 }
                """);
        var resolved = SpectroConfig.loadResolved(SpectroConfig.Overrides.none(), dir, null,
                java.util.Map.of());
        assertEquals("launch-dir", resolved.origins().get("maxTokens").winner(),
                "the field has no probe, so its origin is invented");
    }
}
