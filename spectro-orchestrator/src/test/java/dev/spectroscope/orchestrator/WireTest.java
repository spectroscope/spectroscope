package dev.spectroscope.orchestrator;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The ProcessBus wire protocol (card 22): newline-framed JSON ops, version
 * pinned to 1 from day one. The codec is pure — no sockets here — so every
 * protocol rule is provable without timing.
 */
class WireTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static BusEnvelope envelope(long seq) {
        return new BusEnvelope("node-a", "ctx-1", "ctx-1", seq,
                seq == 0 ? BusEnvelope.CHAIN_ROOT : "node-a#" + (seq - 1),
                BusEnvelope.topicFor("ctx-1"), 42L,
                new RunEvent.TextDelta("main", "hello", 42L));
    }

    @Test
    void everyOpRoundTripsThroughOneLine() {
        Wire.Msg hello = Wire.parse(Wire.hello("client-7"), JSON);
        assertEquals("client-7", assertInstanceOf(Wire.Hello.class, hello).clientId());

        Wire.Msg sub = Wire.parse(Wire.sub("ctx-1.events", Map.of("node-a", 4L)), JSON);
        Wire.Sub parsedSub = assertInstanceOf(Wire.Sub.class, sub);
        assertEquals("ctx-1.events", parsedSub.topic());
        assertEquals(Map.of("node-a", 4L), parsedSub.cursor());

        Wire.Msg pub = Wire.parse(Wire.pub(envelope(3), JSON), JSON);
        BusEnvelope env = assertInstanceOf(Wire.Pub.class, pub).frame();
        assertEquals("node-a", env.sender());
        assertEquals(3, env.sequence());
        assertEquals(new RunEvent.TextDelta("main", "hello", 42L), env.payload());

        Wire.Msg ack = Wire.parse(Wire.ack("ctx-1.events", "node-a", 9L), JSON);
        Wire.Ack parsedAck = assertInstanceOf(Wire.Ack.class, ack);
        assertEquals("ctx-1.events", parsedAck.topic(),
                "the ack carries its topic — high-waters are per (topic, sender), and an ack"
                        + " without the topic would trim a same-named sender's OTHER topics");
        assertEquals("node-a", parsedAck.sender());
        assertEquals(9L, parsedAck.highWater());

        Wire.Msg gap = Wire.parse(Wire.gap("ctx-1.events", "node-a", 2L, 5L), JSON);
        Wire.Gap parsedGap = assertInstanceOf(Wire.Gap.class, gap);
        assertEquals("ctx-1.events", parsedGap.topic());
        assertEquals("node-a", parsedGap.sender());
        assertEquals(2L, parsedGap.fromSeq());
        assertEquals(5L, parsedGap.toSeq());
    }

    @Test
    void everyLineIsSingleLineAndVersioned() {
        for (String line : new String[] {
                Wire.hello("c"), Wire.sub("t", Map.of()), Wire.pub(envelope(0), JSON),
                Wire.ack("t", "s", 1L), Wire.gap("t", "s", 1L, 2L)}) {
            assertTrue(line.indexOf('\n') < 0, "one op = one line: " + line);
            assertTrue(line.contains("\"v\":1"), "the protocol wears its version: " + line);
        }
    }

    @Test
    void anUnknownOpOrForeignVersionFailsLoudly() {
        assertThrows(IllegalArgumentException.class,
                () -> Wire.parse("{\"v\":1,\"op\":\"warp\"}", JSON));
        assertThrows(IllegalArgumentException.class,
                () -> Wire.parse("{\"v\":2,\"op\":\"hello\",\"clientId\":\"c\"}", JSON));
        assertThrows(IllegalArgumentException.class,
                () -> Wire.parse("not json at all", JSON));
    }
}
