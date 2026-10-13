package dev.spectroscope.core;

import java.util.function.Supplier;

/**
 * Lets a stop reach a thread that waits in a call only an interrupt can end
 * (card 557): an HTTP exchange that is still connecting or waits for response
 * headers, a wait on a future, a socket read. While the scope is open, a
 * cancel of the signal interrupts the thread that opened it.
 *
 * <p>Closing the scope removes the listener and clears the interrupt the
 * scope delivered, so the interrupt cannot reach code after the call: an
 * interrupted thread loses its next {@code put} onto the run's event queue
 * (and with it {@code run_end}), and a file channel written on an interrupted
 * thread closes and drops the line. Keep the scope around the waiting call
 * only, never around a write.</p>
 *
 * <p>What the interrupt ends depends on the call. Spring's JDK request
 * factory cancels the exchange's future, which aborts a connect in progress.
 * A blocking socket (OkHttp) is closed by an interrupt only on a virtual
 * thread, which is the thread every agent run has ({@link EventStream}).</p>
 */
public final class CancelInterrupt implements AutoCloseable {

    /** The scope for a call without a signal: nothing to listen to. */
    private static final CancelInterrupt NONE = new CancelInterrupt(null);

    private final Thread thread;
    private Runnable unhook = () -> { };
    private boolean open = true;
    private boolean fired;

    private CancelInterrupt(Thread thread) {
        this.thread = thread;
    }

    /**
     * Opens a scope on the calling thread. When the signal is already
     * cancelled the thread is interrupted at once, so the call that follows
     * fails fast instead of starting.
     *
     * @param signal the run's cancel signal, or null for a scope that does nothing
     * @return the scope; close it in a try-with-resources around the waiting call
     */
    public static CancelInterrupt open(CancelSignal signal) {
        if (signal == null) {
            return NONE;
        }
        CancelInterrupt scope = new CancelInterrupt(Thread.currentThread());
        scope.unhook = signal.onCancel(scope::fire);
        return scope;
    }

    /**
     * Runs one waiting call inside a scope.
     *
     * @param signal  the run's cancel signal, or null
     * @param waiting the call
     * @param <T>     what the call returns
     * @return what the call returned
     */
    public static <T> T call(CancelSignal signal, Supplier<T> waiting) {
        try (CancelInterrupt ignored = open(signal)) {
            return waiting.get();
        }
    }

    private synchronized void fire() {
        if (open) {
            fired = true;
            thread.interrupt();
        }
    }

    /** Removes the listener and clears the interrupt this scope delivered. */
    @Override
    public void close() {
        if (this == NONE) {
            return;
        }
        unhook.run();
        synchronized (this) {
            open = false;
            if (fired && Thread.currentThread() == thread) {
                Thread.interrupted();
            }
        }
    }
}
