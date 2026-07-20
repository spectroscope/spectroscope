package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The queue-backed stream: events arrive in order, the sentinel ends the
 * for-each, a body failure still terminates the stream, and close() both
 * cancels the signal and unblocks a producer parked on the full queue.
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class EventStreamTest {

    private static RunEvent textDelta(int index) {
        return new RunEvent.TextDelta("main", "chunk-" + index, index);
    }

    @Test
    void deliversAllEventsInOrderAndEnds() {
        List<RunEvent> received = new ArrayList<>();
        try (EventStream stream = EventStream.start(new CancelSignal(), sink -> {
            for (int i = 0; i < 5; i++) {
                sink.accept(textDelta(i));
            }
        })) {
            stream.forEach(received::add);
        }
        List<String> texts = received.stream()
                .map(event -> ((RunEvent.TextDelta) event).text())
                .toList();
        assertEquals(List.of("chunk-0", "chunk-1", "chunk-2", "chunk-3", "chunk-4"), texts);
    }

    @Test
    void aThrowingBodyStillTerminatesTheStream() {
        List<RunEvent> received = new ArrayList<>();
        try (EventStream stream = EventStream.start(new CancelSignal(), sink -> {
            sink.accept(textDelta(1));
            throw new IllegalStateException("boom");
        })) {
            // Must not hang: the finally-sentinel ends the iteration even after the throw.
            stream.forEach(received::add);
        }
        assertEquals(1, received.size());
    }

    @Test
    void closeCancelsTheSignalAndUnblocksTheProducer() throws Exception {
        CancelSignal signal = new CancelSignal();
        CountDownLatch producerFinished = new CountDownLatch(1);

        EventStream stream = EventStream.start(signal, sink -> {
            try {
                // More events than the queue holds: without a consumer the sink blocks,
                // which is exactly the backpressure close() must be able to break.
                for (int i = 0; i < 1_000 && !signal.isCancelled(); i++) {
                    sink.accept(textDelta(i));
                }
            } finally {
                producerFinished.countDown();
            }
        });

        // Consume a few events, then bail out early — try-with-resources in real code.
        var iterator = stream.iterator();
        for (int i = 0; i < 3 && iterator.hasNext(); i++) {
            iterator.next();
        }
        stream.close();

        assertTrue(signal.isCancelled(), "close() must cancel the run");
        assertTrue(producerFinished.await(5, TimeUnit.SECONDS),
                "close() must unblock a producer parked on the full queue");
        stream.close(); // idempotent — second close is a no-op
    }
}
