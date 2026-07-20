package dev.spectroscope.orchestrator;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The hub's pure heart (card 22): bounded replay ring, per-sender high-water
 * dedup, cursor-based replay, LOUD gaps when a cursor fell behind the ring
 * (KONZEPT §8 trap 1 — losing events silently is the one forbidden failure).
 * Since card 25 every guarantee is scoped per (sender, epoch): a restarted
 * sender is a new incarnation, not a redelivery.
 * No sockets, no threads, no timing: every guarantee is provable here.
 */
class HubCoreTest {

    private static final String TOPIC = "ctx-1.events";

    private static BusEnvelope env(String sender, long seq) {
        return env(sender, 0L, seq);
    }

    private static BusEnvelope env(String sender, long epoch, long seq) {
        return new BusEnvelope(sender, epoch, "ctx-1", "ctx-1", seq,
                seq == 0 ? BusEnvelope.CHAIN_ROOT : sender + "#" + epoch + "#" + (seq - 1),
                TOPIC, 42L, new RunEvent.TextDelta("main", sender + "-" + seq, 42L));
    }

    @Test
    void aFreshFrameIsAcceptedAndADuplicateIsNot() {
        HubCore core = new HubCore(16);

        Optional<BusEnvelope> first = core.publish(env("node-a", 0));
        Optional<BusEnvelope> replayOfFirst = core.publish(env("node-a", 0));

        assertTrue(first.isPresent(), "fresh frames fan out");
        assertTrue(replayOfFirst.isEmpty(), "a redelivered frame is deduped, not re-fanned");
        assertEquals(0L, core.highWater(TOPIC, "node-a", 0L));
    }

    @Test
    void aRestartedSenderWithAHigherEpochIsHeardNotDropped() {
        // The card-22 limit falls: before epochs, a restarted sender's fresh
        // frames (sequence restarting at 0) were classified as redelivery —
        // acked, fanned out to no one. An epoch is a new incarnation: its
        // stream is its own ordered, deduped world.
        HubCore core = new HubCore(16);
        for (long seq = 0; seq < 3; seq++) {
            assertTrue(core.publish(env("node-a", 1L, seq)).isPresent());
        }

        assertTrue(core.publish(env("node-a", 2L, 0)).isPresent(),
                "the restarted incarnation's first frame DELIVERS");
        assertTrue(core.publish(env("node-a", 2L, 1)).isPresent());
        assertTrue(core.publish(env("node-a", 1L, 1)).isEmpty(),
                "an old incarnation's retransmit still dedups");
        assertTrue(core.publish(env("node-a", 2L, 1)).isEmpty(),
                "the new incarnation dedups within itself too");

        assertEquals(2L, core.highWater(TOPIC, "node-a", 1L));
        assertEquals(1L, core.highWater(TOPIC, "node-a", 2L));
        assertEquals(List.of("node-a#1#0", "node-a#1#1", "node-a#1#2",
                        "node-a#2#0", "node-a#2#1"),
                core.subscribe(TOPIC, Map.of()).frames().stream()
                        .map(BusEnvelope::id).toList(),
                "both incarnations replay, in arrival order");
    }

    @Test
    void anOldEpochsFreshFrameStillDeliversAfterANewerEpochExists() {
        // Epoch is a qualifier, NOT a fence: a crashed process's still-flushing
        // frames arrive after its successor already published — dropping them
        // would be exactly the silent loss this bus refuses. Delivery policy
        // (what counts as "current") belongs to the roster, not the bus.
        HubCore core = new HubCore(16);
        assertTrue(core.publish(env("node-a", 2L, 0)).isPresent());

        assertTrue(core.publish(env("node-a", 1L, 0)).isPresent(),
                "the old incarnation's late frame DELIVERS — no fencing");
        assertEquals(0L, core.highWater(TOPIC, "node-a", 1L));
        assertEquals(0L, core.highWater(TOPIC, "node-a", 2L));
    }

    @Test
    void aRestartedSenderReusingItsEpochIsStillDeduped() {
        // The documented sharp edge of the epoch-0 convenience ctor: reuse the
        // SAME epoch across a restart in the SAME topic and the dedup line
        // cannot tell the fresh stream from redelivery. Contexts that die with
        // their process (panel lanes) never hit this; a real node stamps a
        // fresh epoch per process.
        HubCore core = new HubCore(16);
        for (long seq = 0; seq < 3; seq++) {
            core.publish(env("node-a", 0L, seq));
        }

        assertTrue(core.publish(env("node-a", 0L, 0)).isEmpty(),
                "same epoch + restarted sequence = indistinguishable from redelivery");
    }

