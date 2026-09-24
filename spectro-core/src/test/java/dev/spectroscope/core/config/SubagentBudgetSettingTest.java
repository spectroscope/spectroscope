package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 372: the floor of a child agent's run budget becomes a settings key.
 *
 * <p>Owner, 2026-09-17: "Die Subagenten-Runtime muss auf zwei Stunden hoch,
 * oder drei, und alles einstellbar." Until this card the floor was a fixed
 * 300 s constant inside {@code ChildBudget}, with no key above it; on
 * 2026-09-16 it cut a planner child that was still streaming a 2,400-line
 * plan.</p>
 *
 * <p>7200 is the owner's two hours, a decision rather than a measurement, so it is
 * pinned here as a literal. This class covers the key's existence and its fold
 * through the layers only. The consumer of the value is card 372's next slice.</p>
 */
class SubagentBudgetSettingTest {

    @Test
    void theShippedFloorIsTwoHours() {
        assertEquals(7200, SpectroConfig.DEFAULT_SUBAGENT_BUDGET_SECONDS,
                "card 372, the owner's number of 2026-09-17: two hours");
    }

    @Test
    void theShippedValueIsTheOneTheHarnessFallsBackTo(@TempDir Path dir) {
        // Pinned against the constant, not against 7200 a second time: two
        // copies of a number are two numbers as soon as one of them moves.
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), dir);
        assertEquals(SpectroConfig.DEFAULT_SUBAGENT_BUDGET_SECONDS, config.subagentBudgetSeconds(),
                "a config with nothing set does not fall back to the shipped floor");
    }

    @Test
    void aSettingsFileMovesIt(@TempDir Path dir) throws Exception {
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), """
                { "subagentBudgetSeconds": 60 }
                """);
        assertEquals(60, SpectroConfig.load(SpectroConfig.Overrides.none(), dir)
                .subagentBudgetSeconds());
    }

    @Test
    void theSettingsApiAcceptsTheKeyRatherThanRefusingIt() {
        // The card-203-F2 class of defect: a key the record knows and the writer
        // does not is a silent refusal on the one working save path.
        assertTrue(SettingsWriter.knownKeys().contains("subagentBudgetSeconds"),
                "the settings page could not save the key this card exists for");
    }

    @Test
    void provenanceKnowsTheField(@TempDir Path dir) throws Exception {
        // The /api/settings origins view is driven off FIELD_PROBES. A field
        // missing there resolves fine and lies about where it came from, so the
        // page would draw a "from defaults" chip over an operator's own value.
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), """
                { "subagentBudgetSeconds": 60 }
                """);
        var resolved = SpectroConfig.loadResolved(SpectroConfig.Overrides.none(), dir, null,
                java.util.Map.of());
        assertEquals("launch-dir", resolved.origins().get("subagentBudgetSeconds").winner(),
                "the field has no probe, so its origin is invented");
    }
}
