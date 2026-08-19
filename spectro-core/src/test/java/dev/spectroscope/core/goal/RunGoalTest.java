package dev.spectroscope.core.goal;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 267, the statement: what the operator wrote is what the model reads.
 */
class RunGoalTest {

    @Test
    void theOperatorsWordsTravelByteForByte() {
        // Criterion 2 is a BYTE comparison on a compacted run, so a section that
        // normalised, summarised or reflowed its input would pass a contains
        // check while failing the property the card is about.
        String outcome = "The auth tests pass.\n\n  - including the refresh-token case\n"
                + "  - without loosening any threshold";
        String section = new RunGoal(outcome, "node --test").promptSection();
        assertTrue(section.contains(outcome), section);
    }

    @Test
    void theCheckCommandIsNamedInThePromptSoTheModelKnowsWhatGradesIt() {
        String section = new RunGoal("the auth tests pass", "node --test test/auth.test.js")
                .promptSection();
        assertTrue(section.contains("node --test test/auth.test.js"), section);
    }

    @Test
    void aGoalWithoutACheckSaysSoRatherThanPretending() {
        String section = new RunGoal("ship it", null).promptSection();
        assertTrue(section.contains("untested"), section);
        assertFalse(new RunGoal("ship it", null).hasCheck());
        assertFalse(new RunGoal("ship it", "   ").hasCheck());
    }

    @Test
    void anUnstatedGoalContributesNothingAtAll() {
        // The null-goal path has to be byte-identical to a run without the
        // feature: an empty heading in every system prompt would be a token bill
        // charged for nothing.
        assertEquals("", new RunGoal(null, "node --test").promptSection());
        assertEquals("", new RunGoal("  ", "node --test").promptSection());
        assertFalse(new RunGoal("  ", "node --test").stated());
    }

    @Test
    void thePromptTellsTheModelNotToReportTheGoalMetItself() {
        // The prose here is DATA, not the mechanism. What it must NOT do is
        // invite the model to announce the verdict — that is exactly the claim
        // the check exists to replace.
        String section = new RunGoal("the auth tests pass", "node --test").promptSection();
        assertTrue(section.contains("Do not report the goal as met"), section);
        assertTrue(section.contains("the check decides"), section);
    }
}
