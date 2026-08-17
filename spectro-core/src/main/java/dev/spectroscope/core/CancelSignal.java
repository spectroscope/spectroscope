package dev.spectroscope.core;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;

/**
 * Cooperative cancellation, the Java counterpart of the TS AbortSignal. The agent loop
 * checks {@link #isCancelled()} at safe points; providers and tools honor it. Threading
 * this signal through both the LLM stream and running tools is what makes Ctrl+C end a
 * run with {@code run_end {stopReason: "aborted"}} instead of a crash.
 */
public final class CancelSignal {

    private static final Logger log = LoggerFactory.getLogger(CancelSignal.class);

    private volatile boolean cancelled = false;
    private volatile String reason;
    private final List<Runnable> listeners = new ArrayList<>();

    /**
     * Flips the signal and fires every registered listener exactly once — repeat calls
     * are no-ops. Listeners run synchronously on the cancelling thread. Cancel is a
     * best-effort broadcast: a listener that throws is logged and skipped, so one
     * broken close can neither starve the remaining listeners nor ride an exception
     * up the cancelling thread (which used to kill the WebSocket session, card 78).
     */
    public synchronized void cancel() {
        cancel(null);
    }

    /**
     * Cancels and says why, for a caller whose reason the loop cannot know.
     *
     * <p>Card 264: the headless turn brake stops a run from the outside, so the
     * loop could only ever write {@code aborted} while the caller's own
     * {@code Outcome} said {@code max_turns} — two truths for one event. The
     * reason travels with the signal so the run's record and the caller's
     * report are the same sentence. The first reason wins, exactly as the first
     * cancel does; a plain {@link #cancel()} (the stop button) carries none and
     * must not invent one.</p>
     *
     * @param why the wire name to record instead of {@code aborted}, or null
     */
    public synchronized void cancel(String why) {
        if (cancelled) {
            return; // idempotent, and so is the reason
        }
        cancelled = true;
        reason = why;
        // Copy the listener list so a listener that registers another one cannot break us.
        for (Runnable listener : new ArrayList<>(listeners)) {
            fireIsolated(listener);
        }
    }

    /** Runs one listener, exception-isolated — the full trace goes to the log
     *  (the card-78 hunt started from a swallowed NoSuchElementException). */
    private static void fireIsolated(Runnable listener) {
        try {
            listener.run();
        } catch (RuntimeException failure) {
            log.warn("cancel listener failed (ignored)", failure);
        }
    }

    /** The poll side of the contract — checked by the loop, providers and tools at safe points.
     *  @return true once {@link #cancel()} has been called */
    public boolean isCancelled() {
        return cancelled;
    }

    /** Why this signal fired, when the canceller named it.
     *  @return the reason passed to {@link #cancel(String)}, or null for a plain stop */
    public String reason() {
        return reason;
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
            // The immediate fire is isolated exactly like the broadcast — a
            // register-after-cancel (e.g. a fresh provider stream opened while
            // stop was already pressed) must not throw into the registrant.
            fireIsolated(listener);
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
