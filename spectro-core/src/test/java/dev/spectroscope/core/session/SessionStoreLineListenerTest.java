package dev.spectroscope.core.session;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.leveling.Ladder;
import dev.spectroscope.core.leveling.LevelingPort;
import dev.spectroscope.core.leveling.LevelingRecorder;
import dev.spectroscope.core.leveling.LevelingState;
import dev.spectroscope.core.leveling.LevelingStore;
import dev.spectroscope.core.trace.JsonlSink;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertSame;

/**
 * Card 473: the leveling ladder hears every line the session FILE gets, with
 * its line number, so a receipt names the line the client finds at that
 * position. Some lines (a closed exchange, a window override) reach the file
 * without passing the tracing ports, and before this a receipt that followed
 * one of them was one line early.
 */
class SessionStoreLineListenerTest {

    @Test
    void aFreshReceiptAddressesTheLineTheClientFinds(@TempDir Path home) throws IOException {
        SessionStore store = new SessionStore();
        JsonlSink sink = new JsonlSink(store);
        LevelingRecorder recorder = new LevelingRecorder(Ladder.bundled(),
                new LevelingStore(home.resolve("leveling.json")), LevelingState.Mode.LADDER);
        LevelingPort port = new LevelingPort(store.id(), recorder);
        // The ladder hears every line the store writes, with its line number:
        // the run's own events, and a line written beside the run (as the
        // session writes the llm_exchange of a closed exchange).
        store.onLine(port::onEventAt, 0);

        sink.onEvent(new RunEvent.RunStart("run-1", "main", null, "hi", null, null, null, null, null, 9L));
        sink.onEvent(new RunEvent.TextDelta("main", "hello", 10L));
        store.append(new RunEvent.WindowOverride(null, 100_000, "default", null, 10L));
        sink.onEvent(new RunEvent.RunEnd("run-1", "end_turn", 11L));

        int recorded = recorder.state().marks().get("first-run-complete").eventIndex();
        List<RunEvent> onDisk = SessionStore.readSessionEvents(store.id());
        // Positive control: a side line precedes the run_end, so the count has
        // a line to be off by.
        assertInstanceOf(RunEvent.WindowOverride.class, onDisk.get(2));
        assertEquals(onDisk.size() - 1, recorded,
                "the receipt must index the run_end the client will find at that position");
        assertSame(RunEvent.RunEnd.class, onDisk.get(recorded).getClass());
    }

    @Test
    void aResumedStoreNumbersItsLinesFromWhereTheFileEnds() throws IOException {
        SessionStore first = new SessionStore();
        first.append(new RunEvent.TextDelta("main", "one", 1L));
        first.append(new RunEvent.TextDelta("main", "two", 2L));

        SessionStore resumed = new SessionStore(first.id());
        List<Integer> heard = new java.util.ArrayList<>();
        resumed.onLine((line, event) -> heard.add(line), SessionStore.eventCount(first.id()));
        resumed.append(new RunEvent.TextDelta("main", "three", 3L));
        assertEquals(List.of(2), heard);
    }

    @Test
    void aListenerThatThrowsDoesNotCostTheLine() throws IOException {
        SessionStore store = new SessionStore();
        store.onLine((line, event) -> {
            throw new IllegalStateException("a nicety failed");
        }, 0);
        store.append(new RunEvent.TextDelta("main", "kept", 1L));
        assertEquals(1, SessionStore.readSessionEvents(store.id()).size());
    }
}
