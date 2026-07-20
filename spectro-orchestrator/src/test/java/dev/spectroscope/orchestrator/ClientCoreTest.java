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
 * the wire, exactly-once at the consumer.
 */
class ClientCoreTest {

    private static final String TOPIC = "ctx-1.events";

    private static BusEnvelope env(String sender, long seq) {
        return new BusEnvelope(sender, "ctx-1", "ctx-1", seq,
                seq == 0 ? BusEnvelope.CHAIN_ROOT : sender + "#" + (seq - 1),
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

        assertEquals(Map.of("node-a", 1L, "node-b", 0L), core.cursor(TOPIC),
                "the cursor is exactly what a re-subscribe sends");
    }

    @Test
    void theOutboxSurvivesUntilTheCumulativeAck() {
        ClientCore core = new ClientCore(16);
        core.record(env("node-a", 0));
        core.record(env("node-a", 1));
        core.record(env("node-a", 2));

        core.ack(TOPIC, "node-a", 1L); // cumulative: 0 and 1 are safe at the hub

        assertEquals(List.of(2L),
                core.unacked().stream().map(BusEnvelope::sequence).toList(),
                "everything above the ack waits for the next reconnect flush");
    }

    @Test
    void anAckNeverTrimsASameNamedSenderOnAnotherTopic() {
        // Sequences restart at 0 per context (the stamper's law), so the same
        // sender name across two fleet runs is the NORMAL case on a shared
        // bus — an ack that ignored the topic would void at-least-once.
        ClientCore core = new ClientCore(16);
        core.record(env("node-a", 0)); // ctx-1
        BusEnvelope otherRun = new BusEnvelope("node-a", "ctx-2", "ctx-2", 0,
                BusEnvelope.CHAIN_ROOT, "ctx-2.events", 42L,
                new RunEvent.TextDelta("main", "other-run", 42L));
        core.record(otherRun);

        core.ack(TOPIC, "node-a", 5L); // ctx-1's ack, generous high-water

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
