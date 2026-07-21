package dev.spectroscope.orchestrator;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Reverse control (block 2): the hub addresses a control verb to ONE node over
 * its live connection, and the node dispatches it to an {@code onControl} seam.
 * This is the wire under "stop a running fleet node" — the delivery half; the
 * cancel it triggers lives in the node command and the headless runner.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class ProcessBusControlTest {

    private static final String TOPIC = BusEnvelope.topicFor("fleet-ctl");

    @Test
    void theHubAddressesAControlVerbToOneNodeByItsConnection() throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            NodeCard card = new NodeCard("node-x", "worker", List.of("read_file"), TOPIC);
            CountDownLatch joined = new CountDownLatch(1);
            hub.onRosterChange(joined::countDown);
            try (ProcessBus node = new ProcessBus("127.0.0.1", hub.port(), "node-x", 1024, card)) {
                BlockingQueue<String> received = new LinkedBlockingQueue<>();
                node.onControl(received::add);

                assertTrue(joined.await(5, TimeUnit.SECONDS), "the carded node registered on the hub");
                hub.control("node-x", "stop");

                assertEquals("stop", received.poll(5, TimeUnit.SECONDS),
                        "the addressed control verb reached exactly that node's onControl seam");
            }
        }
    }

    @Test
    void aControlVerbGoesOnlyToTheAddressedNodeNotItsNeighbour() throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            CountDownLatch bothJoined = new CountDownLatch(2);
            hub.onRosterChange(bothJoined::countDown);
            NodeCard cardA = new NodeCard("node-a", "worker", List.of(), TOPIC);
            NodeCard cardB = new NodeCard("node-b", "worker", List.of(), TOPIC);
            try (ProcessBus a = new ProcessBus("127.0.0.1", hub.port(), "node-a", 1024, cardA);
                 ProcessBus b = new ProcessBus("127.0.0.1", hub.port(), "node-b", 1024, cardB)) {
                BlockingQueue<String> toA = new LinkedBlockingQueue<>();
                BlockingQueue<String> toB = new LinkedBlockingQueue<>();
                a.onControl(toA::add);
                b.onControl(toB::add);

                assertTrue(bothJoined.await(5, TimeUnit.SECONDS), "both nodes registered");
                hub.control("node-a", "stop");

                assertEquals("stop", toA.poll(5, TimeUnit.SECONDS), "the addressee got it");
                assertNull(toB.poll(300, TimeUnit.MILLISECONDS), "the neighbour did not");
            }
        }
    }

    @Test
    void controlToAnUnknownNodeIsANoOpNotAThrow() throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            // Best-effort: addressing a node that never connected (or already
            // left) must never fail the caller — the server endpoints lean on this.
            assertDoesNotThrow(() -> hub.control("ghost", "stop"));
        }
    }

    @Test
    void theHubAnswersAParkedGateOnOneNodeByItsConnection() throws Exception {
        // Block 4: the hub answers a node's parked permission gate — a "gate"
        // ctl carrying the callId it addresses and the operator's verdict. It
        // rides the SAME reverse channel as stop, but dispatches to onGate, not
        // onControl: a gate answer is not a control verb.
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            NodeCard card = new NodeCard("node-x", "worker", List.of("read_file"), TOPIC);
            CountDownLatch joined = new CountDownLatch(1);
            hub.onRosterChange(joined::countDown);
            try (ProcessBus node = new ProcessBus("127.0.0.1", hub.port(), "node-x", 1024, card)) {
                BlockingQueue<String> control = new LinkedBlockingQueue<>();
                BlockingQueue<String> gate = new LinkedBlockingQueue<>();
                node.onControl(control::add);
                node.onGate((callId, allow) -> gate.add(callId + "=" + allow));

                assertTrue(joined.await(5, TimeUnit.SECONDS), "the carded node registered");
                hub.controlGate("node-x", "call-7", true);

                assertEquals("call-7=true", gate.poll(5, TimeUnit.SECONDS),
                        "the gate answer reached onGate with its callId and verdict");
                assertNull(control.poll(300, TimeUnit.MILLISECONDS),
                        "a gate answer is NOT a control verb — onControl stays silent");
            }
        }
    }

    @Test
    void controlGateToAnUnknownNodeIsANoOpNotAThrow() throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            // Best-effort: answering a gate on a node that never connected (or
            // already left) must never fail the caller — FleetAggregator.controlGate
            // leans on this in the check-then-write TOCTOU where a node can depart.
            assertDoesNotThrow(() -> hub.controlGate("ghost", "call-7", true));
        }
    }

    @Test
    void onDisconnectFiresWhenAnEstablishedConnectionDropsNotOnAFailedFirstConnect() throws Exception {
        // Finding 1 (review): a fleet node's parked permission gate can ONLY be
        // freed by a live hub — so when an ESTABLISHED connection drops, the bus
        // must announce it, letting an ask-mode node release gates the departed
        // hub can no longer answer (else the run wedges until SIGTERM). It must
        // NOT fire during the pure initial connect-retry — nothing was ever up.

        // (a) never connected -> no onDisconnect. Port 1: nothing listens, connects refuse.
        try (ProcessBus never = new ProcessBus("127.0.0.1", 1, "node-x", 1024)) {
            AtomicBoolean fired = new AtomicBoolean(false);
            never.onDisconnect(() -> fired.set(true));
            Thread.sleep(300); // several failed connect attempts across the backoff
            assertFalse(fired.get(),
                    "a connection that never established must not announce a disconnect");
        }

        // (b) established, then the hub dies -> onDisconnect fires.
        ProcessBusHub hub = new ProcessBusHub(0);
        CountDownLatch joined = new CountDownLatch(1);
        hub.onRosterChange(joined::countDown);
        NodeCard card = new NodeCard("node-e", "worker", List.of(), TOPIC);
        try (ProcessBus node = new ProcessBus("127.0.0.1", hub.port(), "node-e", 1024, card)) {
            CountDownLatch disconnected = new CountDownLatch(1);
            node.onDisconnect(disconnected::countDown);
            assertTrue(joined.await(5, TimeUnit.SECONDS), "the node established a connection");
            hub.close(); // the established connection drops under the node
            assertTrue(disconnected.await(5, TimeUnit.SECONDS),
                    "a dropped established connection is announced to onDisconnect");
        }
    }

    @Test
    void onDisconnectRefiresEveryCycleWhileTheConnectionStaysDown() throws Exception {
        // Finding 5 (review): the micro-race — a gate parked JUST AFTER a down
        // cycle's deny — is closed by the NEXT cycle's deny, so announceDisconnect
        // must fire MORE THAN ONCE while the hub stays gone, not just once. Pin it
        // directly here, sidestepping the node-run timing.
        ProcessBusHub hub = new ProcessBusHub(0);
        CountDownLatch joined = new CountDownLatch(1);
        hub.onRosterChange(joined::countDown);
        NodeCard card = new NodeCard("node-r", "worker", List.of(), TOPIC);
        try (ProcessBus node = new ProcessBus("127.0.0.1", hub.port(), "node-r", 1024, card)) {
            CountDownLatch disconnects = new CountDownLatch(2); // at least twice
            node.onDisconnect(disconnects::countDown);
            assertTrue(joined.await(5, TimeUnit.SECONDS), "the node established a connection");
            hub.close(); // stays dead: every reconnect attempt refuses fast

            assertTrue(disconnects.await(5, TimeUnit.SECONDS),
                    "onDisconnect fires each down cycle while the link stays down, not once");
        }
    }

    @Test
    void aStopVerbStillReachesOnControlNotOnGate() throws Exception {
        // The frozen stop path: callId==null dispatches to onControl, never
        // onGate. Adding the gate channel must not steal a plain verb.
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            NodeCard card = new NodeCard("node-x", "worker", List.of(), TOPIC);
            CountDownLatch joined = new CountDownLatch(1);
            hub.onRosterChange(joined::countDown);
            try (ProcessBus node = new ProcessBus("127.0.0.1", hub.port(), "node-x", 1024, card)) {
                BlockingQueue<String> control = new LinkedBlockingQueue<>();
                BlockingQueue<String> gate = new LinkedBlockingQueue<>();
                node.onControl(control::add);
                node.onGate((callId, allow) -> gate.add("gate"));

                assertTrue(joined.await(5, TimeUnit.SECONDS), "the node registered");
                hub.control("node-x", "stop");

                assertEquals("stop", control.poll(5, TimeUnit.SECONDS), "stop reached onControl");
                assertNull(gate.poll(300, TimeUnit.MILLISECONDS),
                        "onGate stayed silent for a plain verb");
            }
        }
    }
}
