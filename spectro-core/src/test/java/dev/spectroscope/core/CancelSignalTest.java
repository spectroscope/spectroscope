package dev.spectroscope.core;

import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The deregistration handle keeps per-call listeners (a tool killing its child
 * process) from piling up on the run-scoped signal over a long run.
 */
class CancelSignalTest {

    @Test
    void aDeregisteredListenerDoesNotFire() {
        CancelSignal signal = new CancelSignal();
        AtomicInteger fired = new AtomicInteger();
        Runnable deregister = signal.onCancel(fired::incrementAndGet);
        deregister.run();
        signal.cancel();
        assertEquals(0, fired.get(), "a deregistered listener must not fire");
    }

    @Test
    void registrationAfterCancelFiresImmediatelyAndReturnsANoopHandle() {
        CancelSignal signal = new CancelSignal();
        signal.cancel();
        AtomicInteger fired = new AtomicInteger();
        Runnable deregister = signal.onCancel(fired::incrementAndGet);
        assertEquals(1, fired.get());
        deregister.run(); // must not throw
    }

    @Test
    void survivingListenersStillFire() {
        CancelSignal signal = new CancelSignal();
        AtomicInteger fired = new AtomicInteger();
        signal.onCancel(fired::incrementAndGet);
        signal.cancel();
        assertEquals(1, fired.get());
    }
}
