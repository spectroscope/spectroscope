package dev.spectroscope.core.tools;

import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/**
 * One blocking call on its own platform thread, so a test can watch the
 * processes the call starts, cancel it, or interrupt it while it blocks.
 *
 * @param <T> what the call returns
 */
public final class ThreadedCall<T> {

    private final Thread thread;
    private final AtomicReference<T> result = new AtomicReference<>();
    private final AtomicReference<Throwable> failure = new AtomicReference<>();

    private ThreadedCall(Supplier<T> call) {
        this.thread = new Thread(() -> {
            try {
                result.set(call.get());
            } catch (Throwable thrown) {
                failure.set(thrown);
            }
        }, "threaded-call");
        this.thread.setDaemon(true);
    }

    /**
     * Starts the call.
     *
     * @param call the blocking call
     * @param <T>  what the call returns
     * @return the running call
     */
    public static <T> ThreadedCall<T> start(Supplier<T> call) {
        ThreadedCall<T> started = new ThreadedCall<>(call);
        started.thread.start();
        return started;
    }

    /** Interrupts the thread the call blocks on. */
    public void interrupt() {
        thread.interrupt();
    }

    /**
     * Waits for the call to return.
     *
     * @param timeoutMs the longest wait
     * @return what the call returned
     * @throws InterruptedException when the waiting thread is interrupted
     * @throws AssertionError       when the call threw or did not return in time
     */
    public T join(long timeoutMs) throws InterruptedException {
        thread.join(timeoutMs);
        if (thread.isAlive()) {
            throw new AssertionError("the call did not return within " + timeoutMs + " ms");
        }
        if (failure.get() != null) {
            throw new AssertionError("the call threw", failure.get());
        }
        return result.get();
    }
}
