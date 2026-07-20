package dev.spectroscope.orchestrator;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.trace.TracingPort;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The node-side decoupling (block-B review, the self-deadlock finding): the
 * run loop hands events to a bounded queue and NEVER blocks, a drain thread
 * feeds the real publisher, and when the bus stalls (dead hub, full outbox)
 * overflow is dropped LOUDLY — counted, warned — while the run and its JSONL
 * anchor continue untouched. Drops happen BEFORE the stamper, so the
 * on-wire sequence stays contiguous: no ghost holes, just an honest count.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class AsyncBusPortTest {

    private static RunEvent delta(String text) {
        return new RunEvent.TextDelta("main", text, 42L);
    }

    @Test
    void aStalledPublisherNeverBlocksTheCaller() throws Exception {
        // The downstream port parks forever (a dead hub's full outbox). The
        // caller must sail through capacity+N events without ever waiting.
        CountDownLatch parked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        TracingPort stalled = event -> {
            parked.countDown();
            try {
                release.await(20, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        };

        try (AsyncBusPort port = new AsyncBusPort(stalled, 4)) {
            assertTimelyForwarding(port, parked);
            for (int i = 0; i < 10; i++) {
                port.onEvent(delta("e" + i)); // first is in flight; 4 queue, 6 drop
            }
            assertEquals(6, port.dropped(), "overflow is counted, not hidden");
            release.countDown();
        }
    }

    private static void assertTimelyForwarding(AsyncBusPort port, CountDownLatch parked)
            throws InterruptedException {
        port.onEvent(delta("first"));
        assertTrue(parked.await(10, TimeUnit.SECONDS),
                "the drain thread forwards to the real publisher");
    }

    @Test
    void aHealthyPublisherSeesEveryEventInOrderAndCloseDrainsFirst() throws Exception {
        List<String> seen = Collections.synchronizedList(new ArrayList<>());
        TracingPort healthy = event -> seen.add(((RunEvent.TextDelta) event).text());

        AsyncBusPort port = new AsyncBusPort(healthy, 64);
        for (int i = 0; i < 20; i++) {
            port.onEvent(delta("e" + i));
        }
        port.close(); // must flush the queue before giving up

        assertEquals(20, seen.size(), "close drains the queue — nothing is stranded");
        assertEquals("e0", seen.get(0));
        assertEquals("e19", seen.get(19));
        assertEquals(0, port.dropped());
    }

    @Test
    void closeAgainstAStalledPublisherGivesUpLoudlyInsteadOfHanging() throws Exception {
        CountDownLatch parked = new CountDownLatch(1);
        AtomicInteger delivered = new AtomicInteger();
        TracingPort stalled = event -> {
            delivered.incrementAndGet();
            parked.countDown();
            try {
                Thread.sleep(60_000); // parks far beyond the close grace
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        };

        AsyncBusPort port = new AsyncBusPort(stalled, 4, 250);
        port.onEvent(delta("stuck"));
        assertTrue(parked.await(10, TimeUnit.SECONDS));
        port.onEvent(delta("queued"));

        long before = System.currentTimeMillis();
        port.close(); // bounded: must return despite the parked drain
        assertTrue(System.currentTimeMillis() - before < 10_000,
                "close is bounded by its grace, never by the stalled bus");
        assertEquals(1, delivered.get(), "the queued tail could not be delivered");
        assertTrue(port.stranded() >= 1, "the stranded tail is counted loudly");
    }
}
