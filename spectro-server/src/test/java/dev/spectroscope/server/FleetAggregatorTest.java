package dev.spectroscope.server;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.orchestrator.BusEnvelope;
import dev.spectroscope.orchestrator.BusPublisher;
import dev.spectroscope.orchestrator.NodeCard;
import dev.spectroscope.orchestrator.ProcessBus;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.slf4j.LoggerFactory;

import java.io.UncheckedIOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The aggregator's pure-ish mechanics against a real loopback hub: opt-in
 * parsing (default OFF, invalid loud-but-off, bind failure fails the boot), the
 * roster fold (join/leave/last-seen, leave observed at the LISTENER not just the
 * fold), card-announced topics tapped automatically, and per-node ring replay.
 * Latches only — the wire suite's discipline.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class FleetAggregatorTest {

    private static final String CTX = "fleet-agg";
    private static final String TOPIC = BusEnvelope.topicFor(CTX);

    private static RunEvent delta(String text) {
        return new RunEvent.TextDelta("main", text, 42L);
    }

    @Test
    void theHubIsOptInAndAnInvalidPortIsLoudlyOff() {
        try (FleetAggregator off = new FleetAggregator("")) {
            assertFalse(off.enabled(), "no port configured — no listener, no attack surface");
        }
        try (FleetAggregator invalid = new FleetAggregator("not-a-port")) {
            assertFalse(invalid.enabled(), "an invalid port disables the hub");
        }
        try (FleetAggregator on = new FleetAggregator("0")) {
            assertTrue(on.enabled());
            assertTrue(on.port() > 0, "port 0 binds an ephemeral loopback port");
        }
    }

    @Test
    void anInvalidPortNamesItselfInAWarnNotASilentOff() {
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(FleetAggregator.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try (FleetAggregator invalid = new FleetAggregator("not-a-port")) {
            assertFalse(invalid.enabled());
            assertTrue(appender.list.stream().anyMatch(event ->
                            event.getLevel() == Level.WARN
                                    && event.getFormattedMessage().contains("not-a-port")),
                    "the typo names itself in a WARN — a silent off would hide the mistake");
        } finally {
            logger.detachAppender(appender);
        }
    }

    @Test
    void anOutOfRangePortIsLoudlyOffNotABootCrash() {
        try (FleetAggregator huge = new FleetAggregator("70000")) {
            assertFalse(huge.enabled(),
                    "a numeric-but-impossible port joins the typo bucket, not an IllegalArgumentException past boot");
        }
    }

    @Test
    void aBindFailureFailsTheBootInsteadOfSilentlyOff() throws Exception {
        // The operator explicitly asked for a hub — if the port cannot bind,
        // failing the boot is honest; a silently missing hub is the worse
        // surprise the code comment warns about.
        try (ServerSocket taken = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            int occupied = taken.getLocalPort();
            assertThrows(UncheckedIOException.class,
                    () -> new FleetAggregator(String.valueOf(occupied)),
                    "a hub that cannot bind fails the boot, never a quiet off");
        }
    }

    @Test
    void theRosterFoldsJoinsLeavesAndLastSeen() throws Exception {
        try (FleetAggregator aggregator = new FleetAggregator("0")) {
            CountDownLatch joined = new CountDownLatch(1);
            CountDownLatch leftFanout = new CountDownLatch(1);
            CountDownLatch eventSeen = new CountDownLatch(1);
            List<BusEnvelope> events = Collections.synchronizedList(new ArrayList<>());
            aggregator.addListener(new FleetAggregator.Listener() {
                @Override
                public void onRoster(List<FleetAggregator.NodeState> roster) {
                    if (roster.stream().anyMatch(FleetAggregator.NodeState::connected)) {
                        joined.countDown();
                    }
                    // The leave must reach the LISTENER, not only the fold: a
                    // departed node-a arriving as connected=false is the
                    // fan-out this pins (poll-only would miss a skipped leave).
                    if (roster.stream().anyMatch(state ->
                            state.card().id().equals("node-a") && !state.connected())) {
                        leftFanout.countDown();
                    }
                }

                @Override
                public void onFleetEvent(BusEnvelope envelope) {
                    events.add(envelope);
                    eventSeen.countDown();
                }
            });

            NodeCard card = new NodeCard("node-a", "worker", List.of("read_file"), TOPIC);
            long beforeJoin = System.currentTimeMillis();
            try (ProcessBus node = new ProcessBus("127.0.0.1", aggregator.port(),
                    "node-a", 1024, card)) {
                assertTrue(joined.await(10, TimeUnit.SECONDS), "the join reached the fold");
                new BusPublisher(node, "node-a", CTX).onEvent(delta("a0"));
                assertTrue(eventSeen.await(10, TimeUnit.SECONDS),
                        "the card-announced topic was tapped automatically");
                assertEquals("node-a#0#0", events.get(0).id());

                FleetAggregator.NodeState state = aggregator.snapshot().get(0);
                assertEquals(card, state.card());
                assertTrue(state.connected());
                assertTrue(state.lastSeen() >= beforeJoin, "last-seen is wall-clock recent");

                assertEquals(List.of("node-a#0#0"),
                        aggregator.replayFor("node-a").orElseThrow().frames().stream()
                                .map(BusEnvelope::id).toList(),
                        "per-node replay reads the ring, filtered to the node");
                assertFalse(aggregator.replayFor("node-a").orElseThrow().truncated(),
                        "nothing was evicted — a complete replay, not a truncated one");
                assertTrue(aggregator.replayFor("node-ghost").isEmpty(),
                        "an unknown node is absent, not an error");
            }

            // Departure: the entry survives as disconnected — an operator wants
            // to see who WAS here — AND the listener hears it, not just the fold.
            assertTrue(leftFanout.await(10, TimeUnit.SECONDS),
                    "the departure reaches the listener as connected=false");
            FleetAggregator.NodeState gone = aggregator.snapshot().get(0);
            assertEquals("node-a", gone.card().id());
            assertFalse(gone.connected(), "a departed node shows as disconnected, not vanished");
        }
    }

    @Test
    void controlIsDisabledWhenTheHubIsOff() {
        try (FleetAggregator off = new FleetAggregator("")) {
            assertEquals(FleetAggregator.ControlResult.DISABLED, off.control("node-x", "stop"),
                    "no hub, nothing to control");
        }
    }

    @Test
    void controlDispatchesToAConnectedNodeAndReportsUnknownForAGhost() throws Exception {
        try (FleetAggregator aggregator = new FleetAggregator("0")) {
            assertEquals(FleetAggregator.ControlResult.UNKNOWN, aggregator.control("node-c", "stop"),
                    "a node that never joined cannot be controlled");

            CountDownLatch connected = new CountDownLatch(1);
            aggregator.addListener(new FleetAggregator.Listener() {
                @Override
                public void onRoster(List<FleetAggregator.NodeState> roster) {
                    if (roster.stream().anyMatch(s -> s.card().id().equals("node-c") && s.connected())) {
                        connected.countDown();
                    }
                }

                @Override
                public void onFleetEvent(BusEnvelope envelope) {
                }
            });

            NodeCard card = new NodeCard("node-c", "worker", List.of(), TOPIC);
            try (ProcessBus node = new ProcessBus("127.0.0.1", aggregator.port(), "node-c", 1024, card)) {
                BlockingQueue<String> received = new LinkedBlockingQueue<>();
                node.onControl(received::add);
                assertTrue(connected.await(10, TimeUnit.SECONDS), "the node joined the fold");

                assertEquals(FleetAggregator.ControlResult.DISPATCHED, aggregator.control("node-c", "stop"),
                        "a connected node's verb is dispatched over the hub");
                assertEquals("stop", received.poll(10, TimeUnit.SECONDS),
                        "the verb reached the node's onControl seam");
            }
        }
    }
}
