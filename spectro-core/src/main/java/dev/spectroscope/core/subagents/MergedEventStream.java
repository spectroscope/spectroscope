package dev.spectroscope.core.subagents;

import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.events.RunEvent;

import java.util.Iterator;
import java.util.NoSuchElementException;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;

/**
 * The shared-queue merge: ONE BlockingQueue, many producers
 * (the parent pump plus one forwarder thread per child), exactly ONE
 * consumer (the CLI's for-each). Intended for a single consumer — do not
 * hand the iterator to several threads.
 */
final class MergedEventStream implements EventStream {

    /**
     * Poison pill: a BlockingQueue cannot hold null, so end-of-stream is a
     * dedicated sentinel instance, recognized by REFERENCE identity (==).
     * It is never handed to the consumer and never serialized.
     */
    static final RunEvent END_OF_STREAM = new RunEvent.RunEnd("__end__", "__end__", 0L);

    /** Unbounded on purpose: producers must never block behind a slow renderer. */
    private final BlockingQueue<RunEvent> queue = new LinkedBlockingQueue<>();

    /** What cancel()/close() should do — the manager passes parentSignal::cancel. */
    private final Runnable onCancel;

    private volatile boolean ended = false;

    /**
     * One instance per merged run, created by SubagentManager.run.
     *
     * @param onCancel invoked by cancel()/close() — the parent signal's cancel,
     *                 so closing the merged stream tears down the whole tree
     */
    MergedEventStream(Runnable onCancel) {
        this.onCancel = onCancel;
    }

    /**
     * Producer side: the parent pump and the child forwarders put events here.
     * Events arriving after end() are dropped — by the time the parent run
     * ends, every child has already finished (see SubagentManager.run), so
     * nothing of value can be lost.
     *
     * @param event the next parent or child event, enqueued in arrival order
     */
    void put(RunEvent event) {
        if (ended) {
            return;
        }
        try {
            queue.put(event);
        } catch (InterruptedException interrupted) {
            // The producer virtual thread is being torn down: stop producing.
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Ends the stream. The consumer first drains everything still buffered
     * (the queue is FIFO), then sees the sentinel and stops. Idempotent.
     */
    void end() {
        if (ended) {
            return;
        }
        ended = true;
        queue.add(END_OF_STREAM); // add(): unbounded queue, never blocks
    }

    /** Runs the injected cancel hook — cancelling the merge cancels the parent signal, which cascades to every child. */
    @Override
    public void cancel() {
        onCancel.run();
    }

    /** Idempotent; also cancels — the EventStream contract. */
    @Override
    public void close() {
        cancel();
    }

    /** The single consumer's view: a blocking iterator that drains the queue and stops at the sentinel. */
    @Override
    public Iterator<RunEvent> iterator() {
        return new Iterator<>() {
            private RunEvent lookahead; // hasNext() parks the taken event here
            private boolean done = false;

            /** Blocks on the queue until an event or the sentinel arrives; parks the taken event for next(). */
            @Override
            public boolean hasNext() {
                if (done) {
                    return false;
                }
                if (lookahead != null) {
                    return true;
                }
                try {
                    RunEvent taken = queue.take(); // blocks — fine on a virtual thread
                    if (taken == END_OF_STREAM) {
                        done = true;
                        return false;
                    }
                    lookahead = taken;
                    return true;
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    done = true;
                    return false;
                }
            }

            /** Hands out the event parked by hasNext(). */
            @Override
            public RunEvent next() {
                if (!hasNext()) {
                    throw new NoSuchElementException();
                }
                RunEvent event = lookahead;
                lookahead = null;
                return event;
            }
        };
    }
}
