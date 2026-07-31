package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Session export (card 95): the raw JSONL download that mirrors the existing
 * import. Byte-identical by construction (the stored file is served verbatim),
 * fenced like every other local endpoint, and — because the id becomes a file
 * name — refusing anything that is not a plain session id.
 */
class SessionExportTest {

    private final SessionsController controller = new SessionsController();

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    @Test
    void refusesAPathTraversalId() {
        // The id lands in a file path; "../.." must never escape the store.
        for (String evil : new String[] {"../secrets", "..", "a/b", "a.jsonl", "" }) {
            ResponseEntity<?> res = controller.exportSession(evil, local());
            assertTrue(res.getStatusCode().value() == 404 || res.getStatusCode().value() == 400,
                    "id \"" + evil + "\" must be refused, got " + res.getStatusCode());
        }
    }

    @Test
    void refusesAForeignCaller() {
        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        assertEquals(404, controller.exportSession("20260725-120000-abcdef12", rebound)
                .getStatusCode().value());
        MockHttpServletRequest remote = local();
        remote.setRemoteAddr("203.0.113.7");
        assertEquals(404, controller.exportSession("20260725-120000-abcdef12", remote)
                .getStatusCode().value());
    }

    @Test
    void answersNotFoundForAnUnknownButWellShapedId() {
        ResponseEntity<?> res = controller.exportSession("20260725-000000-deadbeef", local());
        assertEquals(404, res.getStatusCode().value());
        assertNull(res.getBody());
    }

    @Test
    void servesAStoredSessionVerbatimAsADownload() throws Exception {
        // Write a real session through the store, then export it: the bytes
        // must come back unchanged, so a re-import is a perfect round trip.
        dev.spectroscope.core.session.SessionStore store =
                new dev.spectroscope.core.session.SessionStore();
        store.append(new dev.spectroscope.core.events.RunEvent.RunStart(
                "r1", "main", null, "hello", "anthropic", null, 1L));
        store.append(new dev.spectroscope.core.events.RunEvent.RunEnd("r1", "end_turn", 2L));

        ResponseEntity<?> res = controller.exportSession(store.id(), local());
        assertEquals(200, res.getStatusCode().value());
        String body = String.valueOf(res.getBody());
        String onDisk = java.nio.file.Files.readString(
                dev.spectroscope.core.session.SessionStore.SESSIONS_DIR.resolve(store.id() + ".jsonl"));
        assertEquals(onDisk, body, "the export is the stored file, byte for byte");
        assertTrue(body.contains("\"run_start\""));

        String disposition = res.getHeaders().getFirst("Content-Disposition");
        assertNotNull(disposition);
        assertTrue(disposition.contains(store.id() + ".jsonl"), "downloads with its session name");

        java.nio.file.Files.deleteIfExists(
                dev.spectroscope.core.session.SessionStore.SESSIONS_DIR.resolve(store.id() + ".jsonl"));
    }
}
