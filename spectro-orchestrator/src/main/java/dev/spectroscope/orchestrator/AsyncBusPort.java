package dev.spectroscope.orchestrator;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.trace.TracingPort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The node-side decoupling between a run and its bus: a bounded queue
 * drained on its own virtual thread, so the run loop NEVER blocks on the
 * transport — the same no-consumer-under-the-lock discipline the hub applies
 * to local subscribers, mirrored onto the publishing path. A registered
 * tracing port must never cost the run its liveness; exception isolation
 * alone cannot stop a port that BLOCKS (a dead hub's full outbox), so this
 * class turns blocking into loss — counted, warned, never silent.
 *
 * <p>Overflow drops happen BEFORE the stamper: an event that never reaches
 * the downstream publisher consumes no sequence number, so the on-wire
 * stream stays contiguous — the fleet view simply misses what the node's
 * log loudly counts. The session JSONL (the required port) is untouched by
 * any of this; it remains the durability anchor.</p>
 *
 * <p>{@link #close()} drains the queue while the bus is still up, bounded
 * by a grace period — a stalled bus cannot turn close into a hang; whatever
 * could not be delivered is counted as stranded and warned about.</p>
 */
public final class AsyncBusPort implements TracingPort, AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(AsyncBusPort.class);

    /** How long {@link #close()} waits for the drain to empty the queue. */
    private static final long DEFAULT_CLOSE_GRACE_MS = 5_000;

    private final TracingPort downstream;
    private final ArrayBlockingQueue<RunEvent> queue;
    private final long closeGraceMs;
    private final Thread drain;
    private final AtomicLong dropped = new AtomicLong();
    private final AtomicLong stranded = new AtomicLong();
    private final AtomicBoolean warnedDropping = new AtomicBoolean();
    private final AtomicBoolean warnedBroken = new AtomicBoolean();
    private volatile boolean closed;

    /**
     * @param downstream the real publisher (typically a {@link BusPublisher})
     * @param capacity   events buffered while the bus is slow or down
     */
    public AsyncBusPort(TracingPort downstream, int capacity) {
        this(downstream, capacity, DEFAULT_CLOSE_GRACE_MS);
    }

    /** @param closeGraceMs how long close waits for the queue to drain */
    public AsyncBusPort(TracingPort downstream, int capacity, long closeGraceMs) {
        this.downstream = Objects.requireNonNull(downstream, "downstream");
        this.queue = new ArrayBlockingQueue<>(capacity);
        this.closeGraceMs = closeGraceMs;
        this.drain = Thread.ofVirtual().name("spectro-node-bus-drain").start(this::drainLoop);
    }

    /** Non-blocking by contract: a full queue means the bus view loses this
     *  event — counted and warned, while the run sails on. */
    @Override
    public void onEvent(RunEvent event) {
        if (closed) {
            return;
        }
        if (queue.offer(event)) {
            return;
        }
        dropped.incrementAndGet();
        if (warnedDropping.compareAndSet(false, true)) {
            log.warn("bus stalled — dropping further events from the bus view "
                    + "(the session JSONL stays complete); the final count is logged on close");
        }
    }

    /** @return events the bus view lost to overflow while the bus was stalled */
    public long dropped() {
        return dropped.get();
    }

    /** @return events still undelivered when close gave up waiting */
    public long stranded() {
        return stranded.get();
    }

    private void drainLoop() {
        try {
            while (true) {
                RunEvent event = queue.take();
                try {
                    downstream.onEvent(event);
                } catch (RuntimeException broken) {
                    // A dying transport throws (an interrupted outbox wait
                    // included): the event is lost to the bus view — count it.
                    stranded.incrementAndGet();
                    if (warnedBroken.compareAndSet(false, true)) {
                        log.warn("bus publisher failed (suppressing further warnings): {}",
                                broken.toString());
                    }
                }
            }
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        }
    }

    /** Idempotent. Bounded by the grace period, never by the bus. */
    @Override
    public void close() {
        closed = true;
        long deadline = System.currentTimeMillis() + closeGraceMs;
        while (!queue.isEmpty() && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(20); // bounded courtesy wait — the drain is emptying
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        stranded.addAndGet(queue.size());
        queue.clear();
        drain.interrupt();
        try {
            drain.join(1_000);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        if (dropped.get() > 0 || stranded.get() > 0) {
            log.warn("node bus view lost {} dropped and {} stranded frame(s) — "
                    + "the session JSONL is complete regardless", dropped.get(), stranded.get());
        }
    }
}
