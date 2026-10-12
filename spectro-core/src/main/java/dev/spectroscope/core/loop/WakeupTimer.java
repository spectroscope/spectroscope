package dev.spectroscope.core.loop;

import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Card 504: what holds a loop's next wakeup. The server holds it in its
 * process, the REPL in a timer thread of its own; tests move a clock by hand.
 */
public interface WakeupTimer {

    /** A scheduled wakeup that can be called off. */
    interface Cancellable {
        /** Calls the wakeup off; a wakeup that already ran is left as it is. */
        void cancel();
    }

    /**
     * @param task    what runs when the time comes
     * @param delayMs how long from now
     * @return the handle to call it off
     */
    Cancellable schedule(Runnable task, long delayMs);

    /**
     * @param executor the executor that holds the wakeups
     * @return a timer on it
     */
    static WakeupTimer on(ScheduledExecutorService executor) {
        return (task, delayMs) -> {
            ScheduledFuture<?> future = executor.schedule(task, Math.max(0, delayMs), TimeUnit.MILLISECONDS);
            return () -> future.cancel(false);
        };
    }
}
