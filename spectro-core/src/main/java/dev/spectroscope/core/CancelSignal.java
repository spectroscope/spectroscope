package dev.spectroscope.core;

import java.util.ArrayList;
import java.util.List;

/**
 * Cooperative cancellation, the Java counterpart of the TS AbortSignal. The agent loop
 * checks {@link #isCancelled()} at safe points; providers and tools honor it. Threading
 * this signal through both the LLM stream and running tools is what makes Ctrl+C end a
 * run with {@code run_end {stopReason: "aborted"}} instead of a crash.
 */
public final class CancelSignal {

    private volatile boolean cancelled = false;
    private final List<Runnable> listeners = new ArrayList<>();

    /**
     * Flips the signal and fires every registered listener exactly once — repeat calls
     * are no-ops. Listeners run synchronously on the cancelling thread.
     */
    public synchronized void cancel() {
        if (cancelled) {
            return; // idempotent
        }
        cancelled = true;
        // Copy the listener list so a listener that registers another one cannot break us.
        for (Runnable listener : new ArrayList<>(listeners)) {
            listener.run();
        }
    }

    /** The poll side of the contract — checked by the loop, providers and tools at safe points.
     *  @return true once {@link #cancel()} has been called */
    public boolean isCancelled() {
        return cancelled;
    }

    /**
     * Registers a listener; fires immediately if the signal is already cancelled.
     * Returns a deregistration handle: per-call listeners (a tool killing its
     * child process) drop themselves after completion, so the run-scoped list
     * does not grow with every tool call. Ignoring the handle keeps the old
     * register-for-the-run behavior.
     *
     * @param listener the callback to fire on cancellation — or immediately, see above
     * @return a handle that removes the listener again; a no-op when already cancelled
     */
    public synchronized Runnable onCancel(Runnable listener) {
        if (cancelled) {
            listener.run();
            return () -> { };
        }
        listeners.add(listener);
        return () -> deregister(listener);
    }

    /** Removes a listener again — the implementation behind the {@link #onCancel} handle.
     *  @param listener the exact instance to drop from the run-scoped list */
    private synchronized void deregister(Runnable listener) {
        listeners.remove(listener);
    }
}
