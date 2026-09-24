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
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 380: what a sentence typed into a running turn leaves behind, on the wire.
 *
 * <p>The event is ADDITIVE: a subtype the sealed union gained, a line a session
 * file may hold, and nothing about any other line changed. Beyond the round
 * trip, two things are worth pinning: that {@code taken} is on the line at all,
 * because a message the turn cap refused and one the run read are two different
 * facts and a reader that cannot tell them apart would report a correction that
 * never happened; and that a reader older than this card meets the line without
 * losing the session around it.</p>
 */
class SteeringMessageAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void aTakenMessageCarriesItsTextItsTurnAndItsAgent() throws Exception {
        String line = JSON.writeValueAsString(new RunEvent.SteeringMessage(
                "main", "use the cached list, not the API", true, 3, 1700L));

        assertTrue(line.contains("\"type\":\"steering_message\""), line);
        assertTrue(line.contains("\"taken\":true"), line);

        RunEvent.SteeringMessage back =
                (RunEvent.SteeringMessage) JSON.readValue(line, RunEvent.class);
        assertEquals("main", back.agentId());
        assertEquals("use the cached list, not the API", back.text());
        assertTrue(back.taken());
        assertEquals(3, back.turn());
        assertEquals(1700L, back.ts());
    }

    @Test
    void aRefusedMessageSaysSoOnTheLineRatherThanByBeingAbsent() throws Exception {
        // Criterion 9: at the turn cap the message loses, and the record says so.
        // Leaving the line out would make "refused" indistinguishable from
        // "nobody ever typed anything".
        String line = JSON.writeValueAsString(new RunEvent.SteeringMessage(
                "main", "too late", false, 15, 1800L));

        assertTrue(line.contains("\"taken\":false"), line);
        assertFalse(line.contains("\"taken\":true"), line);

        RunEvent.SteeringMessage back =
                (RunEvent.SteeringMessage) JSON.readValue(line, RunEvent.class);
        assertFalse(back.taken());
        assertEquals("too late", back.text());
    }

    @Test
    void aSessionFileHoldingOneReadsBackWithEverythingAroundItIntact() throws Exception {
        String id = "steering-message-additivity-test";
        Path file = SessionStore.SESSIONS_DIR.resolve(id + ".jsonl");
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Files.writeString(file, """
                {"type":"run_start","runId":"r1","agentId":"a0","prompt":"go","ts":1}
                {"type":"steering_message","agentId":"a0","text":"use the cache",\
                "taken":true,"turn":2,"ts":2}
                {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":3}
                """, StandardCharsets.UTF_8);

        List<RunEvent> events = SessionStore.readSessionEvents(id);

        assertEquals(3, events.size(), "the new line is a line, not a torn one: " + events);
        RunEvent.SteeringMessage steering = (RunEvent.SteeringMessage) events.get(1);
        assertEquals("use the cache", steering.text());
        assertTrue(steering.taken());
        assertEquals(2, steering.turn());
        Files.deleteIfExists(file);
    }
}
