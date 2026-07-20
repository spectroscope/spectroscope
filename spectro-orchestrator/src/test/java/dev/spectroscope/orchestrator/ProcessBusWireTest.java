package dev.spectroscope.orchestrator;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The ProcessBus over real loopback sockets (card 22): envelopes cross the
 * wire in per-sender order, late subscribers heal from the ring, dropped
 * connections reconnect without loss or duplicates, evicted history is
 * announced loudly, and one broken consumer never starves its neighbour.
 * Latches only — a sleep as synchronization would be the flake we promised
 * not to write.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class ProcessBusWireTest {

    private static final String CTX = "ctx-1";
    private static final String TOPIC = BusEnvelope.topicFor(CTX);

    private static RunEvent delta(String text) {
        return new RunEvent.TextDelta("main", text, 42L);
    }

    /** A latch-counting collector — the only synchronization the tests use. */
    private static final class Collector implements Consumer<BusEnvelope> {
        final List<BusEnvelope> seen = Collections.synchronizedList(new ArrayList<>());
        private volatile CountDownLatch latch = new CountDownLatch(0);

        CountDownLatch expect(int frames) {
            latch = new CountDownLatch(frames);
            return latch;
        }

        @Override
        public void accept(BusEnvelope env) {
            seen.add(env);
            latch.countDown();
        }

        List<String> ids() {
            synchronized (seen) {
                return seen.stream().map(BusEnvelope::id).toList();
            }
        }

        List<Long> sequencesOf(String sender) {
            synchronized (seen) {
                return seen.stream().filter(env -> env.sender().equals(sender))
                        .map(BusEnvelope::sequence).toList();
            }
        }
    }

    @Test
    void envelopesCrossTheLoopbackWireInPerSenderOrder() throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0);
             ProcessBus subscriberSide = new ProcessBus("127.0.0.1", hub.port(), "sub-1");
             ProcessBus publisherSide = new ProcessBus("127.0.0.1", hub.port(), "pub-1")) {
            Collector collector = new Collector();
            CountDownLatch six = collector.expect(6);
            subscriberSide.subscribe(TOPIC, collector);

            BusPublisher nodeA = new BusPublisher(publisherSide, "node-a", CTX);
            BusPublisher nodeB = new BusPublisher(publisherSide, "node-b", CTX);
            for (int i = 0; i < 3; i++) {
                nodeA.onEvent(delta("a" + i));
                nodeB.onEvent(delta("b" + i));
            }

            assertTrue(six.await(10, TimeUnit.SECONDS), "six frames cross the wire");
            assertEquals(List.of(0L, 1L, 2L), collector.sequencesOf("node-a"));
            assertEquals(List.of(0L, 1L, 2L), collector.sequencesOf("node-b"));
            BusEnvelope first = collector.seen.stream()
                    .filter(env -> env.id().equals("node-a#0")).findFirst().orElseThrow();
            assertEquals(delta("a0"), first.payload(), "the payload rides verbatim");
        }
    }

    @Test
    void aLateSubscriberReplaysTheRing() throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0);
             ProcessBus publisherSide = new ProcessBus("127.0.0.1", hub.port(), "pub-1");
             ProcessBus lateSide = new ProcessBus("127.0.0.1", hub.port(), "late-1")) {
            // An early witness proves the hub has processed all three frames
            // BEFORE the late subscriber arrives — no sleep, no guessing.
            Collector witness = new Collector();
            CountDownLatch three = witness.expect(3);
            try (ProcessBus witnessSide = new ProcessBus("127.0.0.1", hub.port(), "witness")) {
                witnessSide.subscribe(TOPIC, witness);
                BusPublisher nodeA = new BusPublisher(publisherSide, "node-a", CTX);
                for (int i = 0; i < 3; i++) {
                    nodeA.onEvent(delta("a" + i));
                }
                assertTrue(three.await(10, TimeUnit.SECONDS), "the hub holds all three");
            }

            Collector late = new Collector();
            CountDownLatch replay = late.expect(3);
            lateSide.subscribe(TOPIC, late);

            assertTrue(replay.await(10, TimeUnit.SECONDS), "the ring replays for latecomers");
            assertEquals(List.of("node-a#0", "node-a#1", "node-a#2"), late.ids());
        }
    }

    @Test
    void aDroppedSubscriberHealsFromTheRingWithoutLossOrDuplicates() throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0);
             ProcessBus subscriberSide = new ProcessBus("127.0.0.1", hub.port(), "sub-1");
             ProcessBus publisherSide = new ProcessBus("127.0.0.1", hub.port(), "pub-1")) {
            Collector collector = new Collector();
            CountDownLatch two = collector.expect(2);
            subscriberSide.subscribe(TOPIC, collector);
            BusPublisher nodeA = new BusPublisher(publisherSide, "node-a", CTX);
            nodeA.onEvent(delta("a0"));
            nodeA.onEvent(delta("a1"));
            assertTrue(two.await(10, TimeUnit.SECONDS));

            CountDownLatch twoMore = collector.expect(2);
            subscriberSide.dropConnectionForTest();
            nodeA.onEvent(delta("a2"));
            nodeA.onEvent(delta("a3"));

            assertTrue(twoMore.await(20, TimeUnit.SECONDS),
                    "the reconnect cursor resumes exactly where the drop cut");
            assertEquals(List.of("node-a#0", "node-a#1", "node-a#2", "node-a#3"),
                    collector.ids(), "no loss, no duplicates");
        }
    }

    @Test
    void aDroppedPublisherReflushesItsOutbox() throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0);
             ProcessBus subscriberSide = new ProcessBus("127.0.0.1", hub.port(), "sub-1");
             ProcessBus publisherSide = new ProcessBus("127.0.0.1", hub.port(), "pub-1")) {
            Collector collector = new Collector();
            CountDownLatch both = collector.expect(2);
            subscriberSide.subscribe(TOPIC, collector);

            publisherSide.dropConnectionForTest();
            BusPublisher nodeA = new BusPublisher(publisherSide, "node-a", CTX);
            nodeA.onEvent(delta("a0")); // lands in the outbox while disconnected
            nodeA.onEvent(delta("a1"));

            assertTrue(both.await(20, TimeUnit.SECONDS),
                    "the outbox reflushes on reconnect — a dead hub moment loses nothing");
            assertEquals(List.of("node-a#0", "node-a#1"), collector.ids());
        }
    }

    @Test
    void fallingBehindTheRingAnnouncesTheGapLoudly() throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0, 2);
             ProcessBus publisherSide = new ProcessBus("127.0.0.1", hub.port(), "pub-1");
             ProcessBus lateSide = new ProcessBus("127.0.0.1", hub.port(), "late-1")) {
            Collector witness = new Collector();
            CountDownLatch five = witness.expect(5);
            try (ProcessBus witnessSide = new ProcessBus("127.0.0.1", hub.port(), "witness")) {
                witnessSide.subscribe(TOPIC, witness);
                BusPublisher nodeA = new BusPublisher(publisherSide, "node-a", CTX);
                for (int i = 0; i < 5; i++) {
                    nodeA.onEvent(delta("a" + i));
                }
                assertTrue(five.await(10, TimeUnit.SECONDS));
            }

            List<BusGap> gaps = Collections.synchronizedList(new ArrayList<>());
            CountDownLatch gapHeard = new CountDownLatch(1);
            lateSide.onGap(gap -> {
                gaps.add(gap);
                gapHeard.countDown();
            });
            Collector late = new Collector();
            CountDownLatch survivors = late.expect(2);
            lateSide.subscribe(TOPIC, late);

            assertTrue(gapHeard.await(10, TimeUnit.SECONDS), "the eviction is announced");
            assertTrue(survivors.await(10, TimeUnit.SECONDS));
            assertEquals(List.of(new BusGap(TOPIC, "node-a", 0L, 2L)), gaps,
                    "the missing stretch is named precisely — trap 1 refused");
            assertEquals(List.of("node-a#3", "node-a#4"), late.ids());
        }
    }

    @Test
    void aThrowingConsumerIsIsolatedFromItsNeighbour() throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0);
             ProcessBus subscriberSide = new ProcessBus("127.0.0.1", hub.port(), "sub-1");
             ProcessBus publisherSide = new ProcessBus("127.0.0.1", hub.port(), "pub-1")) {
            Map<String, Integer> brokenCalls = new ConcurrentHashMap<>();
            subscriberSide.subscribe(TOPIC, env -> {
                brokenCalls.merge("calls", 1, Integer::sum);
                throw new IllegalStateException("consumer on fire");
            });
            Collector healthy = new Collector();
            CountDownLatch both = healthy.expect(2);
            subscriberSide.subscribe(TOPIC, healthy);

            BusPublisher nodeA = new BusPublisher(publisherSide, "node-a", CTX);
            nodeA.onEvent(delta("a0"));
            nodeA.onEvent(delta("a1"));

            assertTrue(both.await(10, TimeUnit.SECONDS),
                    "the healthy neighbour is never starved");
            assertEquals(2, brokenCalls.get("calls"),
                    "the broken consumer keeps being offered frames — it may recover");
        }
    }

    @Test
    void aPoisonLineKillsTheConnectionInsteadOfBeingSkippedOver() throws Exception {
        // A frame the hub cannot parse must NOT be logged-and-forgotten: the
        // next cumulative ack would trim it from the publisher's outbox — a
        // frame acked, never accepted, never announced. Killing the
        // connection keeps the loss loud and the outbox honest.
        try (ProcessBusHub hub = new ProcessBusHub(0);
             java.net.Socket raw = new java.net.Socket("127.0.0.1", hub.port())) {
            var out = new java.io.OutputStreamWriter(raw.getOutputStream(),
                    java.nio.charset.StandardCharsets.UTF_8);
            out.write("this is not a wire line\n");
            out.flush();

            assertEquals(-1, raw.getInputStream().read(),
                    "the hub closes a connection that speaks garbage");
        }
    }

    @Test
    void aThrowingGapHandlerDoesNotKillTheBus() throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0, 2);
             ProcessBus publisherSide = new ProcessBus("127.0.0.1", hub.port(), "pub-1");
             ProcessBus lateSide = new ProcessBus("127.0.0.1", hub.port(), "late-1")) {
            Collector witness = new Collector();
            CountDownLatch five = witness.expect(5);
            try (ProcessBus witnessSide = new ProcessBus("127.0.0.1", hub.port(), "witness")) {
                witnessSide.subscribe(TOPIC, witness);
                BusPublisher nodeA = new BusPublisher(publisherSide, "node-a", CTX);
                for (int i = 0; i < 5; i++) {
                    nodeA.onEvent(delta("a" + i));
                }
                assertTrue(five.await(10, TimeUnit.SECONDS));
            }

            lateSide.onGap(gap -> {
                throw new IllegalStateException("gap handler on fire");
            });
            Collector late = new Collector();
            CountDownLatch survivors = late.expect(2);
            lateSide.subscribe(TOPIC, late); // triggers the gap AND the replay

            assertTrue(survivors.await(10, TimeUnit.SECONDS),
                    "a broken gap handler must not cost the reader thread its life");

            // The connection is still alive: a LIVE frame arrives afterwards.
            CountDownLatch live = late.expect(1);
            new BusPublisher(publisherSide, "node-b", CTX).onEvent(delta("b0"));
            assertTrue(live.await(10, TimeUnit.SECONDS), "the bus outlives its gap handler");
        }
    }

    @Test
    void framesForAFullyUnsubscribedTopicDoNotEatTheReplayOfALaterConsumer() throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0);
             ProcessBus subscriberSide = new ProcessBus("127.0.0.1", hub.port(), "sub-1");
             ProcessBus publisherSide = new ProcessBus("127.0.0.1", hub.port(), "pub-1")) {
            Collector early = new Collector();
            CountDownLatch first = early.expect(1);
            AutoCloseable handle = subscriberSide.subscribe(TOPIC, early);
            BusPublisher nodeA = new BusPublisher(publisherSide, "node-a", CTX);
            nodeA.onEvent(delta("a0"));
            assertTrue(first.await(10, TimeUnit.SECONDS));
            handle.close();

            // Two frames arrive while NOBODY on this client consumes the topic.
            // They must not advance the client cursor — otherwise the next
            // consumer would silently start mid-stream although the ring still
            // holds everything.
            Collector witness = new Collector();
            CountDownLatch both = witness.expect(2);
            try (ProcessBus witnessSide = new ProcessBus("127.0.0.1", hub.port(), "witness")) {
                witnessSide.subscribe(TOPIC, witness);
                nodeA.onEvent(delta("a1"));
                nodeA.onEvent(delta("a2"));
                assertTrue(both.await(10, TimeUnit.SECONDS), "the hub processed both");
            }

            // One ProcessBus = one logical subscriber with ONE cursor: a0 was
            // consumed by the earlier consumer and stays consumed; a1/a2 were
            // delivered to NOBODY, so they must still be below the cursor and
            // replay now — that is exactly what the fix guarantees.
            Collector late = new Collector();
            CountDownLatch replay = late.expect(2);
            subscriberSide.subscribe(TOPIC, late);
            assertTrue(replay.await(10, TimeUnit.SECONDS),
                    "the frames nobody consumed replay for the later consumer");
            assertEquals(List.of("node-a#1", "node-a#2"), late.ids());
        }
    }

    @Test
    void localDeliveryNeverRunsOnThePublishersThread() throws Exception {
        // The deadlock refusal (review finding): a local consumer must not run
        // under the hub lock on the publishing thread — a consumer that blocks
        // (or publishes into a saturated colocated client) would freeze the
        // whole fleet otherwise.
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            List<Thread> deliveryThreads = Collections.synchronizedList(new ArrayList<>());
            CountDownLatch one = new CountDownLatch(1);
            hub.subscribe(TOPIC, env -> {
                deliveryThreads.add(Thread.currentThread());
                one.countDown();
            });

            new BusPublisher(hub, "node-l", CTX).onEvent(delta("local"));

            assertTrue(one.await(10, TimeUnit.SECONDS));
            assertNotEquals(Thread.currentThread(), deliveryThreads.get(0),
                    "local consumers ride their own drain thread, not the publisher's");
        }
    }

    @Test
    void theHubIsItselfATransport() throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0);
             ProcessBus remoteSide = new ProcessBus("127.0.0.1", hub.port(), "remote-1")) {
            Collector local = new Collector();
            CountDownLatch localGot = local.expect(1);
            hub.subscribe(TOPIC, local);
            Collector remote = new Collector();
            // Two frames reach the remote side: its own publish echoes back
            // (a topic subscriber hears everything) plus the hub-local one.
            CountDownLatch remoteGot = remote.expect(2);
            remoteSide.subscribe(TOPIC, remote);

            new BusPublisher(remoteSide, "node-r", CTX).onEvent(delta("from-remote"));
            assertTrue(localGot.await(10, TimeUnit.SECONDS),
                    "a local (aggregator) subscriber hears remote publishers");

            CountDownLatch localSecond = local.expect(1); // local delivery is async now
            new BusPublisher(hub, "node-l", CTX).onEvent(delta("from-local"));
            assertTrue(remoteGot.await(10, TimeUnit.SECONDS),
                    "a remote subscriber hears the hub's local publisher");
            assertTrue(localSecond.await(10, TimeUnit.SECONDS),
                    "the local drain delivers the local publish too");
            // A topic subscriber hears EVERYTHING on the topic, local included.
            assertEquals(List.of("node-r#0", "node-l#0"), local.ids());
            assertEquals(List.of("node-r#0", "node-l#0"), remote.ids());
        }
    }
}
