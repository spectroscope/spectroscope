package dev.spectroscope.orchestrator;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The message verb (card 166's server leg, card 189's gate to everything): the
 * hub addresses an operator's words to ONE node over its live connection, and
 * the node dispatches them to an {@code onMessage} seam. Same best-effort
 * channel as {@code stop} and the gate answer — this is the delivery half; what
 * a node DOES with the words is the node command's business.
 *
 * <p>The verb rides the existing {@code ctl} op rather than a new one, but it
 * DOES cost a version bump, and that is the measurement this suite pins: a
 * pre-message node reads {@code action:"message"} as a plain control verb, and
 * its handler tests {@code "stop".equals(action)} — so the words would vanish
 * with no log line anywhere. Silent loss is the one thing the wire's own rule
 * (KONZEPT §8 trap 1) forbids, so v3 must fail LOUDLY on the line instead.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class ProcessBusMessageTest {

    private static final String TOPIC = BusEnvelope.topicFor("fleet-msg");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void theHubAddressesAMessageToOneNodeByItsConnection() throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            NodeCard card = new NodeCard("node-m", "worker", List.of("read_file"), TOPIC);
            CountDownLatch joined = new CountDownLatch(1);
            hub.onRosterChange(joined::countDown);
            try (ProcessBus node = new ProcessBus("127.0.0.1", hub.port(), "node-m", 1024, card)) {
                BlockingQueue<String> messages = new LinkedBlockingQueue<>();
                node.onMessage(messages::add);

                assertTrue(joined.await(5, TimeUnit.SECONDS), "the carded node registered on the hub");
                hub.message("node-m", "read the second file too");

                assertEquals("read the second file too", messages.poll(5, TimeUnit.SECONDS),
                        "the addressed words reached exactly that node's onMessage seam");
            }
        }
    }

    @Test
    void aMessageDoesNotArriveAsAPlainControlVerb() throws Exception {
        // The dispatch is on the SHAPE of the line, not on the verb string: a
        // node that only wired onControl must not see "message" as a verb it
        // could half-understand. This is the same discipline the gate answer
        // follows (callId present => gate, never control).
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            NodeCard card = new NodeCard("node-m", "worker", List.of(), TOPIC);
            CountDownLatch joined = new CountDownLatch(1);
            hub.onRosterChange(joined::countDown);
            try (ProcessBus node = new ProcessBus("127.0.0.1", hub.port(), "node-m", 1024, card)) {
                BlockingQueue<String> control = new LinkedBlockingQueue<>();
                BlockingQueue<String> messages = new LinkedBlockingQueue<>();
                node.onControl(control::add);
                node.onMessage(messages::add);

                assertTrue(joined.await(5, TimeUnit.SECONDS), "the node registered");
                hub.message("node-m", "hello");
                hub.control("node-m", "stop");

                assertEquals("hello", messages.poll(5, TimeUnit.SECONDS), "the words landed on onMessage");
                assertEquals("stop", control.poll(5, TimeUnit.SECONDS),
                        "and the control seam saw only the control verb, never the message");
                assertNull(control.poll(200, TimeUnit.MILLISECONDS), "nothing else reached onControl");
            }
        }
    }

    @Test
    void anUnknownNodeIsAWarnAndNeverAThrow() throws Exception {
        // Same contract as control(): a caller must not fail because a node
        // vanished a millisecond earlier. The 202 from the endpoint means SENT.
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            hub.message("nobody-home", "are you there");
        }
    }

    @Test
    void aMessageHandlerThatThrowsDoesNotKillTheReaderLoop() throws Exception {
        // User code on the reader thread, guarded like onControl and onGate: one
        // poison message must not strand the node's whole event stream.
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            NodeCard card = new NodeCard("node-m", "worker", List.of(), TOPIC);
            CountDownLatch joined = new CountDownLatch(1);
            hub.onRosterChange(joined::countDown);
            try (ProcessBus node = new ProcessBus("127.0.0.1", hub.port(), "node-m", 1024, card)) {
                BlockingQueue<String> control = new LinkedBlockingQueue<>();
                node.onMessage(text -> {
                    throw new IllegalStateException("boom on " + text);
                });
                node.onControl(control::add);

                assertTrue(joined.await(5, TimeUnit.SECONDS), "the node registered");
                hub.message("node-m", "poison");
                hub.control("node-m", "stop");

                assertEquals("stop", control.poll(5, TimeUnit.SECONDS),
                        "the reader survived the throwing message handler and delivered the next line");
            }
        }
    }

    @Test
    void theMessageLineIsItsOwnShapeOnTheWire() {
        String line = Wire.ctl("message", "two words");
        Wire.Msg parsed = Wire.parse(line, MAPPER);

        assertTrue(parsed instanceof Wire.Ctl, "a message rides the ctl op, not a new one");
        Wire.Ctl ctl = (Wire.Ctl) parsed;
        assertEquals("message", ctl.action());
        assertEquals("two words", ctl.text(), "the words survive the round trip verbatim");
        assertNull(ctl.callId(), "a message is not a gate answer");
        assertNull(ctl.allow(), "and carries no verdict");
    }

    @Test
    void aPlainControlVerbStaysByteIdenticalAndTextFree() {
        // stop must not grow a field it does not need — the parse dispatch reads
        // the ABSENCE of text as "this is a plain verb".
        String line = Wire.ctl("stop");
        assertTrue(line.contains("\"action\":\"stop\""), line);
        assertTrue(!line.contains("text"), "a plain verb carries no text field: " + line);

        Wire.Ctl parsed = (Wire.Ctl) Wire.parse(line, MAPPER);
        assertNull(parsed.text(), "and parses back with no words");
    }

    @Test
    void theVersionBumpedSoAPreMessageNodeCannotSwallowTheWords() {
        // THE reason this leg costs a version bump, measured rather than
        // asserted: a v3 node parses action:"message" as a plain control verb,
        // and every shipped control handler is `if ("stop".equals(action))`. The
        // words would be dropped with no log line on either side — the operator
        // would watch a 202 and silence. So the line must be unreadable to v3
        // rather than quietly misread.
        assertEquals(4, Wire.VERSION, "the message op moved the delivery dialect forward");

        String v3Line = Wire.ctl("message", "hello").replace("\"v\":4", "\"v\":3");
        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> Wire.parse(v3Line, MAPPER));
        assertNotNull(refused.getMessage());
        assertTrue(refused.getMessage().contains("version"),
                "a foreign version fails loudly at parse time: " + refused.getMessage());
    }
}
