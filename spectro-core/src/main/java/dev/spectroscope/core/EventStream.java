package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent;

import java.util.Iterator;
import java.util.NoSuchElementException;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.function.Consumer;

/**
 * A blocking {@link Iterable} of {@link RunEvent}s backed by a bounded queue that a
 * producer virtual thread fills — the Java 21 counterpart of an
 * {@code AsyncGenerator<RunEvent>}.
 *
 * <p>Backpressure comes for free: the queue is bounded, so a slow consumer blocks the
 * producer on {@code put} instead of flooding a buffer. {@link #close()} cancels the run
 * and is idempotent; {@link AutoCloseable} guarantees cleanup even when the consumer
 * bails out of the for-each early.</p>
 */
public interface EventStream extends Iterable<RunEvent>, AutoCloseable {

    /**
     * Requests cooperative cancellation: the run's {@link CancelSignal} flips and the
     * producing loop winds down at its next safe point ({@code stopReason "aborted"}).
     */
    void cancel();

    /** Idempotent; also cancels — so bailing out of the for-each early still cleans up the run. */
    @Override
    void close();

    /**
     * Starts {@code body} on a producer virtual thread. The body emits events through the
     * supplied sink and MUST terminate the stream on every path (a final {@code run_end},
     * plus {@code error} before it on failure) — otherwise the consumer for-each hangs.
     * The {@link CancelSignal} handed to the body is cancelled by {@link #cancel()}/
     * {@link #close()}.
     *
     * @param signal the cancel signal shared between the stream and the body
     * @param body   the producer — receives the event sink and drives the whole run
     * @return the live stream the caller consumes with a for-each
     */
    static EventStream start(CancelSignal signal, Consumer<Consumer<RunEvent>> body) {
        return new QueueEventStream(signal, body);
    }
}

/** Package-private implementation — the only class that touches the queue and the thread. */
final class QueueEventStream implements EventStream {

    /** Distinct sentinel: putting this on the queue means "the run has ended". */
    private static final RunEvent END = new RunEvent.RunEnd("", "__sentinel__", -1L);

    private final BlockingQueue<RunEvent> queue = new ArrayBlockingQueue<>(64);
    private final CancelSignal signal;
    private final Thread producer;
    private volatile boolean closed = false;

    /**
     * Wires the queue, the sink and the producer — the virtual thread starts immediately.
     * The finally block guarantees the END sentinel on every exit path, a thrown body included.
     *
     * @param signal cancel signal flipped by {@link #cancel()}/{@link #close()}
     * @param body   the producer loop, handed the queue-backed sink
     */
    QueueEventStream(CancelSignal signal, Consumer<Consumer<RunEvent>> body) {
        this.signal = signal;
        // The sink blocks on a full queue — that is the backpressure. put() throwing
        // InterruptedException only happens on close(), where we stop the producer.
        Consumer<RunEvent> sink = event -> {
            try {
                queue.put(event);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        };
        this.producer = Thread.ofVirtual().name("spectroscope-agent").start(() -> {
            try {
                body.accept(sink);
            } finally {
                // Always signal the end, even if the body threw: the consumer must reach
                // the sentinel or its for-each hangs forever.
                try {
                    queue.put(END);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        });
    }

    /** Forwards to the shared {@link CancelSignal} — nothing is interrupted here. */
    @Override
    public void cancel() {
        signal.cancel(); // cooperative: the loop notices at its next safe point
    }

    /** Idempotent teardown: cancels the run and unparks a producer blocked on the full queue. */
    @Override
    public void close() {
        if (closed) {
            return; // idempotent
        }
        closed = true;
        cancel();
        producer.interrupt(); // unblock a producer parked on a full queue
    }

    /** One blocking cursor over the queue; the stream is meant to be iterated exactly once.
     *  @return an iterator whose {@code hasNext} parks until the producer emits or ends */
    @Override
    public Iterator<RunEvent> iterator() {
        return new Iterator<>() {
            private RunEvent next = null;
            private boolean ended = false;

            /** Blocks for the next event; the END sentinel or an interrupt ends the stream.
             *  @return true when an event is buffered and ready for {@link #next()} */
            @Override
            public boolean hasNext() {
                if (ended) {
                    return false;
                }
                if (next != null) {
                    return true;
                }
                try {
                    RunEvent taken = queue.take(); // blocks until the producer emits
                    if (taken == END) {
                        ended = true;
                        return false;
                    }
                    next = taken;
                    return true;
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    ended = true;
                    return false;
                }
            }

            /** Hands out the buffered event and clears the buffer.
             *  @return the next event in emission order */
            @Override
            public RunEvent next() {
                if (!hasNext()) {
                    throw new NoSuchElementException();
                }
                RunEvent value = next;
                next = null;
                return value;
            }
        };
    }
}
