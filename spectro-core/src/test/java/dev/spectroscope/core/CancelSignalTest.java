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

    @Test
    void aThrowingListenerRegisteredAfterCancelDoesNotThrowIntoTheRegistrant() {
        // The immediate-fire path must be isolated like the broadcast: a fresh
        // provider stream opened while stop was already pressed registers its
        // close on a cancelled signal — a broken close must not ride up.
        CancelSignal signal = new CancelSignal();
        signal.cancel();
        Runnable handle = signal.onCancel(() -> {
            throw new IllegalStateException("broken close");
        }); // must not throw
        handle.run(); // and the no-op handle stays a no-op
    }

    @Test
    void aThrowingListenerBreaksNeitherTheCascadeNorTheCancellingThread() {
        // The live stop-button failure (card 78): a provider close listener threw
        // out of cancel(), the exception rode up the WebSocket handler and Spring
        // CLOSED the session. Cancel is a best-effort broadcast — one broken
        // listener must neither skip the remaining listeners nor hit the caller.
        CancelSignal signal = new CancelSignal();
        AtomicInteger survivorFired = new AtomicInteger();
        signal.onCancel(() -> {
            throw new IllegalStateException("broken close");
        });
        signal.onCancel(survivorFired::incrementAndGet);
        signal.cancel(); // must not throw
        assertEquals(1, survivorFired.get(), "the listener after the broken one must still fire");
    }
}
