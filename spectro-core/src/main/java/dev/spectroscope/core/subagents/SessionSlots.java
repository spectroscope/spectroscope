package dev.spectroscope.core.subagents;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.governing.Governs;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 * The slot pool of one chat (card 490): how many of its helpers may hold a
 * model session at the same time.
 *
 * <p>A helper draws a ticket when it is asked for, in the order the parent
 * asked, takes a slot before its first model request and gives it back when
 * it finishes. While the chat's count is set, at most
 * {@link SessionCount#helpersAtOnce()} helpers hold a slot and the rest are
 * admitted first come, first served. Nothing is refused and nothing outside
 * the chat is counted. With no count set every helper is admitted at once,
 * as in v0.14.4.</p>
 *
 * <p>The count is read each time a waiting helper looks again, so a change
 * reaches the next helper that waits, and a helper that already holds a slot
 * keeps it. A lock and a condition rather than {@code synchronized}: the
 * helpers run on virtual threads, and on JDK 21 a virtual thread that waits
 * inside {@code synchronized} pins the platform thread it runs on.</p>
 */
final class SessionSlots {

    /** How often a waiting helper reads the chat's count again when nothing
     *  else wakes it: half a second. A finished helper and a cancelled run
     *  wake the waiters at once; this interval only bounds how late a RAISED
     *  count reaches them, because the setter lives on the parent agent and
     *  does not know the pool. Half a second against helpers whose first
     *  exchange is measured in tens of seconds on a local model. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    static final long RECHECK_MS = 500;

    /** One helper's place in the queue. Identity is the point; it carries nothing. */
    static final class Ticket {
    }

    private final ReentrantLock lock = new ReentrantLock();
    private final Condition changed = lock.newCondition();
    private final Deque<Ticket> queue = new ArrayDeque<>();
    private int running;

    /**
     * Draws a ticket at the back of the queue. Called on the parent's thread,
     * in the order the helpers were asked for, so the queue keeps that order.
     *
     * @return the helper's ticket
     */
    Ticket enqueue() {
        lock.lock();
        try {
            Ticket ticket = new Ticket();
            queue.addLast(ticket);
            return ticket;
        } finally {
            lock.unlock();
        }
    }

    /**
     * Whether this helper cannot be admitted even once every helper in front
     * of it has been: the case the chat shows as waiting. A helper that is
     * only behind another one still being admitted is not waiting.
     *
     * @param ticket the helper's ticket
     * @param count  the chat's count now
     * @return true when the helper waits for a slot to come free
     */
    boolean mustWait(Ticket ticket, SessionCount count) {
        if (!count.isSet()) {
            return false;
        }
        lock.lock();
        try {
            int ahead = 0;
            for (Ticket queued : queue) {
                if (queued == ticket) {
                    break;
                }
                ahead++;
            }
            return running + ahead >= count.helpersAtOnce();
        } finally {
            lock.unlock();
        }
    }

    /**
     * Blocks until this helper holds a slot, or until the run is cancelled.
     *
     * @param ticket the helper's ticket
     * @param count  the chat's count, read again each time the helper looks
     * @param signal the parent run's signal; a cancel ends the wait
     * @return true when the helper holds a slot and must {@link #release()}
     *         it; false when the run was cancelled first, holding nothing
     */
    boolean acquire(Ticket ticket, Supplier<SessionCount> count, CancelSignal signal) {
        lock.lock();
        try {
            while (true) {
                if (signal.isCancelled()) {
                    forgetLocked(ticket);
                    return false;
                }
                SessionCount now = count.get();
                if (!now.isSet() || (queue.peekFirst() == ticket && running < now.helpersAtOnce())) {
                    queue.remove(ticket);
                    running++;
                    changed.signalAll();
                    return true;
                }
                try {
                    changed.await(RECHECK_MS, TimeUnit.MILLISECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    forgetLocked(ticket);
                    return false;
                }
            }
        } finally {
            lock.unlock();
        }
    }

    /** Gives a slot back and wakes the helpers that wait. */
    void release() {
        lock.lock();
        try {
            running--;
            changed.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /**
     * Drops a ticket that never asked for a slot, so it cannot hold up the
     * helpers behind it. A no-op for a ticket that was admitted or dropped.
     *
     * @param ticket the helper's ticket
     */
    void forget(Ticket ticket) {
        lock.lock();
        try {
            forgetLocked(ticket);
        } finally {
            lock.unlock();
        }
    }

    /** Wakes every waiting helper so it looks again, for a cancelled run. */
    void wake() {
        lock.lock();
        try {
            changed.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** @return how many helpers hold a slot now */
    int running() {
        lock.lock();
        try {
            return running;
        } finally {
            lock.unlock();
        }
    }

    /** @return how many tickets are in the queue now */
    int queued() {
        lock.lock();
        try {
            return queue.size();
        } finally {
            lock.unlock();
        }
    }

    private void forgetLocked(Ticket ticket) {
        if (queue.remove(ticket)) {
            changed.signalAll();
        }
    }
}
