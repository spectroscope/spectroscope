package dev.spectroscope.orchestrator;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
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
}
