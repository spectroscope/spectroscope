package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 471: the marker a {@code /clear} leaves in the session file.
 *
 * <p>The event is additive: one more subtype of the sealed union and one more
 * line a session file may hold. It names the agent whose history was dropped
 * and how many messages went, so a reader of the file can tell a clear on a
 * long conversation from a clear on an empty one.</p>
 */
class ContextClearedEventTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void theMarkerRoundTripsUnderItsWireName() throws Exception {
        String line = JSON.writeValueAsString(new RunEvent.ContextCleared("main", 80, 1700L));

        assertTrue(line.contains("\"type\":\"context_cleared\""), line);
        assertTrue(line.contains("\"removedMessages\":80"), line);

        RunEvent.ContextCleared back = (RunEvent.ContextCleared) JSON.readValue(line, RunEvent.class);
        assertEquals("main", back.agentId());
        assertEquals(80, back.removedMessages());
        assertEquals(1700L, back.ts());
    }

    @Test
    void aSessionFileHoldingOneReadsBackWithEverythingAroundItIntact() throws Exception {
        String id = "context-cleared-event-test";
        Path file = SessionStore.SESSIONS_DIR.resolve(id + ".jsonl");
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Files.writeString(file, """
                {"type":"run_start","runId":"r1","agentId":"main","prompt":"go","ts":1}
                {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":2}
                {"type":"context_cleared","agentId":"main","removedMessages":2,"ts":3}
                {"type":"run_start","runId":"r2","agentId":"main","prompt":"again","ts":4}
                """, StandardCharsets.UTF_8);
        try {
            List<RunEvent> events = SessionStore.readSessionEvents(id);

            assertEquals(4, events.size(), "the new line is a line, not a torn one: " + events);
            RunEvent.ContextCleared cleared = (RunEvent.ContextCleared) events.get(2);
            assertEquals(2, cleared.removedMessages());
        } finally {
            Files.deleteIfExists(file);
        }
    }
}
