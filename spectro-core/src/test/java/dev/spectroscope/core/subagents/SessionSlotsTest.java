package dev.spectroscope.core.subagents;

import dev.spectroscope.core.CancelSignal;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 490: the slot pool admits in ticket order, not in the order the
 * waiting threads happen to wake. The later ticket here starts waiting first,
 * so a pool that admitted whoever looks first would let it pass the earlier
 * one.
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionSlotsTest {

    @Test
    void theEarlierTicketGetsTheFreedSlotEvenWhenTheLaterOneWaitedLonger() throws Exception {
        SessionSlots slots = new SessionSlots();
        SessionCount two = SessionCount.of(2); // one helper at a time
        CancelSignal signal = new CancelSignal();
        SessionSlots.Ticket first = slots.enqueue();
        SessionSlots.Ticket second = slots.enqueue();
        SessionSlots.Ticket third = slots.enqueue();
        assertTrue(slots.acquire(first, () -> two, signal), "premise: the first ticket is admitted");
        assertTrue(slots.mustWait(third, two), "the third ticket must wait at one helper at a time");

        List<String> admitted = new CopyOnWriteArrayList<>();
        Thread late = Thread.ofVirtual().start(() -> {
            slots.acquire(third, () -> two, signal);
            admitted.add("third");
            slots.release();
        });
        Thread.sleep(200);
        Thread early = Thread.ofVirtual().start(() -> {
            slots.acquire(second, () -> two, signal);
            admitted.add("second");
            slots.release();
        });
        Thread.sleep(200);
        assertEquals(List.of(), admitted, "a helper was admitted while the only slot was held");

        slots.release();
        early.join(5_000);
        late.join(5_000);
        assertEquals(List.of("second", "third"), admitted, "the pool did not admit in ticket order");
        assertEquals(0, slots.running());
    }

    @Test
    void aCancelledRunDropsItsWaitingTicketSoItHoldsNobodyUp() throws Exception {
        SessionSlots slots = new SessionSlots();
        SessionCount two = SessionCount.of(2);
        CancelSignal running = new CancelSignal();
        CancelSignal cancelled = new CancelSignal();
        SessionSlots.Ticket holder = slots.enqueue();
        SessionSlots.Ticket abandoned = slots.enqueue();
        SessionSlots.Ticket next = slots.enqueue();
        assertTrue(slots.acquire(holder, () -> two, running));
        cancelled.cancel();
        assertFalse(slots.acquire(abandoned, () -> two, cancelled), "a cancelled wait reported a slot");
        slots.release();
        assertTrue(slots.acquire(next, () -> two, running),
                "the ticket behind a cancelled one never reached the head of the queue");
        assertEquals(1, slots.running());
    }
}
