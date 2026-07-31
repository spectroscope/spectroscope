package dev.spectroscope.cli;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The one monitor object of the trigger loop: capacity one, per-kind insert
 * semantics (fs coalesces, http and timer are refused when a fire is already
 * queued), stop wakes and discards. The hammer test pins the no-fire-lost
 * invariant under contention — part of the card's concurrency gate, run 3x.
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS)
class FireSlotTest {

    private static Fire fs(String entry) {
        return Fire.fs("watch:/drop", List.of(entry), 0, false);
    }

    @Test
    void anEmptySlotAcceptsAndTakeHandsTheFireBack() throws Exception {
        FireSlot slot = new FireSlot();
        assertEquals(FireSlot.Disposition.ACCEPTED, slot.offer(fs("created a.txt")));
        Fire taken = slot.take();
        assertEquals(List.of("created a.txt"), taken.entries());
    }

    @Test
    void aQueuedFsFireCoalescesWithTheNextFsFire() throws Exception {
        FireSlot slot = new FireSlot();
        assertEquals(FireSlot.Disposition.ACCEPTED, slot.offer(fs("created a.txt")));
        assertEquals(FireSlot.Disposition.COALESCED, slot.offer(fs("created b.txt")),
                "fs events are statements about current state — merging loses nothing");

        Fire merged = slot.take();
        assertEquals(List.of("created a.txt", "created b.txt"), merged.entries());
        assertEquals(1, merged.coalesced());
    }

    @Test
    void aQueuedFireRefusesHttpAndTimer() {
        FireSlot slot = new FireSlot();
        slot.offer(fs("created a.txt"));
        assertEquals(FireSlot.Disposition.REFUSED,
                slot.offer(Fire.http("listen:127.0.0.1:8300", "{\"x\":1}", "127.0.0.1")),
                "an HTTP payload is a distinct datum — 429 makes the caller the retry authority");
        assertEquals(FireSlot.Disposition.REFUSED, slot.offer(Fire.timer("every:5m")),
                "a timer tick during a busy slot is skipped, like cron overlap");
    }

    @Test
    void stopWakesABlockedTakeWithNullAndDiscardsTheQueuedFire() throws Exception {
        FireSlot slot = new FireSlot();
        AtomicReference<Fire> result = new AtomicReference<>(fs("sentinel"));
        CountDownLatch returned = new CountDownLatch(1);
        Thread taker = Thread.ofVirtual().start(() -> {
            try {
                result.set(slot.take());
                returned.countDown();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        });

        Thread.sleep(50); // the taker is parked in take()
        slot.stop();
        assertTrue(returned.await(5, TimeUnit.SECONDS), "stop wakes the parked take");
        assertNull(result.get(), "null is the stop signal");
        taker.join(5_000);

        // stop also discards: a queued fire before the stop never surfaces
        FireSlot second = new FireSlot();
        second.offer(fs("created late.txt"));
        second.stop();
        assertNull(second.take(), "the queued fire is discarded on stop");
        assertEquals(FireSlot.Disposition.REFUSED, second.offer(fs("created x.txt")),
                "a stopped slot accepts nothing more");
    }

    @Test
    void underContentionNoFireIsEverLost() throws Exception {
        // The accounting invariant: every offered fs fire is either taken
        // directly or folded into a taken fire's coalesced count. Producers
        // and the consumer race freely; sum(1 + coalesced) must equal offers.
        int producers = 4;
        int perProducer = 250;
        FireSlot slot = new FireSlot();
        CountDownLatch done = new CountDownLatch(producers);
        for (int p = 0; p < producers; p++) {
            int id = p;
            Thread.ofVirtual().start(() -> {
                for (int i = 0; i < perProducer; i++) {
                    slot.offer(fs("created f-" + id + "-" + i));
                }
                done.countDown();
            });
        }

        AtomicInteger accounted = new AtomicInteger();
        int total = producers * perProducer;
        while (accounted.get() < total) {
            Fire fire = slot.take();
            assertFalse(fire == null, "the slot was never stopped — take must not return null");
            accounted.addAndGet(1 + fire.coalesced());
        }
        assertTrue(done.await(5, TimeUnit.SECONDS));
        assertEquals(total, accounted.get(), "no fire lost, none invented");
    }
}
