package dev.spectroscope.core.loop;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.function.LongSupplier;

/** A wakeup timer on a hand-moved clock: {@link #advanceTo} runs what fell due, in due order. */
final class FakeTimer implements WakeupTimer, LongSupplier {

    private long now;
    private final List<Task> tasks = new ArrayList<>();
    private int scheduled;
    private int cancelled;

    private final class Task implements WakeupTimer.Cancellable {
        final long due;
        final Runnable body;
        boolean dead;

        Task(long due, Runnable body) {
            this.due = due;
            this.body = body;
        }

        @Override
        public void cancel() {
            synchronized (FakeTimer.this) {
                if (!dead) {
                    dead = true;
                    cancelled++;
                }
            }
        }
    }

    FakeTimer(long start) {
        this.now = start;
    }

    @Override
    public synchronized long getAsLong() {
        return now;
    }

    @Override
    public synchronized WakeupTimer.Cancellable schedule(Runnable task, long delayMs) {
        Task t = new Task(now + Math.max(0, delayMs), task);
        tasks.add(t);
        scheduled++;
        return t;
    }

    /** Moves the clock and runs every live task that fell due, outside the lock. */
    void advanceTo(long to) {
        while (true) {
            Task next;
            synchronized (this) {
                next = tasks.stream().filter(t -> !t.dead && t.due <= to)
                        .min(Comparator.comparingLong(t -> t.due)).orElse(null);
                if (next == null) {
                    now = Math.max(now, to);
                    return;
                }
                now = Math.max(now, next.due);
                next.dead = true;
            }
            next.body.run();
        }
    }

    void advanceBy(long ms) {
        advanceTo(getAsLong() + ms);
    }

    synchronized int live() {
        return (int) tasks.stream().filter(t -> !t.dead).count();
    }

    synchronized int scheduled() {
        return scheduled;
    }

    synchronized int cancelled() {
        return cancelled;
    }
}
