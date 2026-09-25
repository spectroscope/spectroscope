package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 394: the token budget of one child agent becomes a settings key.
 *
 * <p>Owner, 2026-09-24, on four GLM children that spent 17,423,655 input tokens
 * in about 340 seconds and handed back nothing: "Die kleineren Agenten sollen
 * halt auch sinnvoll arbeiten können. Da muss man irgendwie so ein Zwischending
 * finden." The wall clock of card 372 gives a child two hours; this key is the
 * brake on what those hours may cost.</p>
 *
 * <p>Ten million is a chosen number with its measurement on the card, so it is
 * pinned here as a literal. This class covers the key's existence and its fold
 * through the layers. What a child does with it is
 * {@code SubagentTokenBudgetTest}'s.</p>
 */
class SubagentBudgetTokensSettingTest {

    @Test
    void theShippedBudgetIsTenMillionTokens() {
        assertEquals(10_000_000, SpectroConfig.DEFAULT_SUBAGENT_BUDGET_TOKENS,
                "card 394: ten million tokens, input plus output, per child");
    }

    @Test
    void theShippedValueIsTheOneTheHarnessFallsBackTo(@TempDir Path dir) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), dir);
        assertEquals(SpectroConfig.DEFAULT_SUBAGENT_BUDGET_TOKENS, config.subagentBudgetTokens(),
                "a config with nothing set does not fall back to the shipped budget");
    }

    @Test
    void aSettingsFileMovesIt(@TempDir Path dir) throws Exception {
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), """
                { "subagentBudgetTokens": 4000000 }
                """);
        assertEquals(4_000_000, SpectroConfig.load(SpectroConfig.Overrides.none(), dir)
                .subagentBudgetTokens());
    }

    @Test
    void theSettingsApiAcceptsTheKeyRatherThanRefusingIt() {
        assertTrue(SettingsWriter.knownKeys().contains("subagentBudgetTokens"),
                "the settings page could not save the key this card exists for");
    }

    @Test
    void provenanceKnowsTheField(@TempDir Path dir) throws Exception {
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), """
                { "subagentBudgetTokens": 4000000 }
                """);
        var resolved = SpectroConfig.loadResolved(SpectroConfig.Overrides.none(), dir, null,
                java.util.Map.of());
        assertEquals("launch-dir", resolved.origins().get("subagentBudgetTokens").winner(),
                "the field has no probe, so its origin is invented");
    }

    @Test
    void itsFloorIsOneToken() {
        assertEquals(1, SettingFloors.floors().get("subagentBudgetTokens"),
                "a budget of zero would cut every child at its first exchange");
    }
}
