package dev.spectroscope.orchestrator;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The client's pure state machine (card 22): a bounded outbox that survives
 * a dead hub (resend on reconnect, trim on cumulative ack) and a per-sender
 * cursor that makes redelivery invisible to the consumer — at-least-once on
 * the wire, exactly-once at the consumer. Since card 25 both are scoped per
 * (sender, epoch): a restarted sender's fresh stream reaches the consumer.
 */
class ClientCoreTest {

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
    void theConsumerSeesEachFrameOnceEvenWhenTheWireRedelivers() {
        ClientCore core = new ClientCore(16);

        assertTrue(core.accept(env("node-a", 0)));
        assertTrue(core.accept(env("node-a", 1)));
        assertFalse(core.accept(env("node-a", 1)), "redelivery is invisible to the consumer");
        assertFalse(core.accept(env("node-a", 0)), "so is an older duplicate");
        assertTrue(core.accept(env("node-b", 0)), "senders dedup independently");

        assertEquals(Map.of("node-a", Map.of(0L, 1L), "node-b", Map.of(0L, 0L)),
                core.cursor(TOPIC),
                "the cursor is exactly what a re-subscribe sends, per incarnation");
    }

    @Test
    void aRestartedSendersNewEpochReachesTheConsumer() {
        // The consumer-side half of the card-22 limit: a restarted sender's
        // sequence starts at 0 again — without the epoch in the dedup key the
        // whole fresh stream would be invisible.
        ClientCore core = new ClientCore(16);
        assertTrue(core.accept(env("node-a", 1L, 0)));
        assertTrue(core.accept(env("node-a", 1L, 1)));

        assertTrue(core.accept(env("node-a", 2L, 0)),
                "the new incarnation's first frame reaches the consumer");
        assertFalse(core.accept(env("node-a", 1L, 1)),
                "the old incarnation still dedups");
        assertFalse(core.accept(env("node-a", 2L, 0)),
                "the new incarnation dedups within itself");

        assertEquals(Map.of("node-a", Map.of(1L, 1L, 2L, 0L)), core.cursor(TOPIC),
                "the cursor carries every incarnation it consumed");
    }

    @Test
    void aGapAdvancesTheCursorSoAResubscribeStartsPastTheLoss() {
        // Card-25 review finding #5: an announced gap IS consumed history —
        // the hub already evicted that stretch, so no resume can ever deliver
        // it. A cursor left below the loss re-earns the same gap on every
        // reconnect: one eviction, announced forever.
        ClientCore core = new ClientCore(16);
        core.noteGap(TOPIC, "node-a", 0L, 4L);

        assertEquals(Map.of("node-a", Map.of(0L, 4L)), core.cursor(TOPIC),
                "the resume cursor starts after the announced loss");
        assertTrue(core.accept(env("node-a", 0L, 5)),
                "the first frame after the gap reaches the consumer");
        assertFalse(core.accept(env("node-a", 0L, 4)),
                "a straggler from inside the announced stretch does not");
    }

    @Test
    void aStaleGapNeverMovesTheCursorBackwards() {
        ClientCore core = new ClientCore(16);
        assertTrue(core.accept(env("node-a", 0L, 7)));

        core.noteGap(TOPIC, "node-a", 0L, 4L); // stale — consumption is past it

        assertEquals(Map.of("node-a", Map.of(0L, 7L)), core.cursor(TOPIC),
                "an old gap must not resurrect consumed history for redelivery");
    }

    @Test
    void theOutboxSurvivesUntilTheCumulativeAck() {
        ClientCore core = new ClientCore(16);
        core.record(env("node-a", 0));
        core.record(env("node-a", 1));
        core.record(env("node-a", 2));

        core.ack(TOPIC, "node-a", 0L, 1L); // cumulative: 0 and 1 are safe at the hub

        assertEquals(List.of(2L),
                core.unacked().stream().map(BusEnvelope::sequence).toList(),
                "everything above the ack waits for the next reconnect flush");
    }

    @Test
    void anAckOnlyTrimsItsOwnEpoch() {
        // A hub that confirmed the OLD incarnation's frames must not trim the
        // NEW incarnation's outbox — sequences overlap across restarts.
        ClientCore core = new ClientCore(16);
        core.record(env("node-a", 1L, 0));
        BusEnvelope freshIncarnation = env("node-a", 2L, 0);
        core.record(freshIncarnation);

        core.ack(TOPIC, "node-a", 1L, 5L); // generous, but for epoch 1 only

        assertEquals(List.of(freshIncarnation), core.unacked(),
                "the new incarnation's frame survives — the hub never confirmed it");
    }

    @Test
    void anAckNeverTrimsASameNamedSenderOnAnotherTopic() {
        // Sequences restart at 0 per context (the stamper's law), so the same
        // sender name across two fleet runs is the NORMAL case on a shared
        // bus — an ack that ignored the topic would void at-least-once.
        ClientCore core = new ClientCore(16);
        core.record(env("node-a", 0)); // ctx-1
        BusEnvelope otherRun = new BusEnvelope("node-a", 0L, "ctx-2", "ctx-2", 0,
                BusEnvelope.CHAIN_ROOT, "ctx-2.events", 42L,
                new RunEvent.TextDelta("main", "other-run", 42L));
        core.record(otherRun);

        core.ack(TOPIC, "node-a", 0L, 5L); // ctx-1's ack, generous high-water

        assertEquals(List.of(otherRun), core.unacked(),
                "the other run's frame survives — the hub never confirmed it");
    }

    @Test
    void aFullOutboxRefusesLoudlyInsteadOfDroppingSilently() {
        ClientCore core = new ClientCore(2);
        core.record(env("node-a", 0));
        core.record(env("node-a", 1));

        assertThrows(IllegalStateException.class, () -> core.record(env("node-a", 2)),
                "the shell turns this into publisher backpressure — never a silent drop");
        assertEquals(2, core.unacked().size());
    }
}