    @Test
    void aSupersededFullyEvictedEpochIsForgottenNotGapFlooded() {
        // A crash-looping node must not grow the hub forever: once an old
        // incarnation is BOTH fully evicted from the ring AND superseded by a
        // newer one, its high-water line is retired. Late subscribers stop
        // hearing one gap per dead incarnation (the gap-storm livelock), and
        // the per-epoch maps stay bounded by what the ring still holds.
        HubCore core = new HubCore(2);
        core.publish(env("node-a", 1L, 0));
        core.publish(env("node-a", 1L, 1));
        core.publish(env("node-a", 2L, 0)); // evicts e1#0
        core.publish(env("node-a", 2L, 1)); // evicts e1#1 — e1 gone AND superseded

        assertEquals(-1L, core.highWater(TOPIC, "node-a", 1L),
                "the dead incarnation's line is retired");
        assertEquals(1L, core.highWater(TOPIC, "node-a", 2L),
                "the live incarnation keeps its dedup line");
        HubCore.Replay fresh = core.subscribe(TOPIC, Map.of());
        assertTrue(fresh.gaps().isEmpty(),
                "no gap storm for forgotten incarnations — the honesty horizon is the ring");
        assertEquals(List.of("node-a#2#0", "node-a#2#1"),
                fresh.frames().stream().map(BusEnvelope::id).toList());
        assertTrue(core.publish(env("node-a", 1L, 0)).isPresent(),
                "beyond the horizon, an old retransmit re-enters as at-least-once "
                        + "(consumers dedup per incarnation)");
    }

    @Test
    void theCurrentEpochIsNeverPrunedEvenWhenFullyEvicted() {
        // Pruning must not touch the newest incarnation: its dedup line is
        // what keeps a live node's retransmits from re-delivering.
        HubCore core = new HubCore(2);
        for (long seq = 0; seq < 5; seq++) {
            core.publish(env("node-a", 3L, seq)); // seqs 0..2 evicted
        }

        assertEquals(4L, core.highWater(TOPIC, "node-a", 3L));
        assertTrue(core.publish(env("node-a", 3L, 1)).isEmpty(),
                "the live incarnation's evicted frames still dedup");
        assertEquals(List.of(new BusGap(TOPIC, "node-a", 3L, 0L, 2L)),
                core.subscribe(TOPIC, Map.of()).gaps(),
                "and its evicted stretch is still announced");
    }

    @Test
    void replayAndGapsAreEpochScoped() {
        // Ring cap 3: epoch 1 published s0..s2, then epoch 2's first frame
        // evicts e1#0 — epoch 1 is PARTIALLY held, so it is not pruned and
        // its evicted stretch must be announced with ITS epoch.
        HubCore core = new HubCore(3);
        for (long seq = 0; seq < 3; seq++) {
            core.publish(env("node-a", 1L, seq));
        }
        core.publish(env("node-a", 2L, 0)); // evicts e1#0 only

        HubCore.Replay caughtUp = core.subscribe(TOPIC, Map.of("node-a", Map.of(1L, 2L)));

        assertEquals(List.of("node-a#2#0"),
                caughtUp.frames().stream().map(BusEnvelope::id).toList(),
                "only the unseen incarnation replays");
        assertTrue(caughtUp.gaps().isEmpty(),
                "a fully consumed old incarnation earns NO spurious gap");

        HubCore.Replay fresh = core.subscribe(TOPIC, Map.of());
        assertEquals(List.of(new BusGap(TOPIC, "node-a", 1L, 0L, 0L)), fresh.gaps(),
                "the evicted stretch is announced with its own epoch, loudly");
        assertEquals(List.of("node-a#1#1", "node-a#1#2", "node-a#2#0"),
                fresh.frames().stream().map(BusEnvelope::id).toList());
    }

