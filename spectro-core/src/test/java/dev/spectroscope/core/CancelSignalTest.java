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
    void aCancelCanCarryTheReasonItFired() {
        // Card 264, AC 6: an outside brake knows WHY it stopped the run and the
        // loop does not. Without a reason the loop can only write "aborted",
        // and the caller's own word for it ("max_turns") never reaches the wire.
        CancelSignal plain = new CancelSignal();
        plain.cancel();
        org.junit.jupiter.api.Assertions.assertNull(plain.reason(),
                "a stop button has no reason to give, and must not invent one");

        CancelSignal braked = new CancelSignal();
        braked.cancel("max_turns");
        org.junit.jupiter.api.Assertions.assertEquals("max_turns", braked.reason());
        org.junit.jupiter.api.Assertions.assertTrue(braked.isCancelled());
    }

    @Test
    void theFirstReasonKeepsTheRecord() {
        // cancel() is idempotent, so the reason is too: a stop pressed after the
        // brake fired must not rewrite what actually ended the run.
        CancelSignal signal = new CancelSignal();
        signal.cancel("max_turns");
        signal.cancel();
        signal.cancel("something else");
        org.junit.jupiter.api.Assertions.assertEquals("max_turns", signal.reason());
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
