package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 267: the line that says what the goal's check found.
 *
 * <p>Additive on the card-72/184/195/204/252/262/265/266 precedent: no existing
 * line moves, and a reader that has never heard of this type must survive it.
 * Criterion 4 is what makes the fields load-bearing — a verdict without its
 * command and exit code is a claim, which is the thing the whole card exists to
 * replace.</p>
 */
class GoalCheckAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private RunEvent.GoalCheck said() {
        return new RunEvent.GoalCheck("main", "failed", "node --test", 1, null,
                "1 test failed", 1_240, null, "failed: the check exited 1", 9L);
    }

    @Test
    void itRoundTripsThroughTheWire() throws Exception {
        String line = JSON.writeValueAsString(said());
        RunEvent.GoalCheck back = (RunEvent.GoalCheck) JSON.readValue(line, RunEvent.class);
        assertEquals(said(), back, "the record is the contract; a lossy field is a lost fact");
        assertTrue(line.contains("\"type\":\"goal_check\""), line);
    }

    @Test
    void theVerdictCarriesWhatProducedIt() throws Exception {
        // Criterion 4, stated as bytes: the command AND its exit code travel
        // with the outcome, so a run recorded as met can be re-run by hand from
        // its own record.
        String line = JSON.writeValueAsString(said());
        assertTrue(line.contains("\"command\":\"node --test\""), line);
        assertTrue(line.contains("\"exitCode\":1"), line);
        assertTrue(line.contains("\"outcome\":\"failed\""), line);
    }

    @Test
    void theEvaluatorVariantIsAttributedToItsModelAndCarriesNoExitCode() throws Exception {
        RunEvent.GoalCheck judged = new RunEvent.GoalCheck("main", "met", null, null,
                "deepseek-v4-flash-0731@iq1_m", "GOAL_MET the tests ran", 900, null,
                "met: the evaluator deepseek-v4-flash-0731@iq1_m answered GOAL_MET", 9L);
        String line = JSON.writeValueAsString(judged);
        assertTrue(line.contains("\"judge\":\"deepseek-v4-flash-0731@iq1_m\""), line);
        assertFalse(line.contains("\"exitCode\""), "an opinion has no exit code: " + line);
        assertFalse(line.contains("\"command\""), "an opinion ran no command: " + line);
    }

    @Test
    void theOutcomeTravelsAsAWordAndNotAsAnOrdinal() throws Exception {
        String line = JSON.writeValueAsString(said());
        assertFalse(line.contains("\"outcome\":1"), line);
        assertTrue(line.contains("failed"), line);
    }

    @Test
    void theChecksOwnDurationRidesTheSameLine() throws Exception {
        // The non-functional criterion: the check's duration is recorded
        // SEPARATELY from the model's work, which means on the check's own line.
        String line = JSON.writeValueAsString(said());
        assertTrue(line.contains("\"durationMs\":1240"), line);
    }

    @Test
    void anOlderReaderSurvivesAFieldItHasNeverHeardOf() throws Exception {
        String enriched = "{\"type\":\"goal_check\",\"agentId\":\"main\",\"outcome\":\"untested\","
                + "\"output\":\"\",\"durationMs\":0,\"evidence\":\"untested: no check\",\"ts\":5,"
                + "\"somethingFromTheFuture\":{\"nested\":true}}";
        RunEvent.GoalCheck back = (RunEvent.GoalCheck) JSON.readValue(enriched, RunEvent.class);
        assertEquals("untested", back.outcome());
        assertNull(back.command());
    }
}