    @Test
    void aLateSubscriberReplaysEverythingAboveItsCursor() {
        HubCore core = new HubCore(16);
        for (long seq = 0; seq < 5; seq++) {
            core.publish(env("node-a", seq));
        }

        HubCore.Replay fresh = core.subscribe(TOPIC, Map.of());
        HubCore.Replay resumed = core.subscribe(TOPIC, Map.of("node-a", Map.of(0L, 2L)));

        assertEquals(List.of(0L, 1L, 2L, 3L, 4L),
                fresh.frames().stream().map(BusEnvelope::sequence).toList(),
                "no cursor = the whole ring");
        assertEquals(List.of(3L, 4L),
                resumed.frames().stream().map(BusEnvelope::sequence).toList(),
                "a cursor resumes above its high-water");
        assertTrue(fresh.gaps().isEmpty());
        assertTrue(resumed.gaps().isEmpty());
    }

    @Test
    void replayInterleavesSendersInArrivalOrderPerSenderAscending() {
        HubCore core = new HubCore(16);
        core.publish(env("node-a", 0));
        core.publish(env("node-b", 0));
        core.publish(env("node-a", 1));
        core.publish(env("node-b", 1));

        List<String> ids = core.subscribe(TOPIC, Map.of()).frames().stream()
                .map(BusEnvelope::id).toList();

        assertEquals(List.of("node-a#0#0", "node-b#0#0", "node-a#0#1", "node-b#0#1"), ids,
                "arrival order is kept; per-sender order is ascending inside it");
    }

    @Test
    void theRingIsBoundedAndFallingBehindItYieldsALoudGap() {
        HubCore core = new HubCore(3); // tiny on purpose: seqs 0..4 leave only 2,3,4
        for (long seq = 0; seq < 5; seq++) {
            core.publish(env("node-a", seq));
        }

        HubCore.Replay behind = core.subscribe(TOPIC, Map.of("node-a", Map.of(0L, 0L)));

        assertEquals(List.of(2L, 3L, 4L),
                behind.frames().stream().map(BusEnvelope::sequence).toList(),
                "the ring holds only the newest capacity frames");
        assertEquals(List.of(new BusGap(TOPIC, "node-a", 0L, 1L, 1L)), behind.gaps(),
                "the evicted stretch is announced, never silently skipped");
    }

    @Test
    void aFreshSubscriberBehindAnEvictedRingStartHearsTheGapToo() {
        HubCore core = new HubCore(2);
        for (long seq = 0; seq < 5; seq++) {
            core.publish(env("node-a", seq));
        }

        HubCore.Replay fresh = core.subscribe(TOPIC, Map.of());

        assertEquals(List.of(3L, 4L),
                fresh.frames().stream().map(BusEnvelope::sequence).toList());
        assertEquals(List.of(new BusGap(TOPIC, "node-a", 0L, 0L, 2L)), fresh.gaps(),
                "even a no-cursor subscriber learns that history was evicted");
    }

    @Test
    void aRetiredTopicReleasesItsRingAndHighWater() {
        // The aggregator retires a fleet session's topic after run_end — a
        // long-lived hub must not pin every run's ring forever.
        HubCore core = new HubCore(16);
        core.publish(env("node-a", 0));
        core.publish(env("node-a", 1));

        core.retire(TOPIC);

        assertTrue(core.subscribe(TOPIC, Map.of()).frames().isEmpty(), "the ring is gone");
        assertTrue(core.subscribe(TOPIC, Map.of()).gaps().isEmpty(),
                "a retired topic is a forgotten world, not a gap");
        assertEquals(-1L, core.highWater(TOPIC, "node-a", 0L));
        assertTrue(core.publish(env("node-a", 0)).isPresent(),
                "after retirement the sender starts a fresh world");
    }

    @Test
    void topicsAreIsolatedRings() {
        HubCore core = new HubCore(16);
        core.publish(env("node-a", 0));
        BusEnvelope other = new BusEnvelope("node-a", 0L, "ctx-2", "ctx-2", 0,
                BusEnvelope.CHAIN_ROOT, "ctx-2.events", 42L,
                new RunEvent.TextDelta("main", "other", 42L));
        core.publish(other);

        assertEquals(1, core.subscribe(TOPIC, Map.of()).frames().size());
        assertEquals(1, core.subscribe("ctx-2.events", Map.of()).frames().size());
        assertEquals(0L, core.highWater(TOPIC, "node-a", 0L));
        assertEquals(0L, core.highWater("ctx-2.events", "node-a", 0L));
    }
}
