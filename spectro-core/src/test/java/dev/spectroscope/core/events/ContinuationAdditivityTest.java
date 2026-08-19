package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 266: the line that says the harness kept an unfinished run going, or
 * refused to.
 *
 * <p>Additive on the card-72/184/195/204/252/262/265 precedent: no existing line
 * moves, and a reader that has never heard of this type must survive it. The
 * count is the whole point of criterion 3 — "continuations are visible and
 * countable, never silent" — so a continuation that does not reach the wire is
 * the defect, not a detail.</p>
 */
class ContinuationAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private RunEvent.Continuation said() {
        return new RunEvent.Continuation("main", "continued", 2, 3, 4, 6, 12_800,
                "continued: 4 of 6 steps open, continuation 2 of 3", 7L);
    }

    @Test
    void itRoundTripsThroughTheWire() throws Exception {
        String line = JSON.writeValueAsString(said());
        RunEvent.Continuation back = (RunEvent.Continuation) JSON.readValue(line, RunEvent.class);
        assertEquals(said(), back, "the record is the contract; a lossy field is a lost fact");
        assertTrue(line.contains("\"type\":\"continuation\""), line);
        assertTrue(line.contains("\"decision\":\"continued\""), line);
        assertTrue(line.contains("\"continuation\":2"), line);
        assertTrue(line.contains("\"budget\":3"), line);
    }

    @Test
    void theDecisionTravelsAsAWordAndNotAsAnOrdinal() throws Exception {
        // A UI keys off this. An ordinal would renumber the day a fourth
        // decision is inserted anywhere but at the end, and nothing would go
        // red — the same class of defect card 269 avoided for fileChange.
        String line = JSON.writeValueAsString(said());
        assertFalse(line.contains("\"decision\":0"), line);
        assertTrue(line.contains("continued"), line);
    }

    @Test
    void thePriceOfTheContinuationIsOnTheSameLine() throws Exception {
        // The non-functional criterion: one continuation costs one provider
        // exchange, and that cost is stated per continuation IN THE SAME
        // RECORD, so an evening of continuations is priceable afterwards
        // instead of being reconstructed by joining two files.
        String line = JSON.writeValueAsString(said());
        assertTrue(line.contains("\"inputTokens\":12800"), line);
    }

    @Test
    void anOlderReaderSurvivesAFieldItHasNeverHeardOf() throws Exception {
        // The rule that makes "extend only additively" true from the READING
        // side: without ignoreUnknown, Jackson raises an IOException that
        // SessionStore's reader discards as a torn line — silently.
        String enriched = "{\"type\":\"continuation\",\"agentId\":\"main\","
                + "\"decision\":\"budget_exhausted\",\"continuation\":3,\"budget\":3,"
                + "\"openSteps\":4,\"totalSteps\":6,\"inputTokens\":0,"
                + "\"evidence\":\"the budget is spent\",\"ts\":5,"
                + "\"somethingFromTheFuture\":{\"nested\":true}}";
        RunEvent.Continuation back =
                (RunEvent.Continuation) JSON.readValue(enriched, RunEvent.class);
        assertEquals("budget_exhausted", back.decision());
        assertEquals(3, back.continuation());
    }
}
