package dev.spectroscope.server.session;

import java.time.Duration;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Card 395: a graceful quit writes what is still queued to the session file
 * before the JVM exits, and closes every run the file still holds open.
 *
 * <p>Each run's drain registers here while it runs. The first registration
 * installs a JVM shutdown hook. On SIGTERM the hook tells every registered drain
 * to stop sending to its socket and cancels its run, then waits for the drains
 * to write their last event, {@link #BOUND} for all of them together. A drain
 * still running at the deadline is sealed: it appends a terminal
 * {@code run_end} for each run it has open and writes nothing more.</p>
 *
 * <p>Before this, the drain ran on a virtual thread, and the JVM does not wait
 * for virtual threads. On 2026-09-23 three quits during a GLM backlog left the
 * session file without the queued tail, and each resume rebuilt the
 * conversation without it.</p>
 *
 * <p>Spring's shutdown also closes the sockets and calls
 * {@link SessionConnection#onClose()}. The hook depends on neither and runs
 * alongside it. The desktop sends SIGKILL 5 s after SIGTERM, so the bound stays
 * under that.</p>
 */
final class QuitFlush {

    /** How long a quit waits for all drains together before it seals the rest. */
    static final Duration BOUND = Duration.ofSeconds(3);

    private static final Set<Drain> DRAINS = ConcurrentHashMap.newKeySet();
    private static final AtomicBoolean HOOKED = new AtomicBoolean();
    /** Counted down when the shutdown hook's flush has returned. */
    private static final CountDownLatch HOOK_FLUSHED = new CountDownLatch(1);
    /** The bound the shutdown hook uses; {@link #BOUND} unless a test child set another. */
    private static volatile Duration hookBound = BOUND;
    /** What the shutdown hook's flush did, once it has run. */
    private static volatile Flushed hookFlushed;

    private QuitFlush() {
    }

    /**
     * What one flush did, counted by the flush itself.
     *
     * @param drained drains that wrote their last event within the bound
     * @param sealed  drains still running at the deadline, sealed
     * @param nanos   how long the flush took, from quit to the last seal
     */
    record Flushed(int drained, int sealed, long nanos) {
    }

    /** One run's drain, as a quit sees it. */
    interface Drain {

        /** Stops sending to the socket and cancels the run. The drain keeps writing the file. */
        void quit();

        /**
         * Waits for the drain to write its last event.
         *
         * @param nanos how long to wait at most
         * @return true once the drain has finished
         * @throws InterruptedException when the waiting thread is interrupted
         */
        boolean awaitDrained(long nanos) throws InterruptedException;

        /** Appends a terminal run_end for every run still open in the file; the drain writes nothing after. */
        void seal();
    }

    /**
     * Adds a running drain, installing the shutdown hook on the first call.
     *
     * @param drain the drain of a run that has just started
     */
    static void register(Drain drain) {
        if (HOOKED.compareAndSet(false, true)) {
            try {
                Runtime.getRuntime().addShutdownHook(
                        new Thread(QuitFlush::flushOnShutdown, "spectro-quit-flush"));
            } catch (IllegalStateException alreadyShuttingDown) {
                // The JVM is on its way out; nothing can be hooked any more.
            }
        }
        DRAINS.add(drain);
    }

    /**
     * Removes a drain whose run has finished.
     *
     * @param drain the drain that wrote its last event
     */
    static void unregister(Drain drain) {
        DRAINS.remove(drain);
    }

    /** The shutdown hook: flushes every registered drain and keeps what the flush did. */
    private static void flushOnShutdown() {
        try {
            hookFlushed = flush(List.copyOf(DRAINS), hookBound);
        } finally {
            HOOK_FLUSHED.countDown();
        }
    }

    /**
     * Card 540: gives the shutdown hook another bound. Only the card 395 child JVM
     * calls this, so that how loaded the machine is cannot decide whether its
     * drain is sealed; the test then reads {@link #awaitHookFlush} instead of a
     * wall clock.
     *
     * @param bound the bound the hook uses from now on
     */
    static void hookBoundForTest(Duration bound) {
        hookBound = bound;
    }

    /**
     * Card 540: waits for the shutdown hook's flush and says what it did. Only
     * the card 395 child JVM calls this; production never reads it.
     *
     * @param timeout how long to wait at most
     * @return what the hook's flush did, or null when it did not run within the timeout
     * @throws InterruptedException when the waiting thread is interrupted
     */
    static Flushed awaitHookFlush(Duration timeout) throws InterruptedException {
        return HOOK_FLUSHED.await(timeout.toNanos(), TimeUnit.NANOSECONDS) ? hookFlushed : null;
    }

    /**
     * Quits every given drain, waits for them within one shared bound, and seals
     * the ones that did not finish.
     *
     * @param drains the drains to flush
     * @param bound  how long all of them together may take
     * @return how many drains finished and how many were sealed
     */
    static Flushed flush(Collection<? extends Drain> drains, Duration bound) {
        long start = System.nanoTime();
        drains.forEach(Drain::quit);
        long deadline = start + bound.toNanos();
        int drainedCount = 0;
        int sealedCount = 0;
        for (Drain drain : drains) {
            boolean drained;
            try {
                drained = drain.awaitDrained(Math.max(0, deadline - System.nanoTime()));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                drained = false;
            }
            if (drained) {
                drainedCount++;
            } else {
                drain.seal();
                sealedCount++;
            }
        }
        return new Flushed(drainedCount, sealedCount, System.nanoTime() - start);
    }
}
