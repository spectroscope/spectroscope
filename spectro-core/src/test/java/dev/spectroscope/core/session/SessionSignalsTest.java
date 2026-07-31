package dev.spectroscope.core.session;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * The overview row's SIGNAL fields: model, how the last run stopped, whether
 * the gate opened, and when the file goes quiet. The sidebar draws a glyph per
 * row from these, so every one of them has to come out of the fold that
 * already reads the file — a second read per row would cost one file open per
 * listed session on every refresh.
 *
 * <p>The Gradle test task points {@code user.home} into the build directory,
 * so SESSIONS_DIR never touches the real home.</p>
 */
class SessionSignalsTest {

    private static String freshId() {
        return "sig-" + UUID.randomUUID().toString().substring(0, 8);
    }

    private static SessionStore.SessionInfo info(String id) {
        return SessionStore.listSessions().stream()
                .filter(session -> session.id().equals(id))
                .findFirst().orElseThrow();
    }

    @Test
    void reportsTheModelAndHowTheRunStopped() {
        String id = freshId();
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "hi", "anthropic",
                "claude-sonnet-5", null, 10L));
        store.append(new RunEvent.TurnStart("main", 1, 11L));
        store.append(new RunEvent.RunEnd("r1", "end_turn", 12L));

        SessionStore.SessionInfo row = info(id);
        assertEquals("claude-sonnet-5", row.model());
        assertEquals("end_turn", row.stopReason());
        assertEquals(12L, row.endedAt(), "the last event's ts is when the file went quiet");
    }

    @Test
    void theLastMainRunDecidesTheStopReason() {
        String id = freshId();
        SessionStore store = new SessionStore(id);
        // Two prompts in one session: the first ended cleanly, the second failed.
        store.append(new RunEvent.RunStart("r1", "main", null, "first", "ollama", null, 1L));
        store.append(new RunEvent.RunEnd("r1", "end_turn", 2L));
        store.append(new RunEvent.RunStart("r2", "main", null, "second", "ollama", null, 3L));
        store.append(new RunEvent.ErrorEvent("main", "connection reset", 4L));
        store.append(new RunEvent.RunEnd("r2", "error", 5L));

        assertEquals("error", info(id).stopReason(),
                "a session reads by how it ENDED, not by its first clean run");
    }

    @Test
    void aSubagentsRunEndNeverDecidesTheSessionsStopReason() {
        String id = freshId();
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "fan out", "ollama", null, 1L));
        store.append(new RunEvent.AgentSpawn("worker-1", "main", "sub", 2L));
        store.append(new RunEvent.RunStart("r2", "worker-1", "main", "sub", "ollama", null, 3L));
        store.append(new RunEvent.RunEnd("r2", "error", 4L));
        store.append(new RunEvent.RunEnd("r1", "end_turn", 5L));

        assertEquals("end_turn", info(id).stopReason(),
                "the subagent failed, the session did not");
    }

    @Test
    void aRunWithoutItsRunEndHasNoStopReason() {
        String id = freshId();
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "killed mid-run", "ollama", null, 1L));
        store.append(new RunEvent.TurnStart("main", 1, 2L));

        assertNull(info(id).stopReason(),
                "the process died before the run_end — absent is the honest answer");
    }

    @Test
    void countsGateStopsAndDenials() {
        String id = freshId();
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "write files", "ollama", null, 1L));
        store.append(new RunEvent.PermissionRequest("main", "c1", "write_file", null, 2L));
        store.append(new RunEvent.PermissionDecision("c1", true, 3L));
        store.append(new RunEvent.PermissionRequest("main", "c2", "run_command", null, 4L));
        store.append(new RunEvent.PermissionDecision("c2", false, 5L));
        store.append(new RunEvent.RunEnd("r1", "end_turn", 6L));

        SessionStore.SessionInfo row = info(id);
        assertEquals(2, row.gateCount(), "both calls stopped at the gate");
        assertEquals(1, row.denyCount(), "one of them was refused");
    }

    @Test
    void aSessionThatNeverHitTheGateReportsZero() {
        String id = freshId();
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "just talk", "ollama", null, 1L));
        store.append(new RunEvent.RunEnd("r1", "end_turn", 2L));

        SessionStore.SessionInfo row = info(id);
        assertEquals(0, row.gateCount());
        assertEquals(0, row.denyCount());
        assertNull(row.model(), "a session recorded before card 87 has no model on the wire");
    }
}
