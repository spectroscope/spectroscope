package dev.spectroscope.orchestrator;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The local-subscriber drop bookkeeping, pure (card 25 review): a gap must
 * name ONLY frames that were actually dropped. The old single-range
 * bookkeeping blindly extended its upper bound, so a frame that slipped into
 * a freed queue slot between two drops was announced as lost AND delivered —
 * a gap contradicting the stream. Sub-ranges keyed to the dropped sequences
 * are race-free by construction.
 */
class DropLedgerTest {

    private static final String TOPIC = "ctx-1.events";

    @Test
    void contiguousDropsCoalesceIntoOneGap() {
        DropLedger ledger = new DropLedger();
        ledger.record(TOPIC, "node-a", 0L, 5);
        ledger.record(TOPIC, "node-a", 0L, 6);
        ledger.record(TOPIC, "node-a", 0L, 7);

        assertEquals(List.of(new BusGap(TOPIC, "node-a", 0L, 5L, 7L)), ledger.drain());
        assertTrue(ledger.drain().isEmpty(), "drain empties the ledger");
    }

    @Test
    void aDeliveredFrameBetweenTwoDropsSplitsTheGap() {
        // seq 6 found a freed slot and WILL be delivered — the gap must not
        // swallow it. This is the exact race the single-range version lost.
        DropLedger ledger = new DropLedger();
        ledger.record(TOPIC, "node-a", 0L, 5);
        ledger.record(TOPIC, "node-a", 0L, 7);

        assertEquals(List.of(
                        new BusGap(TOPIC, "node-a", 0L, 5L, 5L),
                        new BusGap(TOPIC, "node-a", 0L, 7L, 7L)),
                ledger.drain(),
                "two stretches, and sequence 6 belongs to neither");
    }

    @Test
    void incarnationsKeepSeparateStretches() {
        DropLedger ledger = new DropLedger();
        ledger.record(TOPIC, "node-a", 1L, 3);
        ledger.record(TOPIC, "node-a", 2L, 0);
        ledger.record(TOPIC, "node-b", 0L, 9);

        assertEquals(List.of(
                        new BusGap(TOPIC, "node-a", 1L, 3L, 3L),
                        new BusGap(TOPIC, "node-a", 2L, 0L, 0L),
                        new BusGap(TOPIC, "node-b", 0L, 9L, 9L)),
                ledger.drain());
    }
}
