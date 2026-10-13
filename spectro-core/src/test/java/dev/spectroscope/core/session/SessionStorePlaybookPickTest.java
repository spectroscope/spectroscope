package dev.spectroscope.core.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 554, criterion 8e: the playbook a session picked is a line of its own
 * file, the last one wins, a wake reads it back, and the session list shows
 * it before a wake.
 */
class SessionStorePlaybookPickTest {

    private static final String ID = "session-store-playbook-pick-test";
    private static final String OTHER = "session-store-playbook-pick-none";

    private static final String RUN = """
            {"type":"run_start","runId":"r1","agentId":"main","prompt":"ALPHA","ts":1}
            {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":2}
            """;

    private static void write(String id, String body) throws Exception {
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Files.writeString(SessionStore.sessionFile(id), body, StandardCharsets.UTF_8);
    }

    @AfterEach
    void removeFiles() throws Exception {
        Files.deleteIfExists(SessionStore.sessionFile(ID));
        Files.deleteIfExists(SessionStore.sessionFile(OTHER));
    }

    private static SessionStore.SessionInfo row(String id) {
        return SessionStore.listSessions().stream().filter(s -> s.id().equals(id)).findFirst().orElseThrow();
    }

    @Test
    void theLastPickWinsAndAWithdrawnPickReadsAsNone() throws Exception {
        write(ID, RUN
                + "{\"type\":\"playbook_picked\",\"dir\":\"/pb/one\",\"name\":\"One\",\"ts\":3}\n"
                + "{\"type\":\"playbook_picked\",\"dir\":\"/pb/two\",\"name\":\"Two\",\"ts\":4}\n");
        assertEquals("/pb/two", SessionStore.recordedPlaybook(ID));
        assertEquals("/pb/two", row(ID).playbook(), "the list row shows the pick before a wake");
        assertTrue(new ObjectMapper().writeValueAsString(row(ID)).contains("\"playbook\":\"/pb/two\""));

        Files.writeString(SessionStore.sessionFile(ID), "{\"type\":\"playbook_picked\",\"ts\":5}\n",
                StandardCharsets.UTF_8, java.nio.file.StandardOpenOption.APPEND);
        assertNull(SessionStore.recordedPlaybook(ID), "a withdrawn pick is no pick");
        assertNull(row(ID).playbook());
    }

    @Test
    void aSessionThatNeverPickedHasNoPickAndTheRowLeavesTheFieldOut() throws Exception {
        write(OTHER, RUN);
        assertNull(SessionStore.recordedPlaybook(OTHER));
        assertNull(row(OTHER).playbook());
        assertFalse(new ObjectMapper().writeValueAsString(row(OTHER)).contains("\"playbook\":"),
                "a row without a pick reads as it did before the field");
        assertNull(SessionStore.recordedPlaybook("session-store-playbook-pick-missing"), "no file, no pick");
    }

    /**
     * Card 554, integrator decision b: "No playbook" in the dropdown is a pick
     * of its own. It is recorded, read back apart from a withdrawn pick, and a
     * later pick of a folder ends it.
     */
    @Test
    void anExplicitNoneIsReadBackAsNoneAndALaterPickEndsIt() throws Exception {
        write(ID, RUN
                + "{\"type\":\"playbook_picked\",\"dir\":\"/pb/one\",\"name\":\"One\",\"ts\":3}\n"
                + "{\"type\":\"playbook_picked\",\"none\":true,\"ts\":4}\n");
        assertEquals(new SessionStore.RecordedPick(null, true), SessionStore.recordedPick(ID));
        assertNull(SessionStore.recordedPlaybook(ID), "none names no folder");
        assertNull(row(ID).playbook());

        Files.writeString(SessionStore.sessionFile(ID), "{\"type\":\"playbook_picked\",\"dir\":\"/pb/two\",\"ts\":5}\n",
                StandardCharsets.UTF_8, java.nio.file.StandardOpenOption.APPEND);
        assertEquals(new SessionStore.RecordedPick("/pb/two", false), SessionStore.recordedPick(ID));

        Files.writeString(SessionStore.sessionFile(ID), "{\"type\":\"playbook_picked\",\"ts\":6}\n",
                StandardCharsets.UTF_8, java.nio.file.StandardOpenOption.APPEND);
        assertEquals(new SessionStore.RecordedPick(null, false), SessionStore.recordedPick(ID),
                "a withdrawn pick is no pick and no none");
        assertEquals(new SessionStore.RecordedPick(null, false), SessionStore.recordedPick(OTHER),
                "no file, no pick");
    }

    @Test
    void anExplicitNoneIsALineWithNoneAndNoFolder() throws Exception {
        assertEquals("{\"type\":\"playbook_picked\",\"none\":true,\"ts\":9}",
                new ObjectMapper().writeValueAsString(RunEvent.PlaybookPicked.none(9L)));
        assertEquals("{\"type\":\"playbook_picked\",\"dir\":\"/pb\",\"ts\":9}",
                new ObjectMapper().writeValueAsString(new RunEvent.PlaybookPicked("/pb", null, 9L)),
                "a pick of a folder carries no none");
    }

    @Test
    void thePickLineRoundTripsAndStaysOutOfTheHistory() throws Exception {
        SessionStore store = new SessionStore(ID);
        store.append(new RunEvent.RunStart("r1", "main", null, "ALPHA", "ollama", "qwen3", List.of(), 1L));
        store.append(new RunEvent.PlaybookPicked("/pb/three", "Three", 2L));
        store.append(new RunEvent.RunEnd("r1", "end_turn", 3L));

        String file = Files.readString(SessionStore.sessionFile(ID));
        assertTrue(file.contains("{\"type\":\"playbook_picked\",\"dir\":\"/pb/three\",\"name\":\"Three\",\"ts\":2}"), file);
        assertEquals("/pb/three", SessionStore.recordedPlaybook(ID));
        assertEquals(1, SessionStore.loadSession(ID).size(), "a pick is no message of the history");
        assertTrue(new ObjectMapper().writeValueAsString(new RunEvent.PlaybookPicked(null, null, 9L))
                .equals("{\"type\":\"playbook_picked\",\"ts\":9}"), "a withdrawn pick carries no folder");
    }
}
