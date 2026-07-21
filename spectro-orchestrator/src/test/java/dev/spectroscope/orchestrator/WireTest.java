package dev.spectroscope.orchestrator;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The ProcessBus wire protocol (card 22): newline-framed JSON ops, version
 * pinned from day one (2 since epochs entered the dialect). The codec is
 * pure — no sockets here — so every protocol rule is provable without
 * timing.
 */
class WireTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static BusEnvelope envelope(long seq) {
        return new BusEnvelope("node-a", 2L, "ctx-1", "ctx-1", seq,
                seq == 0 ? BusEnvelope.CHAIN_ROOT : "node-a#2#" + (seq - 1),
                BusEnvelope.topicFor("ctx-1"), 42L,
                new RunEvent.TextDelta("main", "hello", 42L));
    }

    @Test
    void everyOpRoundTripsThroughOneLine() {
        Wire.Msg hello = Wire.parse(Wire.hello("client-7"), JSON);
        assertEquals("client-7", assertInstanceOf(Wire.Hello.class, hello).clientId());

        Wire.Msg sub = Wire.parse(
                Wire.sub("ctx-1.events", Map.of("node-a", Map.of(2L, 4L))), JSON);
        Wire.Sub parsedSub = assertInstanceOf(Wire.Sub.class, sub);
        assertEquals("ctx-1.events", parsedSub.topic());
        assertEquals(Map.of("node-a", Map.of(2L, 4L)), parsedSub.cursor(),
                "the cursor names each incarnation it consumed");

        Wire.Msg pub = Wire.parse(Wire.pub(envelope(3), JSON), JSON);
        BusEnvelope env = assertInstanceOf(Wire.Pub.class, pub).frame();
        assertEquals("node-a", env.sender());
        assertEquals(2L, env.epoch(), "the incarnation rides inside the frame");
        assertEquals(3, env.sequence());
        assertEquals(new RunEvent.TextDelta("main", "hello", 42L), env.payload());

        Wire.Msg ack = Wire.parse(Wire.ack("ctx-1.events", "node-a", 2L, 9L), JSON);
        Wire.Ack parsedAck = assertInstanceOf(Wire.Ack.class, ack);
        assertEquals("ctx-1.events", parsedAck.topic(),
                "the ack carries its topic — high-waters are per (topic, sender), and an ack"
                        + " without the topic would trim a same-named sender's OTHER topics");
        assertEquals("node-a", parsedAck.sender());
        assertEquals(2L, parsedAck.epoch(),
                "the ack names the incarnation — an old epoch's ack must not trim a new one");
        assertEquals(9L, parsedAck.highWater());

        Wire.Msg gap = Wire.parse(Wire.gap("ctx-1.events", "node-a", 2L, 2L, 5L), JSON);
        Wire.Gap parsedGap = assertInstanceOf(Wire.Gap.class, gap);
        assertEquals("ctx-1.events", parsedGap.topic());
        assertEquals("node-a", parsedGap.sender());
        assertEquals(2L, parsedGap.epoch());
        assertEquals(2L, parsedGap.fromSeq());
        assertEquals(5L, parsedGap.toSeq());
    }

    @Test
    void everyLineIsSingleLineAndVersioned() {
        for (String line : new String[] {
                Wire.hello("c"), Wire.sub("t", Map.of()), Wire.pub(envelope(0), JSON),
                Wire.ack("t", "s", 0L, 1L), Wire.gap("t", "s", 0L, 1L, 2L), Wire.ctl("stop")}) {
            assertTrue(line.indexOf('\n') < 0, "one op = one line: " + line);
            assertTrue(line.contains("\"v\":3"),
                    "the protocol wears its version — v3 since the ctl op entered the dialect: " + line);
        }
    }

    @Test
    void aCtlOpRoundTripsForReverseControl() {
        // Block 2: the hub addresses a node with a control verb (reverse of the
        // node->hub pub flow). The version bumped to 3 the moment the delivery
        // dialect grew a sixth op, so a v2 fleet can never misread a ctl line.
        Wire.Ctl parsed = assertInstanceOf(Wire.Ctl.class, Wire.parse(Wire.ctl("stop"), JSON));
        assertEquals("stop", parsed.action(), "the control verb survives the round-trip");
    }

    @Test
    void aGateCtlCarriesCallIdAndAllow() {
        // Block 4: the hub answers a parked permission gate on a node — the
        // control verb "gate" rides the callId it addresses and the verdict.
        // A new verb with extra fields adds no op, so the version stays 3 and a
        // pre-gate v3 node reads action="gate", ignores the fields, and no-ops.
        Wire.Ctl allowed = assertInstanceOf(Wire.Ctl.class,
                Wire.parse(Wire.ctl("gate", "call-7", true), JSON));
        assertEquals("gate", allowed.action());
        assertEquals("call-7", allowed.callId(), "the addressed callId survives the round-trip");
        assertEquals(Boolean.TRUE, allowed.allow(), "the verdict survives the round-trip");

        // A denial round-trips too — false is a real verdict, not an absent one.
        Wire.Ctl denied = assertInstanceOf(Wire.Ctl.class,
                Wire.parse(Wire.ctl("gate", "call-8", false), JSON));
        assertEquals(Boolean.FALSE, denied.allow());
    }

    @Test
    void aStopCtlStaysByteIdenticalWithoutGateFields() {
        // The frozen stop verb must NOT grow callId/allow keys: a pre-gate node
        // parses the exact same line, and the gate fields default to null so the
        // reader dispatches stop by callId==null, not by sniffing the verb.
        String stop = Wire.ctl("stop");
        assertEquals("{\"v\":3,\"op\":\"ctl\",\"action\":\"stop\"}", stop,
                "stop is byte-identical — no callId/allow keys leak onto it");
        Wire.Ctl parsed = assertInstanceOf(Wire.Ctl.class, Wire.parse(stop, JSON));
        assertEquals("stop", parsed.action());
        assertNull(parsed.callId(), "a plain control verb carries no callId");
        assertNull(parsed.allow(), "a plain control verb carries no verdict");
    }

    @Test
    void aNodeCardRidesTheHelloOp() {
        // Block-B decision: registration rides the connection op — no sixth
        // wire op, no heartbeat bookkeeping. The card is optional metadata on
        // hello; the delivery dialect (sub/pub/ack/gap) is untouched, which is
        // why the version stays 2.
        NodeCard card = new NodeCard("node-a", "worker",
                java.util.List.of("read_file", "write_file"), "ctx-1.events");
        Wire.Hello parsed = assertInstanceOf(Wire.Hello.class,
                Wire.parse(Wire.hello("node-a", card), JSON));
        assertEquals("node-a", parsed.clientId());
        assertEquals(java.util.Optional.of(card), parsed.card(),
                "the card survives the round-trip whole");
    }

    @Test
    void aMalformedCardObjectIsNoCardNotAGhost() {
        // A card without id and topic must not become an empty-string ghost
        // in rosters — "malformed card is simply no card" is the contract.
        Wire.Hello parsed = assertInstanceOf(Wire.Hello.class, Wire.parse(
                "{\"v\":3,\"op\":\"hello\",\"clientId\":\"c\",\"card\":{}}", JSON));
        assertEquals(java.util.Optional.empty(), parsed.card());

        Wire.Hello topicless = assertInstanceOf(Wire.Hello.class, Wire.parse(
                "{\"v\":3,\"op\":\"hello\",\"clientId\":\"c\",\"card\":{\"id\":\"n\"}}", JSON));
        assertEquals(java.util.Optional.empty(), topicless.card(),
                "id without topic is still no card");
    }

    @Test
    void aCardlessHelloStaysAHello() {
        Wire.Hello parsed = assertInstanceOf(Wire.Hello.class,
                Wire.parse(Wire.hello("client-7"), JSON));
        assertEquals("client-7", parsed.clientId());
        assertEquals(java.util.Optional.empty(), parsed.card(),
                "the card is optional — a plain client (panel, test, tap) sends none");
    }

    @Test
    void aMultiEpochCursorForOneSenderCrossesTheWire() {
        // A subscriber that consumed two incarnations of one sender resumes
        // both — the nested cursor must survive the JSON round-trip intact.
        Wire.Msg sub = Wire.parse(
                Wire.sub("ctx-1.events", Map.of("node-a", Map.of(1L, 7L, 2L, 3L))), JSON);
        assertEquals(Map.of("node-a", Map.of(1L, 7L, 2L, 3L)),
                assertInstanceOf(Wire.Sub.class, sub).cursor());
    }

    @Test
    void gapFieldsCannotBeTransposedUnnoticed() {
        // Epoch, fromSeq and toSeq all distinct — a field transposition in the
        // codec must fail here, not in a fleet at night.
        Wire.Gap gap = assertInstanceOf(Wire.Gap.class,
                Wire.parse(Wire.gap("t", "s", 9L, 2L, 5L), JSON));
        assertEquals(9L, gap.epoch());
        assertEquals(2L, gap.fromSeq());
        assertEquals(5L, gap.toSeq());
    }

    @Test
    void anUnknownOpOrForeignVersionFailsLoudly() {
        assertThrows(IllegalArgumentException.class,
                () -> Wire.parse("{\"v\":3,\"op\":\"warp\"}", JSON));
        assertThrows(IllegalArgumentException.class,
                () -> Wire.parse("{\"v\":1,\"op\":\"hello\",\"clientId\":\"c\"}", JSON),
                "the pre-epoch dialect is a foreign protocol — mixing must fail loudly");
        assertThrows(IllegalArgumentException.class,
                () -> Wire.parse("{\"v\":2,\"op\":\"hello\",\"clientId\":\"c\"}", JSON),
                "the pre-ctl dialect (v2) is now foreign too — a bump auto-protects mixed fleets");
        assertThrows(IllegalArgumentException.class,
                () -> Wire.parse("not json at all", JSON));
    }
}
