package dev.spectroscope.core;

import java.time.Duration;

/**
 * Lets a test outside this package ask whether the thread that produced a
 * run is gone (card 557, criterion 6). {@link QueueEventStream#producerAlive()}
 * is package-private; this is the one public door to it, and it lives in the
 * test sources only.
 */
public final class EventStreamProbe {

    private EventStreamProbe() {
    }

    /**
     * Waits until the producer of {@code stream} has ended, or the timeout passes.
     *
     * @param stream  a stream from {@link Agent#run}
     * @param timeout how long to wait
     * @return true when the producer thread is gone
     * @throws InterruptedException when the waiting thread is interrupted
     */
    public static boolean producerGoneWithin(EventStream stream, Duration timeout) throws InterruptedException {
        QueueEventStream queue = (QueueEventStream) stream;
        long deadline = System.nanoTime() + timeout.toNanos();
        while (queue.producerAlive() && System.nanoTime() < deadline) {
            Thread.sleep(5);
        }
        return !queue.producerAlive();
    }
}
