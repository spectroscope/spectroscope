package dev.spectroscope.cli;

import dev.spectroscope.core.leveling.Ladder;
import dev.spectroscope.core.leveling.LevelingFold;
import dev.spectroscope.core.leveling.LevelingState;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The ladder in text, for the terminal and for the doctor. Rendering is a pure
 * function of ladder plus state so it can be pinned without touching a real
 * home directory — and so the CLI, which has no i18n layer, derives its names
 * from the ids rather than carrying a second copy of the words.
 */
class LevelCommandTest {

    private static final Ladder LADDER = Ladder.bundled();

    private static LevelingState at(String... criteria) {
        LevelingState state = LevelingState.fresh(LevelingState.Mode.LADDER);
        for (String id : criteria) {
            state = LevelingFold.tick(LADDER, state, id, 1L);
        }
        return state;
    }

    @Test
    void theDoctorLineNamesModeLevelAndWhatIsLeft() {
        String line = LevelCommand.doctorLine(LADDER, at("provider-ready"));
        assertEquals("leveling: tutorial · level 1 (first light) · 0/2 toward the trace", line);
    }

    /** The owner renamed the words, not the file. A home written before the
     *  rename still says {@code "ladder"} in {@code leveling.json}, and a home
     *  written after it still has to. This pins the two apart: the terminal
     *  reads "tutorial", the wire keeps the spelling every stored file uses. */
    @Test
    void theModeIsCalledTutorialInTextAndLadderOnTheWire() {
        assertEquals("ladder", LevelingState.Mode.LADDER.wire());
        String line = LevelCommand.doctorLine(LADDER, at("provider-ready"));
        assertFalse(line.contains("ladder"), "the terminal stopped saying ladder: " + line);
        assertTrue(line.contains("tutorial"), line);
    }

    @Test
    void theDoctorLineCountsPartialProgress() {
        String line = LevelCommand.doctorLine(LADDER, at("provider-ready", "first-run-complete"));
        assertTrue(line.endsWith("1/2 toward the trace"), line);
    }

    @Test
    void atTheTopThereIsNothingToClimbToward() {
        LevelingState top = at("provider-ready", "first-run-complete", "session-reopened",
                "trace-opened", "replay-scrubbed", "disclosure-expanded",
                "mode-set", "gate-answered",
                "fanout-watched", "lens-used", "lab-stepped",
                "fleet-entered", "machine-room-opened");
        String line = LevelCommand.doctorLine(LADDER, top);
        assertTrue(line.contains("level 6 (deep field)"), line);
        assertFalse(line.contains("toward"), "the top of the ladder points nowhere: " + line);
    }

    @Test
    void offSaysSoAndStopsThere() {
        String line = LevelCommand.doctorLine(LADDER, LevelingState.fresh(LevelingState.Mode.OFF));
        assertEquals("leveling: off", line);
    }

    @Test
    void thePanelShowsEveryRungWithItsCriteria() {
        String panel = LevelCommand.render(LADDER, at("provider-ready"));
        for (String name : new String[] {"dark frame", "first light", "the trace", "the gate",
                "the prism", "the fleet", "deep field"}) {
            assertTrue(panel.contains(name), "the panel names every rung, missing: " + name);
        }
        assertTrue(panel.contains("provider-ready"), "criteria are named by id, which is what a beacon uses");
    }

    @Test
    void metCriteriaAreTickedAndUnmetOnesAreNot() {
        String panel = LevelCommand.render(LADDER, at("provider-ready"));
        String providerRow = panel.lines().filter(l -> l.contains("provider-ready")).findFirst().orElseThrow();
        String pendingRow = panel.lines().filter(l -> l.contains("first-run-complete")).findFirst().orElseThrow();
        assertTrue(providerRow.contains("✓"), providerRow);
        assertFalse(pendingRow.contains("✓"), pendingRow);
    }

    @Test
    void aHandTickSaysSoInThePanel() {
        String panel = LevelCommand.render(LADDER, at("provider-ready"));
        String row = panel.lines().filter(l -> l.contains("provider-ready")).findFirst().orElseThrow();
        assertTrue(row.contains("by hand"), "a manual tick never passes itself off as observed: " + row);
    }

    @Test
    void anObservedMarkShowsItsSession() {
        LevelingState observed = LevelingFold.observe(LADDER,
                LevelingState.fresh(LevelingState.Mode.LADDER), "20260726-aaa", 4,
                new dev.spectroscope.core.events.RunEvent.RunEnd("r", "end_turn", 5L));
        String row = LevelCommand.render(LADDER, observed).lines()
                .filter(l -> l.contains("first-run-complete")).findFirst().orElseThrow();
        assertTrue(row.contains("20260726-aaa"), "progression with receipts: " + row);
    }

    @Test
    void masteryIsShownApartBecauseItGatesNothing() {
        String panel = LevelCommand.render(LADDER, at("provider-ready"));
        assertTrue(panel.contains("mastery"), "the five badge criteria are labelled as such");
    }
}
