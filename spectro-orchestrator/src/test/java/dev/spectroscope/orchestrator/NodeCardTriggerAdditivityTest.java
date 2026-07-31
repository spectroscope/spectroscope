package dev.spectroscope.orchestrator;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Card 72: the NodeCard grows an OPTIONAL trigger note ("waiting on
 * watch:/drop") that rides the hello like the card itself did — additive
 * metadata on the handshake, no version bump. A card without the note keeps
 * its exact pre-card-72 bytes, and a pre-card-72 hello still parses.
 */
class NodeCardTriggerAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void theLegacyArityCarriesNoTrigger() {
        NodeCard card = new NodeCard("n1", "worker", List.of("read_file"), "t.events");
        assertNull(card.trigger(), "every existing construction site stays a plain card");
    }

    @Test
    void aTriggerlessHelloKeepsThePreCard72Bytes() {
        NodeCard card = new NodeCard("n1", "worker", List.of(), "t.events");
        String line = Wire.hello("n1", card);
        assertFalse(line.contains("trigger"),
                "absent stays absent — a pre-card-72 hub reads the exact old line: " + line);
    }

    @Test
    void aTriggerNoteRidesTheHelloAndParsesBack() {
        NodeCard card = new NodeCard("n1", "worker", List.of(), "t.events", "watch:/drop");
        Wire.Hello hello = (Wire.Hello) Wire.parse(Wire.hello("n1", card), JSON);
        assertEquals("watch:/drop", hello.card().orElseThrow().trigger());
        assertEquals(card, hello.card().orElseThrow(), "the whole card round-trips");
    }

    @Test
    void anOldHelloLineWithoutTheNoteStillParses() {
        String preCard72 = "{\"v\":3,\"op\":\"hello\",\"clientId\":\"n1\",\"card\":{"
                + "\"id\":\"n1\",\"role\":\"worker\",\"capabilities\":[],\"topic\":\"t.events\"}}";
        Wire.Hello hello = (Wire.Hello) Wire.parse(preCard72, JSON);
        assertNull(hello.card().orElseThrow().trigger(),
                "a v3 node that predates triggers announces a plain card — no note, no crash");
    }

    @Test
    void aNullTriggerIsOmittedFromJacksonSerialization() throws Exception {
        // The card is Jackson-visible beyond the wire codec (server-side
        // serialization) — absent must stay absent there as well.
        String json = JSON.writeValueAsString(new NodeCard("n1", "worker", List.of(), "t.events"));
        assertFalse(json.contains("trigger"), "no null-noise on any Jackson face: " + json);
    }
}
