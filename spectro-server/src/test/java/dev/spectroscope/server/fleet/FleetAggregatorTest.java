package dev.spectroscope.server.fleet;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.orchestrator.BusEnvelope;
import dev.spectroscope.orchestrator.BusPublisher;
import dev.spectroscope.orchestrator.HubSettings;
import dev.spectroscope.orchestrator.NodeCard;
import dev.spectroscope.orchestrator.ProcessBus;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.support.PropertySourcesPlaceholderConfigurer;
import org.springframework.mock.env.MockEnvironment;

import java.net.InetAddress;
import java.net.InetSocketAddress;
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
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The aggregator's pure-ish mechanics against a real loopback hub: opt-in
 * parsing (default OFF, card 585: never a port under 1024, never a dead boot), the
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

    /** A loopback listener on an OS-assigned port, the way another program holds one. */
    private static ServerSocket hold() throws Exception {
        ServerSocket held = new ServerSocket();
        held.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0));
        return held;
    }

    @Test
    void theHubIsOptInAndAnExplicitFalseWins() {
        try (FleetAggregator off = new FleetAggregator("")) {
            assertFalse(off.enabled(), "no port configured: no listener, no attack surface");
        }
        try (FleetAggregator off = new FleetAggregator("false", "0")) {
            assertFalse(off.enabled(), "SPECTRO_HUB_ENABLED=false wins over a port");
        }
        try (FleetAggregator on = new FleetAggregator("0")) {
            assertTrue(on.enabled());
            assertTrue(on.port() > 0, "port 0 binds an ephemeral loopback port");
        }
    }

    @Test
    void anAdminPortTurnsTheHubOnAtTheFirstFreePortFrom7700() {
        // Card 585, the owner's file: SPECTRO_HUB_PORT=1 and no switch. The
        // production constructor walks from 7700, never under 1024, never into
        // 8080 to 8100, and the boot goes on.
        try (FleetAggregator owner = new FleetAggregator("", "1")) {
            assertTrue(owner.enabled(), "SPECTRO_HUB_PORT=1 means a hub, not a dead app");
            assertTrue(owner.port() >= 7700, "picked " + owner.port());
            assertFalse(owner.port() >= 8080 && owner.port() <= 8100, "picked " + owner.port());
            assertEquals(HubSettings.Note.PORT_PRIVILEGED, owner.hubState().note());
        }
    }

    @Test
    void anInvalidPortNamesItselfAndThePortItTookInAWarn() throws Exception {
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(FleetAggregator.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try (ServerSocket held = hold();
             FleetAggregator invalid = new FleetAggregator("", "not-a-port", held.getLocalPort())) {
            assertTrue(invalid.enabled(), "an unreadable port picks a free one");
            assertTrue(invalid.port() > held.getLocalPort());
            assertTrue(appender.list.stream().anyMatch(event ->
                            event.getLevel() == Level.WARN
                                    && event.getFormattedMessage().contains("not-a-port")
                                    && event.getFormattedMessage().contains(String.valueOf(invalid.port()))),
                    "the WARN names the written value and the port the hub took");
        } finally {
            logger.detachAppender(appender);
        }
    }

    @Test
    void anOutOfRangePortIsNeitherABootCrashNorBound() throws Exception {
        try (ServerSocket held = hold();
             FleetAggregator huge = new FleetAggregator("", "70000", held.getLocalPort())) {
            assertTrue(huge.enabled());
            assertEquals(HubSettings.Note.PORT_INVALID, huge.hubState().note());
        }
    }

    @Test
    void aPortHeldByAnotherSocketLeavesTheHubOffAndTheBeanAlive() throws Exception {
        // Card 585 replaces the old rule "a bind failure fails the boot": the
        // owner's app must start, with the hub off and the reason in the log.
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(FleetAggregator.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try (ServerSocket held = hold()) {
            int occupied = held.getLocalPort();
            try (FleetAggregator aggregator = new FleetAggregator("true", String.valueOf(occupied))) {
                assertFalse(aggregator.enabled(), "the hub stays off");
                assertEquals(-1, aggregator.port());
                assertEquals(HubSettings.Note.BIND_FAILED, aggregator.hubState().note());
                assertTrue(appender.list.stream().anyMatch(event ->
                                event.getLevel() == Level.WARN
                                        && event.getFormattedMessage().contains(String.valueOf(occupied))
                                        && event.getFormattedMessage().contains(aggregator.hubState().reason())),
                        "the WARN names the port and the reason");
            }
        } finally {
            logger.detachAppender(appender);
        }
    }

    @Test
    void aPlaceholderInAHubValueLeavesTheHubOffAndTheBeanAlive() {
        // Review D6: "${nope}" in either value used to throw at bean creation
        // and fail the boot. The strict placeholder configurer is the one
        // Spring Boot registers.
        for (String name : List.of("SPECTRO_HUB_ENABLED", "SPECTRO_HUB_PORT")) {
            MockEnvironment env = new MockEnvironment();
            env.setProperty(name, "${nope}");
            try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext()) {
                context.setEnvironment(env);
                context.register(PropertySourcesPlaceholderConfigurer.class, FleetAggregator.class);
                context.refresh();
                FleetAggregator fleet = context.getBean(FleetAggregator.class);
                assertFalse(fleet.enabled(), name);
                assertEquals(HubSettings.Note.SETTING_UNREADABLE, fleet.hubState().note(), name);
                assertTrue(fleet.hubState().describe().contains(name), fleet.hubState().describe());
                fleet.close();
            }
        }
    }

    @Test
    void theServersOwnPortIsNeverTheHubsPort() throws Exception {
        // Review D1: a hub on the server's port took it before Tomcat did.
        int serverPort;
        try (ServerSocket probe = hold()) {
            serverPort = probe.getLocalPort();
        }
        try (ServerSocket held = hold();
             FleetAggregator fleet = new FleetAggregator("true", String.valueOf(serverPort),
                     held.getLocalPort(), serverPort)) {
            assertTrue(fleet.enabled());
            assertNotEquals(serverPort, fleet.port());
            assertEquals(HubSettings.Note.PORT_SERVER, fleet.hubState().note());
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

    @Test
    void controlGateIsDisabledWhenTheHubIsOff() {
        try (FleetAggregator off = new FleetAggregator("")) {
            assertEquals(FleetAggregator.ControlResult.DISABLED, off.controlGate("node-x", "c1", true),
                    "no hub, no gate to answer");
        }
    }

    @Test
    void controlGateDispatchesTheAnswerToAConnectedNodeAndReportsUnknownForAGhost() throws Exception {
        // Block 4: answering a parked permission gate mirrors control() exactly —
        // same best-effort ControlResult mapping, but the answer rides the gate
        // channel (callId + verdict) to the node's onGate seam.
        try (FleetAggregator aggregator = new FleetAggregator("0")) {
            assertEquals(FleetAggregator.ControlResult.UNKNOWN,
                    aggregator.controlGate("node-g", "c1", true),
                    "a node that never joined cannot be answered");

            CountDownLatch connected = new CountDownLatch(1);
            aggregator.addListener(new FleetAggregator.Listener() {
                @Override
                public void onRoster(List<FleetAggregator.NodeState> roster) {
                    if (roster.stream().anyMatch(s -> s.card().id().equals("node-g") && s.connected())) {
                        connected.countDown();
                    }
                }

                @Override
                public void onFleetEvent(BusEnvelope envelope) {
                }
            });

            NodeCard card = new NodeCard("node-g", "worker", List.of(), TOPIC);
            try (ProcessBus node = new ProcessBus("127.0.0.1", aggregator.port(), "node-g", 1024, card)) {
                BlockingQueue<String> gates = new LinkedBlockingQueue<>();
                node.onGate((callId, allow) -> gates.add(callId + "=" + allow));
                assertTrue(connected.await(10, TimeUnit.SECONDS), "the node joined the fold");

                assertEquals(FleetAggregator.ControlResult.DISPATCHED,
                        aggregator.controlGate("node-g", "call-9", true),
                        "a connected node's gate answer is dispatched over the hub");
                assertEquals("call-9=true", gates.poll(10, TimeUnit.SECONDS),
                        "the answer reached the node's onGate seam with its callId and verdict");
            }
        }
    }
}
