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
 * No sockets, no threads, no timing: every guarantee is provable here.
 */
class HubCoreTest {

    private static final String TOPIC = "ctx-1.events";

    private static BusEnvelope env(String sender, long seq) {
        return new BusEnvelope(sender, "ctx-1", "ctx-1", seq,
                seq == 0 ? BusEnvelope.CHAIN_ROOT : sender + "#" + (seq - 1),
                TOPIC, 42L, new RunEvent.TextDelta("main", sender + "-" + seq, 42L));
    }

    @Test
    void aFreshFrameIsAcceptedAndADuplicateIsNot() {
        HubCore core = new HubCore(16);

        Optional<BusEnvelope> first = core.publish(env("node-a", 0));
        Optional<BusEnvelope> replayOfFirst = core.publish(env("node-a", 0));

        assertTrue(first.isPresent(), "fresh frames fan out");
        assertTrue(replayOfFirst.isEmpty(), "a redelivered frame is deduped, not re-fanned");
        assertEquals(0L, core.highWater(TOPIC, "node-a"));
    }

    @Test
    void aLateSubscriberReplaysEverythingAboveItsCursor() {
        HubCore core = new HubCore(16);
        for (long seq = 0; seq < 5; seq++) {
            core.publish(env("node-a", seq));
        }

        HubCore.Replay fresh = core.subscribe(TOPIC, Map.of());
        HubCore.Replay resumed = core.subscribe(TOPIC, Map.of("node-a", 2L));

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

        assertEquals(List.of("node-a#0", "node-b#0", "node-a#1", "node-b#1"), ids,
                "arrival order is kept; per-sender order is ascending inside it");
    }

    @Test
    void theRingIsBoundedAndFallingBehindItYieldsALoudGap() {
        HubCore core = new HubCore(3); // tiny on purpose: seqs 0..4 leave only 2,3,4
        for (long seq = 0; seq < 5; seq++) {
            core.publish(env("node-a", seq));
        }

        HubCore.Replay behind = core.subscribe(TOPIC, Map.of("node-a", 0L));

        assertEquals(List.of(2L, 3L, 4L),
                behind.frames().stream().map(BusEnvelope::sequence).toList(),
                "the ring holds only the newest capacity frames");
        assertEquals(List.of(new BusGap(TOPIC, "node-a", 1L, 1L)), behind.gaps(),
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
        assertEquals(List.of(new BusGap(TOPIC, "node-a", 0L, 2L)), fresh.gaps(),
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
        assertEquals(-1L, core.highWater(TOPIC, "node-a"));
        assertTrue(core.publish(env("node-a", 0)).isPresent(),
                "after retirement the sender starts a fresh world");
    }

    @Test
    void topicsAreIsolatedRings() {
        HubCore core = new HubCore(16);
        core.publish(env("node-a", 0));
        BusEnvelope other = new BusEnvelope("node-a", "ctx-2", "ctx-2", 0,
                BusEnvelope.CHAIN_ROOT, "ctx-2.events", 42L,
                new RunEvent.TextDelta("main", "other", 42L));
        core.publish(other);

        assertEquals(1, core.subscribe(TOPIC, Map.of()).frames().size());
        assertEquals(1, core.subscribe("ctx-2.events", Map.of()).frames().size());
        assertEquals(0L, core.highWater(TOPIC, "node-a"));
        assertEquals(0L, core.highWater("ctx-2.events", "node-a"));
    }
}
