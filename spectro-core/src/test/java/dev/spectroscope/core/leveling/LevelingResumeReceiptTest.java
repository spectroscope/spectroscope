package dev.spectroscope.core.leveling;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.trace.JsonlSink;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;

/**
 * A receipt says "criterion met, session S, event N". Card 81 turns that into a
 * deep link that opens S at N, so N has to address the same line the client
 * counts — through a resume, through a reconnect, through a crash-torn file.
 * A wrong number is worse than no number, and marks are write-once, so a wrong
 * one is burned in for good. These tests hold the two counts against each other
 * on real files rather than trusting that they agree.
 */
class LevelingResumeReceiptTest {

    private static RunEvent text(String body, long ts) {
        return new RunEvent.TextDelta("main", body, ts);
    }

    private static RunEvent end(long ts) {
        return new RunEvent.RunEnd("run-1", "end_turn", ts);
    }

    @Test
    void aResumedRunsReceiptAddressesTheRealLine(@TempDir Path home) throws IOException {
        String previousHome = System.setProperty("user.home", home.toString());
        try {
            // A first sitting writes its events, exactly as a live run would.
            SessionStore first = new SessionStore();
            JsonlSink sink = new JsonlSink(first);
            for (int i = 0; i < 5; i++) {
                sink.onEvent(text("line " + i, 100L + i));
            }
            String sessionId = first.id();

            // The session is resumed: the store appends, so the ladder has to count
            // from where the file ends rather than from zero.
            SessionStore resumed = new SessionStore(sessionId);
            JsonlSink resumedSink = new JsonlSink(resumed);
            LevelingRecorder recorder = new LevelingRecorder(Ladder.bundled(),
                    new LevelingStore(home.resolve("leveling.json")), LevelingState.Mode.LADDER);
            LevelingPort port = new LevelingPort(sessionId, recorder,
                    SessionStore.eventCount(sessionId));

            RunEvent finish = end(200L);
            resumedSink.onEvent(finish);
            port.onEvent(finish);

            int recorded = recorder.state().marks().get("first-run-complete").eventIndex();
            List<RunEvent> onDisk = SessionStore.readSessionEvents(sessionId);
            assertEquals(onDisk.size() - 1, recorded,
                    "the receipt must index the run_end the client will find at that position");
            assertSame(RunEvent.RunEnd.class, onDisk.get(recorded).getClass());
        } finally {
            if (previousHome != null) {
                System.setProperty("user.home", previousHome);
            }
        }
    }

    @Test
    void aCrashTornLastLineDoesNotShiftTheCount(@TempDir Path home) throws IOException {
        String previousHome = System.setProperty("user.home", home.toString());
        try {
            SessionStore store = new SessionStore();
            JsonlSink sink = new JsonlSink(store);
            sink.onEvent(text("one", 1L));
            sink.onEvent(text("two", 2L));

            // A crash mid-write leaves half a line. The reader the client uses drops
            // it; any count that keeps it would be one ahead of every deep link.
            Path file = SessionStore.SESSIONS_DIR.resolve(store.id() + ".jsonl");
            Files.writeString(file, "{\"type\":\"text_delta\",\"agentId\":\"ma",
                    java.nio.file.StandardOpenOption.APPEND);

            assertEquals(SessionStore.readSessionEvents(store.id()).size(),
                    SessionStore.eventCount(store.id()),
                    "the ladder and the client must count the same events");
        } finally {
            if (previousHome != null) {
                System.setProperty("user.home", previousHome);
            }
        }
    }
}
