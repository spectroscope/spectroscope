package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 262: the line that says the harness noticed nothing is moving.
 *
 * <p>Additive on the card-72/184/195/204/252/265 precedent: no existing line
 * moves, and a reader that has never heard of this type must survive it.</p>
 */
class NoProgressAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private RunEvent.NoProgress said() {
        return new RunEvent.NoProgress("main", "identical_writes", 3,
                List.of("src/particleEngine.js", "src/particleEngine2.js",
                        "src/particleEngine3.js", "src/particleEngine4.js"),
                "The same 283 bytes have already gone to 3 paths.", 7L);
    }

    @Test
    void itRoundTripsThroughTheWire() throws Exception {
        String line = JSON.writeValueAsString(said());
        RunEvent.NoProgress back = (RunEvent.NoProgress) JSON.readValue(line, RunEvent.class);
        assertEquals(said(), back, "the record is the contract; a lossy field is a lost fact");
        assertTrue(line.contains("\"type\":\"no_progress\""), line);
        assertTrue(line.contains("\"detector\":\"identical_writes\""), line);
        assertTrue(line.contains("\"count\":3"), line);
    }

    @Test
    void theDetectorTravelsAsAWordAndNotAsAnOrdinal() throws Exception {
        // A UI keys off this. An ordinal would renumber the day a fourth
        // detector is inserted anywhere but at the end, and nothing would
        // go red — the same class of defect card 269 avoided for fileChange.
        String line = JSON.writeValueAsString(said());
        assertFalse(line.contains("\"detector\":0"), line);
        assertTrue(line.contains("identical_writes"), line);
    }

    @Test
    void aDetectorWithNothingToListShipsNoEmptyArray() throws Exception {
        // Absence is absence. An empty array reads as "it looked and found
        // nothing to name", which is a different claim from "this detector has
        // no list to give".
        String line = JSON.writeValueAsString(new RunEvent.NoProgress(
                "main", "stalled_plan", 5, null, "The plan has not moved for 5 turns.", 1L));
        assertFalse(line.contains("details"), line);
        assertNull(((RunEvent.NoProgress) JSON.readValue(line, RunEvent.class)).details());
    }

    @Test
    void anOlderReaderSurvivesAFieldItHasNeverHeardOf() throws Exception {
        // The rule that makes "extend only additively" true from the READING
        // side: without ignoreUnknown, Jackson raises an IOException that
        // SessionStore's reader discards as a torn line — silently.
        String enriched = "{\"type\":\"no_progress\",\"agentId\":\"main\","
                + "\"detector\":\"repeated_failure\",\"count\":3,"
                + "\"evidence\":\"the same call, 3 times\",\"ts\":5,"
                + "\"somethingFromTheFuture\":{\"nested\":true}}";
        RunEvent.NoProgress back = (RunEvent.NoProgress) JSON.readValue(enriched, RunEvent.class);
        assertEquals("repeated_failure", back.detector());
        assertEquals(3, back.count());
    }
}
