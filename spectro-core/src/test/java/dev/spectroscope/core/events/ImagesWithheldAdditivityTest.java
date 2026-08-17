package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 252: what the harness kept back becomes a line of the session.
 *
 * <p>Without it the operator sees a model answer a prompt about a screenshot
 * with no screenshot in the request, and nothing anywhere says why — the
 * bubble still shows the picture, because the record keeps it. The line is the
 * only place the withholding is stated, so it has to survive a reopened
 * session, which means it has to be on the wire.</p>
 *
 * <p>Additive on the card-72/184/195/204 precedent: no existing line moves,
 * and a reader that has never heard of this type must survive it.</p>
 */
class ImagesWithheldAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private RunEvent.ImagesWithheld withheld() {
        return new RunEvent.ImagesWithheld("main", 1, "deepseek-v4-flash", "no_vision", 99L);
    }

    @Test
    void itRoundTripsThroughTheWire() throws Exception {
        String line = JSON.writeValueAsString(withheld());
        RunEvent.ImagesWithheld back =
                (RunEvent.ImagesWithheld) JSON.readValue(line, RunEvent.class);
        assertEquals(withheld(), back, "the record is the contract; a lossy field is a lost fact");
        assertTrue(line.contains("\"type\":\"images_withheld\""), line);
        assertTrue(line.contains("\"images\":1"), line);
    }

    @Test
    void anUnnamedModelIsAbsentRatherThanEmpty() throws Exception {
        // A provider that reports no model id (the built-in runtime before it
        // resolves, a foreign implementation) must not put "" on the record —
        // that would read as a model whose name is the empty string.
        String line = JSON.writeValueAsString(
                new RunEvent.ImagesWithheld("main", 2, null, "no_vision", 5L));
        assertFalse(line.contains("model"), line);
        assertNull(((RunEvent.ImagesWithheld) JSON.readValue(line, RunEvent.class)).model());
    }

    @Test
    void anOlderLineOfEveryOtherTypeStillParses() throws Exception {
        String old = "{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":5}";
        assertEquals(1, ((RunEvent.TurnStart) JSON.readValue(old, RunEvent.class)).turn());
    }

    @Test
    void aReaderSurvivesFieldsItDoesNotKnow() throws Exception {
        String fromTheFuture = "{\"type\":\"images_withheld\",\"agentId\":\"main\","
                + "\"images\":3,\"model\":\"deepseek-v4-flash\",\"reason\":\"no_vision\","
                + "\"ts\":1,\"describedBy\":\"a-vision-model-nobody-has-wired-yet\"}";
        RunEvent.ImagesWithheld read =
                (RunEvent.ImagesWithheld) JSON.readValue(fromTheFuture, RunEvent.class);
        assertEquals(3, read.images());
        assertEquals("no_vision", read.reason());
    }
}
