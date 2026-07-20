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
import java.util.concurrent.atomic.AtomicInteger;
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
                    .filter(env -> env.id().equals("node-a#0#0")).findFirst().orElseThrow();
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
            assertEquals(List.of("node-a#0#0", "node-a#0#1", "node-a#0#2"), late.ids());
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
            assertEquals(List.of("node-a#0#0", "node-a#0#1", "node-a#0#2", "node-a#0#3"),
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
            assertEquals(List.of("node-a#0#0", "node-a#0#1"), collector.ids());
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
            assertEquals(List.of(new BusGap(TOPIC, "node-a", 0L, 0L, 2L)), gaps,
                    "the missing stretch is named precisely — trap 1 refused");
            assertEquals(List.of("node-a#0#3", "node-a#0#4"), late.ids());
        }
    }

    @Test
    void aReconnectDoesNotReAnnounceAHealedGap() throws Exception {
        // Card-25 review finding #5, end to end: a sender whose ENTIRE
        // history was evicted never appears in the replay, so nothing but the
        // gap itself can move the cursor past the loss. Without that advance
        // the reconnect resends the same stale cursor and hears the same gap
        // again — one eviction, announced on every reconnect.
        try (ProcessBusHub hub = new ProcessBusHub(0, 2);
             ProcessBus publisherSide = new ProcessBus("127.0.0.1", hub.port(), "pub-1");
             ProcessBus lateSide = new ProcessBus("127.0.0.1", hub.port(), "late-1")) {
            BusPublisher nodeA = new BusPublisher(publisherSide, "node-a", CTX);
            BusPublisher nodeB = new BusPublisher(publisherSide, "node-b", CTX);
            Collector witness = new Collector();
            CountDownLatch three = witness.expect(3);
            try (ProcessBus witnessSide = new ProcessBus("127.0.0.1", hub.port(), "witness")) {
                witnessSide.subscribe(TOPIC, witness);
                nodeA.onEvent(delta("a0")); // ring cap 2: b0/b1 below evict this
                nodeB.onEvent(delta("b0"));
                nodeB.onEvent(delta("b1"));
                assertTrue(three.await(10, TimeUnit.SECONDS), "the hub saw all three");
            }

            List<BusGap> gaps = Collections.synchronizedList(new ArrayList<>());
            lateSide.onGap(gaps::add);
            Collector late = new Collector();
            CountDownLatch survivors = late.expect(2);
            lateSide.subscribe(TOPIC, late);
            assertTrue(survivors.await(10, TimeUnit.SECONDS), "the ring's survivors replay");

            CountDownLatch fresh = late.expect(1);
            lateSide.dropConnectionForTest();
            nodeB.onEvent(delta("b2"));

            assertTrue(fresh.await(20, TimeUnit.SECONDS),
                    "the reconnect resumes and delivers the new frame");
            assertEquals(List.of("node-b#0#0", "node-b#0#1", "node-b#0#2"), late.ids(),
                    "no loss, no duplicates across the reconnect");
            assertEquals(List.of(new BusGap(TOPIC, "node-a", 0L, 0L, 0L)), gaps,
                    "the loss is announced exactly once — the cursor advanced over it");
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
            assertEquals(List.of("node-a#0#1", "node-a#0#2"), late.ids());
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
            assertEquals(List.of("node-r#0#0", "node-l#0#0"), local.ids());
            assertEquals(List.of("node-r#0#0", "node-l#0#0"), remote.ids());
        }
    }

    @Test
    void aNodesCardRidesItsHelloIntoTheHubRoster() throws Exception {
        // Block-B decision: registration IS the connection — the card rides
        // the hello op, liveness is the connection state, no heartbeat
        // bookkeeping. Ops on one connection are processed in order, so a
        // delivered frame proves the hello (sent first) was handled.
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            NodeCard card = new NodeCard("node-a", "worker",
                    List.of("read_file", "run_command"), TOPIC);
            try (ProcessBus node = new ProcessBus("127.0.0.1", hub.port(), "node-a", 1024, card)) {
                Collector collector = new Collector();
                CountDownLatch one = collector.expect(1);
                hub.subscribe(TOPIC, collector);
                new BusPublisher(node, "node-a", CTX).onEvent(delta("a0"));
                assertTrue(one.await(10, TimeUnit.SECONDS), "the node's frame arrived");
                assertEquals(List.of(card), hub.roster(),
                        "the hello's card is live in the roster while the node is connected");
            }
            // Liveness = connection: after close the reader sees EOF and the
            // connection leaves the list. The teardown is asynchronous, so
            // poll bounded — this can only pass when the removal truly
            // happened, never spuriously.
            long deadline = System.currentTimeMillis() + 10_000;
            while (!hub.roster().isEmpty() && System.currentTimeMillis() < deadline) {
                Thread.sleep(10);
            }
            assertEquals(List.of(), hub.roster(), "a departed node leaves the roster");
        }
    }

    @Test
    void theRingReplaysAsAReadOnlySnapshot() throws Exception {
        // The aggregator's per-node replay (block C): a plain read of what
        // the ring still holds — no subscription, no cursor mutation, and a
        // second read sees the same world.
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            BusPublisher nodeA = new BusPublisher(hub, "node-a", CTX);
            Collector witness = new Collector();
            CountDownLatch three = witness.expect(3);
            hub.subscribe(TOPIC, witness);
            for (int i = 0; i < 3; i++) {
                nodeA.onEvent(delta("a" + i));
            }
            assertTrue(three.await(10, TimeUnit.SECONDS), "the hub holds all three");

            List<String> snapshot = hub.replay(TOPIC).frames().stream().map(BusEnvelope::id).toList();
            assertEquals(List.of("node-a#0#0", "node-a#0#1", "node-a#0#2"), snapshot);
            assertEquals(snapshot, hub.replay(TOPIC).frames().stream().map(BusEnvelope::id).toList(),
                    "reading is not consuming — the snapshot repeats");
            assertEquals(List.of(), hub.replay("unknown.topic").frames(),
                    "an unknown topic is an empty world, not an error");
            assertEquals(List.of(), hub.replay(TOPIC).gaps(),
                    "nothing was evicted — no gaps, a complete replay");
        }
    }

    @Test
    void aRosterChangeFiresOnJoinAndLeaveOffTheHubLock() throws Exception {
        // Block C: the aggregator wants a change signal, not a poll loop.
        // The listener is user code — it must fire off the hub lock, so a
        // slow listener can never freeze a concurrent publish. It must also
        // fire EXACTLY once per join and once per leave: the connections.remove
        // guard blocks the several cleanup paths (reader death, writer death,
        // hub close) from double-firing, and a plain latch cannot count a
        // surplus fire, so an AtomicInteger pins the exact tally.
        AtomicInteger fires = new AtomicInteger();
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            CountDownLatch joined = new CountDownLatch(1);
            CountDownLatch left = new CountDownLatch(2);
            CountDownLatch parked = new CountDownLatch(1);
            CountDownLatch release = new CountDownLatch(1);
            hub.onRosterChange(() -> {
                fires.incrementAndGet();
                joined.countDown();
                left.countDown();
                parked.countDown();
                try {
                    release.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            });

            NodeCard card = new NodeCard("node-a", "worker", List.of("read_file"), TOPIC);
            try (ProcessBus node = new ProcessBus("127.0.0.1", hub.port(), "node-a", 1024, card)) {
                assertTrue(parked.await(10, TimeUnit.SECONDS), "the join fired the listener");
                // With the listener parked, a publish must still get through —
                // proof the listener does not run under the hub lock.
                Collector collector = new Collector();
                CountDownLatch one = collector.expect(1);
                hub.subscribe(TOPIC, collector);
                new BusPublisher(hub, "node-l", CTX).onEvent(delta("l0"));
                assertTrue(one.await(10, TimeUnit.SECONDS),
                        "a parked roster listener never blocks the bus");
                release.countDown();
                assertTrue(joined.await(10, TimeUnit.SECONDS));
            }
            assertTrue(left.await(10, TimeUnit.SECONDS),
                    "the departure fires the listener too");
        }
        // The hub is closed now — its roster executor has drained, so the tally
        // is settled. Exactly one join and one leave, never a double-fire.
        assertEquals(2, fires.get(),
                "the roster listener fired exactly twice — one join, one leave, no double");
    }

    @Test
    void aSlowLocalSubscriberLosesLoudlyAndPrecisely() throws Exception {
        // The overflow path (card-25 review finding #11, deterministic since
        // the local queue became injectable): a blocked local consumer with a
        // full queue loses frames — announced as a gap naming EXACTLY the
        // dropped stretch, never the delivered neighbours.
        try (ProcessBusHub hub = new ProcessBusHub(0, 4096, 1)) {
            List<BusGap> gaps = Collections.synchronizedList(new ArrayList<>());
            CountDownLatch gapHeard = new CountDownLatch(1);
            hub.onGap(gap -> {
                gaps.add(gap);
                gapHeard.countDown();
            });

            CountDownLatch entered = new CountDownLatch(1);
            CountDownLatch release = new CountDownLatch(1);
            List<String> delivered = Collections.synchronizedList(new ArrayList<>());
            CountDownLatch both = new CountDownLatch(2);
            hub.subscribe(TOPIC, env -> {
                delivered.add(env.id());
                both.countDown();
                if (delivered.size() == 1) {
                    entered.countDown();
                    try {
                        release.await(10, TimeUnit.SECONDS);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                    }
                }
            });

            BusPublisher nodeA = new BusPublisher(hub, "node-a", CTX);
            nodeA.onEvent(delta("a0")); // taken by the drain, then held there
            assertTrue(entered.await(10, TimeUnit.SECONDS), "the consumer holds frame 0");
            nodeA.onEvent(delta("a1")); // fills the one-slot queue
            nodeA.onEvent(delta("a2")); // no room — dropped
            nodeA.onEvent(delta("a3")); // dropped too
            release.countDown();

            assertTrue(both.await(10, TimeUnit.SECONDS), "the queued frame still delivers");
            assertTrue(gapHeard.await(10, TimeUnit.SECONDS), "the loss is announced");
            assertEquals(List.of("node-a#0#0", "node-a#0#1"), delivered);
            assertEquals(List.of(new BusGap(TOPIC, "node-a", 0L, 2L, 3L)), gaps,
                    "the gap names the dropped stretch — frame 1 was delivered, not counted lost");
        }
    }

    @Test
    void subscribeGapsAreAnnouncedOffTheHubLock() throws Exception {
        // The no-user-code-under-the-lock rule applies to gap handlers too: a
        // handler that blocks during a local subscribe's replay must not hold
        // up a concurrent publish. Before the fix this test deadlocks — the
        // subscribe announced gaps while holding the hub lock.
        try (ProcessBusHub hub = new ProcessBusHub(0, 1)) {
            BusPublisher nodeA = new BusPublisher(hub, "node-a", CTX);
            nodeA.onEvent(delta("a0"));
            nodeA.onEvent(delta("a1")); // ring cap 1: a0 evicted → subscribe will gap

            CountDownLatch handlerEntered = new CountDownLatch(1);
            CountDownLatch release = new CountDownLatch(1);
            List<BusGap> gaps = Collections.synchronizedList(new ArrayList<>());
            hub.onGap(gap -> {
                gaps.add(gap);
                handlerEntered.countDown();
                try {
                    release.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            });

            Thread subscriber = Thread.ofVirtual().start(() ->
                    hub.subscribe(TOPIC, env -> { }));
            assertTrue(handlerEntered.await(10, TimeUnit.SECONDS),
                    "the subscribe reached its gap announcement");

            // With the handler parked, a publish must still get the lock.
            nodeA.onEvent(delta("a2"));
            release.countDown();
            subscriber.join(10_000);
            assertEquals(1, gaps.size());
            assertEquals("node-a", gaps.get(0).sender());
        }
    }

    @Test
    void acksCarryTheEpochSoARestartedNodesOutboxDrains() throws Exception {
        // The publisher blocks when its outbox is full and only the hub's
        // cumulative ack trims it. With a non-zero epoch, four publishes
        // through a two-slot outbox complete ONLY if the hub acks the right
        // (topic, sender, epoch) — a wrong-epoch ack would hang this test.
        try (ProcessBusHub hub = new ProcessBusHub(0);
             ProcessBus subscriberSide = new ProcessBus("127.0.0.1", hub.port(), "sub-1");
             ProcessBus publisherSide = new ProcessBus("127.0.0.1", hub.port(), "pub-1", 2)) {
            Collector collector = new Collector();
            CountDownLatch four = collector.expect(4);
            subscriberSide.subscribe(TOPIC, collector);

            BusPublisher nodeA = new BusPublisher(publisherSide, "node-a", CTX, 5L);
            for (int i = 0; i < 4; i++) {
                nodeA.onEvent(delta("a" + i)); // blocks past 2 until the epoch-5 ack trims
            }

            assertTrue(four.await(10, TimeUnit.SECONDS),
                    "all four frames flow — the acks named the right incarnation");
            assertEquals(List.of("node-a#5#0", "node-a#5#1", "node-a#5#2", "node-a#5#3"),
                    collector.ids());
        }
    }

    @Test
    void aRestartedPublisherWithAFreshEpochIsHeardNotDropped() throws Exception {
        // The card-22 limit falls, end to end: a node process dies and comes
        // back under the same sender id. Its new incarnation restarts the
        // sequence at 0 — before epochs the hub classified that as redelivery
        // and acked it into the void. With epochs, both incarnations deliver.
        try (ProcessBusHub hub = new ProcessBusHub(0);
             ProcessBus subscriberSide = new ProcessBus("127.0.0.1", hub.port(), "sub-1")) {
            Collector collector = new Collector();
            CountDownLatch firstLife = collector.expect(2);
            subscriberSide.subscribe(TOPIC, collector);

            ProcessBus firstProcess = new ProcessBus("127.0.0.1", hub.port(), "node-a-p1");
            BusPublisher firstIncarnation = new BusPublisher(firstProcess, "node-a", CTX, 1L);
            firstIncarnation.onEvent(delta("a0"));
            firstIncarnation.onEvent(delta("a1"));
            assertTrue(firstLife.await(10, TimeUnit.SECONDS), "the first life is heard");
            firstProcess.close(); // the crash-and-restart, as the wire sees it

            CountDownLatch secondLife = collector.expect(2);
            try (ProcessBus secondProcess = new ProcessBus("127.0.0.1", hub.port(), "node-a-p2")) {
                BusPublisher secondIncarnation =
                        new BusPublisher(secondProcess, "node-a", CTX, 2L);
                secondIncarnation.onEvent(delta("b0"));
                secondIncarnation.onEvent(delta("b1"));

                assertTrue(secondLife.await(10, TimeUnit.SECONDS),
                        "the restarted node's frames DELIVER — the card-22 limit fell");
            }
            assertEquals(List.of("node-a#1#0", "node-a#1#1", "node-a#2#0", "node-a#2#1"),
                    collector.ids(), "both incarnations, in order, exactly once");
        }
    }
}
