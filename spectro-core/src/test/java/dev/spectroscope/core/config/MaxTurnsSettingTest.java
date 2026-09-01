package dev.spectroscope.core.config;

import dev.spectroscope.core.Agent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 282: the half of card 266's owner call 4 that was never built.
 *
 * <p>That call is on the card verbatim — "yes, it becomes an option.
 * {@code AgentOptions.maxTurns} beside {@code maxTokens} and
 * {@code compactionThreshold}; 15 stays the shipped value". {@code AgentOptions}
 * got its field. The settings chain did not, so the only two callers of the
 * builder method were the two fleet-node paths and every browser session ran on
 * the hardcoded default with nowhere in the app to change it.</p>
 *
 * <p>The owner met it as a run that ended with a green tool result and no
 * closing word: fifteen turns, then {@code run_end} with
 * {@code stopReason: "max_turns"}.</p>
 *
 * <p><b>Card 365</b> moved the value. The 15 was never measured against
 * anything; a census of 7,139 real Claude Code sessions on the owner's machine
 * (2026-09-01) put the median run at 14 turns and p95 at 129, with 48.0 % of
 * sessions going past 15 — so the shipped ceiling was cutting half of all real
 * work off mid-task. The owner's number is 150. The census itself is a dated
 * snapshot in {@link SpectroConfig#DEFAULT_MAX_TURNS}'s javadoc, because it is
 * not derivable from this repo and so cannot be re-derived by a test; the
 * DECISION is pinned below, where an accidental revert goes red.</p>
 */
class MaxTurnsSettingTest {

    @Test
    void theShippedCeilingIsTheNumberTheOwnerChoseFromTheCensus() {
        // A decision, not a derivation — so it is pinned as a literal and the
        // measurement that produced it is stamped with its date and its n in
        // the constant's own javadoc. Card 365, criteria 1 and 4.
        assertEquals(150, SpectroConfig.DEFAULT_MAX_TURNS,
                "the shipped turn ceiling is not the owner's 150 — the census that"
                        + " produced it is in the constant's javadoc, and a run that ends"
                        + " at 15 ends 48 % of real sessions in the middle");
        assertEquals(SpectroConfig.DEFAULT_MAX_TURNS, Agent.DEFAULT_MAX_TURNS,
                "the harness's own fallback still carries the old ceiling — every face"
                        + " that never passes maxTurns reads Agent's copy, so a settings"
                        + " default moved alone moves nothing for spectro run, cron or a"
                        + " child agent");
    }

    @Test
    void theShippedValueIsTheOneTheHarnessFallsBackTo(@TempDir Path dir) {
        // Pinned against the constant rather than against 15, the same way the
        // guard's three are pinned against ProgressSettings.defaults(). Two
        // copies of a number are two numbers as soon as one of them moves.
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), dir);
        assertEquals(Agent.DEFAULT_MAX_TURNS, config.maxTurns(),
                "the config's default and the harness's fallback are the same ceiling"
                        + " seen from two sides");
    }

    @Test
    void aSettingsFileMovesIt(@TempDir Path dir) throws Exception {
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), """
                { "maxTurns": 40 }
                """);
        assertEquals(40, SpectroConfig.load(SpectroConfig.Overrides.none(), dir).maxTurns());
    }

    @Test
    void theSettingsApiAcceptsTheKeyRatherThanRefusingIt() {
        // The card-203-F2 class of defect: a key the record knows and the writer
        // does not is a silent refusal on the one working save path.
        assertTrue(SettingsWriter.knownKeys().contains("maxTurns"),
                "the settings page could not save the key this card exists for");
    }

    @Test
    void provenanceKnowsTheField(@TempDir Path dir) throws Exception {
        // The /api/settings origins view is driven off FIELD_PROBES — a field
        // missing there resolves fine and lies about where it came from, so the
        // page would draw a "from defaults" chip over an operator's own value.
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), """
                { "maxTurns": 40 }
                """);
        var resolved = SpectroConfig.loadResolved(SpectroConfig.Overrides.none(), dir, null,
                java.util.Map.of());
        assertEquals("launch-dir", resolved.origins().get("maxTurns").winner(),
                "the field has no probe, so its origin is invented");
    }
}
