package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 204: a browser tool call becomes a line of the session.
 *
 * <p>The same argument card 184 leg 3 made for {@code llm_exchange}. Without it,
 * a reopened session cannot say that a browser was ever driven — the sidecar
 * holds the trace, but nothing in the file points at it, so a replay would have
 * to guess which sessions have one. Metadata only: everything a browser call
 * actually said lives in the sidecar and behind the gated endpoint.
 *
 * <p>Additive, on the card-72 and card-184 precedent: nothing about an existing
 * line moves, and a reader that has never heard of this type must survive it.
 */
class BrowserActionAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private RunEvent.BrowserAction sample() {
        return new RunEvent.BrowserAction("main", "toolu_01", "c-1", 2, "browser_navigate",
                "https://example.com", true, 84L, 412L, null, 99L);
    }

    @Test
    void itRoundTripsThroughTheWire() throws Exception {
        String line = JSON.writeValueAsString(sample());
        RunEvent.BrowserAction back = (RunEvent.BrowserAction) JSON.readValue(line, RunEvent.class);
        assertEquals(sample(), back, "the record is the contract; a lossy field is a lost fact");
        assertTrue(line.contains("\"type\":\"browser_action\""), line);
    }

    @Test
    void theCidAndTheEpochAreWhatJoinTheEventToTheSidecar() throws Exception {
        String line = JSON.writeValueAsString(sample());
        // cid pairs the row with the sidecar's two lines; epoch says WHICH
        // browser of this session's life it drove, so a resumed session's second
        // browser is never replayed as a continuation of the first (card 218).
        assertTrue(line.contains("\"cid\":\"c-1\""), line);
        assertTrue(line.contains("\"epoch\":2"), line);
    }

    @Test
    void aScreenshotActionNamesItsBlobAndACallWithoutOneCarriesNoHash() throws Exception {
        RunEvent.BrowserAction shot = new RunEvent.BrowserAction("main", "toolu_02", "c-2", 1,
                "browser_computer", "https://example.com", true, 96L, 210L,
                "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", 100L);
        String line = JSON.writeValueAsString(shot);
        assertTrue(line.contains("\"sha256\":\"9f86d081"), line);

        // The blob's hash pairs this row with the image_generated event that
        // announced the same picture. No hash means no picture — never an empty
        // string standing in for one.
        assertFalse(JSON.writeValueAsString(sample()).contains("sha256"),
                "an absent field stays absent on the wire");
        assertNull(((RunEvent.BrowserAction) JSON.readValue(
                JSON.writeValueAsString(sample()), RunEvent.class)).sha256());
    }

    @Test
    void noImageBytesCanRideThisEvent() throws Exception {
        // The whole point of the reference. A picture is a blob in the store and
        // a hash on this line; the JSONL stays text-sized however many
        // screenshots a run takes.
        String line = JSON.writeValueAsString(new RunEvent.BrowserAction("main", "t", "c", 1,
                "browser_computer", "https://example.com", true, 96L, 210L, "abc", 1L));
        assertFalse(line.contains("dataBase64"), line);
        assertFalse(line.contains("base64"), line);
    }

    @Test
    void anOlderLineOfEveryOtherTypeStillParses() throws Exception {
        String old = "{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":5}";
        RunEvent.TurnStart start = (RunEvent.TurnStart) JSON.readValue(old, RunEvent.class);
        assertEquals(1, start.turn());
    }

    @Test
    void aReaderSurvivesFieldsItDoesNotKnow() throws Exception {
        String fromTheFuture = "{\"type\":\"browser_action\",\"agentId\":\"main\","
                + "\"callId\":\"toolu_9\",\"cid\":\"c-9\",\"epoch\":1,\"tool\":\"browser_eval\","
                + "\"url\":\"https://x/y\",\"ok\":false,\"resultBytes\":12,\"durationMs\":3,"
                + "\"ts\":1,\"somethingNobodyHasBuiltYet\":true}";
        RunEvent.BrowserAction read =
                (RunEvent.BrowserAction) JSON.readValue(fromTheFuture, RunEvent.class);
        assertEquals("browser_eval", read.tool());
        assertFalse(read.ok());
    }
}
