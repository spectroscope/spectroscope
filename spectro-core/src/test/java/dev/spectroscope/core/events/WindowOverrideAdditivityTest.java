package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Card 390: the operator's window for a session, on the record.
 *
 * <p>An ADDITIVE line type. The server writes one when the operator sets or
 * clears the window from the ring, before it answers the page, and a resumed
 * session takes the window from the LAST such line. So three things are
 * pinned: the exact line, that a clear leaves {@code tokens} out rather than
 * writing a zero, and that the line reads back from an ordinary session file
 * without disturbing what the resume rebuilds.</p>
 */
class WindowOverrideAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static Path sessionFile(String id, String lines) throws Exception {
        Path file = SessionStore.SESSIONS_DIR.resolve(id + ".jsonl");
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Files.writeString(file, lines, StandardCharsets.UTF_8);
        return file;
    }

    @Test
    void aSetWindowIsOneLineWithTheValueAndWhatFollowsFromIt() throws Exception {
        String line = JSON.writeValueAsString(
                new RunEvent.WindowOverride(512_000, 358_400, "window_override", 512_000, 7L));

        assertEquals("{\"type\":\"window_override\",\"tokens\":512000,\"threshold\":358400,"
                + "\"thresholdSource\":\"window_override\",\"contextWindow\":512000,\"ts\":7}", line);

        RunEvent.WindowOverride back = (RunEvent.WindowOverride) JSON.readValue(line, RunEvent.class);
        assertEquals(512_000, back.tokens());
        assertEquals(358_400, back.threshold());
        assertEquals("window_override", back.thresholdSource());
        assertEquals(512_000, back.contextWindow());
    }

    @Test
    void aClearLeavesTheValueOutAndNamesTheSourceThatDecidesAgain() throws Exception {
        String line = JSON.writeValueAsString(
                new RunEvent.WindowOverride(null, 100_000, "fallback", null, 8L));

        assertEquals("{\"type\":\"window_override\",\"threshold\":100000,"
                + "\"thresholdSource\":\"fallback\",\"ts\":8}", line,
                "a clear writes no tokens key and no zero: 0 would read as a tiny window");

        RunEvent.WindowOverride back = (RunEvent.WindowOverride) JSON.readValue(line, RunEvent.class);
        assertNull(back.tokens());
        assertNull(back.contextWindow());
        assertEquals("fallback", back.thresholdSource());
    }

    @Test
    void theLastLineOfASessionIsTheWindowInForce() throws Exception {
        String id = "window-override-last-wins";
        Path file = sessionFile(id, """
                {"type":"run_start","runId":"r1","agentId":"main","prompt":"go","ts":1}
                {"type":"window_override","tokens":250368,"threshold":175257,"thresholdSource":"window_override","contextWindow":250368,"ts":2}
                {"type":"context_info","agentId":"main","turn":1,"messages":1,"estimatedTokens":9,"threshold":175257,"parts":[],"ts":3,"thresholdSource":"window_override","contextWindow":250368}
                {"type":"window_override","tokens":512000,"threshold":358400,"thresholdSource":"window_override","contextWindow":512000,"ts":4}
                {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":5}
                """);
        try {
            assertEquals(512_000, SessionStore.recordedWindowOverride(id));
        } finally {
            Files.deleteIfExists(file);
        }
    }

    @Test
    void aClearAfterASetLeavesNoWindowInForce() throws Exception {
        String id = "window-override-cleared";
        Path file = sessionFile(id, """
                {"type":"run_start","runId":"r1","agentId":"main","prompt":"go","ts":1}
                {"type":"window_override","tokens":512000,"threshold":358400,"thresholdSource":"window_override","contextWindow":512000,"ts":2}
                {"type":"window_override","threshold":100000,"thresholdSource":"fallback","ts":3}
                """);
        try {
            assertNull(SessionStore.recordedWindowOverride(id));
        } finally {
            Files.deleteIfExists(file);
        }
    }

    @Test
    void aSessionWithoutTheLineAMissingFileAndATornLineSetNothing() throws Exception {
        String plain = "window-override-none";
        Path plainFile = sessionFile(plain, """
                {"type":"run_start","runId":"r1","agentId":"main","prompt":"go","ts":1}
                {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":2}
                """);
        String torn = "window-override-torn";
        Path tornFile = sessionFile(torn, """
                {"type":"window_override","tokens":512000,"threshold":358400,"thresholdSource":"window_override","contextWindow":512000,"ts":2}
                {"type":"window_override","tokens":2500""");
        try {
            assertNull(SessionStore.recordedWindowOverride(plain));
            assertNull(SessionStore.recordedWindowOverride("window-override-no-such-file"));
            assertEquals(512_000, SessionStore.recordedWindowOverride(torn),
                    "a torn tail is dropped; the last whole line decides");
        } finally {
            Files.deleteIfExists(plainFile);
            Files.deleteIfExists(tornFile);
        }
    }

    @Test
    void theLineRidesInAResumedSessionWithoutChangingTheHistory() throws Exception {
        String with = "window-override-history-with";
        String without = "window-override-history-without";
        String run = """
                {"type":"run_start","runId":"r1","agentId":"main","prompt":"go","ts":1}
                {"type":"text_delta","agentId":"main","text":"done","ts":2}
                {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":3}
                """;
        Path a = sessionFile(with, run + """
                {"type":"window_override","tokens":512000,"threshold":358400,"thresholdSource":"window_override","contextWindow":512000,"ts":4}
                """);
        Path b = sessionFile(without, run);
        try {
            List<RunEvent> events = SessionStore.readSessionEvents(with);
            assertEquals(4, events.size(), "the new line is a line, not a torn one");
            assertEquals(SessionStore.loadSession(without), SessionStore.loadSession(with),
                    "the window is a setting of the session, not a message in its history");
            assertFalse(SessionStore.loadSession(with).isEmpty(), "test premise: a history was rebuilt");
        } finally {
            Files.deleteIfExists(a);
            Files.deleteIfExists(b);
        }
    }
}
