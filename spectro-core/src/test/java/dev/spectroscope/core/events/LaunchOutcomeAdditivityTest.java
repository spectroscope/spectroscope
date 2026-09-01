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
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 337: what a press of the play button leaves behind, on the wire.
 *
 * <p>The event is ADDITIVE — a subtype the sealed union gained, a line a session
 * file may hold, and nothing about any other line changed. Two things are worth
 * pinning beyond "it round-trips": that the two booleans stay two, because card
 * 202's split has a configuration UP while the browser deliberately stayed away
 * and one boolean reports that as a dead server; and that a reader older than
 * this card meets the line without losing the session, which is what the store's
 * torn-line tolerance is for.
 */
class LaunchOutcomeAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void aCleanPlayCarriesItsAddressAndSaysNothingWentWrong() throws Exception {
        String line = JSON.writeValueAsString(new RunEvent.LaunchOutcome(
                "dev", true, true, "http://localhost:5173/", null, 812L, 99L));

        assertTrue(line.contains("\"type\":\"launch_outcome\""), line);
        assertFalse(line.contains("problem"),
                "nothing went wrong, so the key is absent rather than null: " + line);

        RunEvent.LaunchOutcome back = (RunEvent.LaunchOutcome) JSON.readValue(line, RunEvent.class);
        assertEquals("dev", back.name());
        assertTrue(back.ok());
        assertTrue(back.up());
        assertEquals("http://localhost:5173/", back.url());
        assertNull(back.problem());
        assertEquals(812L, back.durationMs());
    }

    @Test
    void aFailureCarriesTheSentenceAndClaimsNoAddress() throws Exception {
        String line = JSON.writeValueAsString(new RunEvent.LaunchOutcome(
                "dev", false, false, null,
                "it exited with code 143 before http://localhost:8080/ answered", 45_000L, 99L));

        assertFalse(line.contains("\"url\""),
                "the browser went nowhere, so no address is claimed: " + line);

        RunEvent.LaunchOutcome back = (RunEvent.LaunchOutcome) JSON.readValue(line, RunEvent.class);
        assertFalse(back.ok());
        assertFalse(back.up());
        assertNull(back.url());
        assertTrue(back.problem().contains("143"));
    }

    @Test
    void upAndOkAreTwoFactsBecauseTheServerCanBeUpWithTheBrowserKeptAway() throws Exception {
        // Card 202's split. A single boolean here would report a running dev
        // server as a dead one, and send its operator looking in the wrong place
        // — which is the same defect card 286 measured on the sentence.
        RunEvent.LaunchOutcome fenced = new RunEvent.LaunchOutcome("dev", false, true, null,
                "refused localhost: allowLocalhost is off.", 300L, 99L);

        String line = JSON.writeValueAsString(fenced);
        assertTrue(line.contains("\"ok\":false"), line);
        assertTrue(line.contains("\"up\":true"), line);

        RunEvent.LaunchOutcome back = (RunEvent.LaunchOutcome) JSON.readValue(line, RunEvent.class);
        assertFalse(back.ok(), "the press did not do what it promised");
        assertTrue(back.up(), "and the configuration is nevertheless running");
    }

    @Test
    void aSessionFileHoldingOneReadsBackWithEverythingAroundItIntact() throws Exception {
        // The line is written to the record before it is mirrored to a socket,
        // so the reader has to take it out of an ordinary session file — beside
        // events that existed before this card, in order.
        String id = "launch-outcome-additivity-test";
        Path file = SessionStore.SESSIONS_DIR.resolve(id + ".jsonl");
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Files.writeString(file, """
                {"type":"run_start","runId":"r1","agentId":"a0","prompt":"go","ts":1}
                {"type":"launch_outcome","name":"dev","ok":false,"up":false,\
                "problem":"nothing answered there","durationMs":45000,"ts":2}
                {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":3}
                """, StandardCharsets.UTF_8);

        List<RunEvent> events = SessionStore.readSessionEvents(id);

        assertEquals(3, events.size(), "the new line is a line, not a torn one: " + events);
        RunEvent.LaunchOutcome outcome = (RunEvent.LaunchOutcome) events.get(1);
        assertEquals("dev", outcome.name());
        assertEquals("nothing answered there", outcome.problem());
        assertNull(outcome.url());
        Files.deleteIfExists(file);
    }
}
