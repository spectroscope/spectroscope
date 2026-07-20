package dev.spectroscope.core.subagents;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The shared-queue merge: buffered values, a blocked consumer, end(), drop-after-end. */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class MergedEventStreamTest {

    private static RunEvent delta(String agentId, String text) {
        return new RunEvent.TextDelta(agentId, text, 1L);
    }

    @Test
    void buffersEarlyEventsAndWakesABlockedConsumer() {
        MergedEventStream stream = new MergedEventStream(() -> { });
        stream.put(delta("demo", "one"));   // no consumer yet -> buffered
        stream.put(delta("demo", "two"));
        Thread.ofVirtual().start(() -> {
            try {
                Thread.sleep(50);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            stream.put(delta("demo", "three")); // consumer already blocked in take() -> wakes it
            stream.end();
        });

        List<String> texts = new ArrayList<>();
        for (RunEvent event : stream) {
            texts.add(((RunEvent.TextDelta) event).text());
        }
        assertEquals(List.of("one", "two", "three"), texts);
    }

    @Test
    void eventsAfterEndAreDropped() {
        MergedEventStream stream = new MergedEventStream(() -> { });
        stream.put(delta("demo", "kept"));
        stream.end();
        stream.put(delta("demo", "dropped"));
        stream.end(); // idempotent

        List<RunEvent> events = new ArrayList<>();
        stream.forEach(events::add);
        assertEquals(1, events.size());
    }

    @Test
    void closeDelegatesToTheCancelHook() {
        AtomicBoolean cancelled = new AtomicBoolean(false);
        MergedEventStream stream = new MergedEventStream(() -> cancelled.set(true));
        stream.close();
        assertTrue(cancelled.get(), "close() must cancel the run (EventStream contract)");
        stream.end(); // let a hypothetical consumer finish
    }
}
