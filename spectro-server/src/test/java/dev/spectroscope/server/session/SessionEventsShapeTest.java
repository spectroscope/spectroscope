package dev.spectroscope.server.session;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * GET /api/sessions/{id}/events: the id is the one caller input that becomes
 * a file name. The store itself refuses traversal ids (SessionStoreTest);
 * here the controller's edge rule is pinned — the same session-id shape check
 * export and delete already wear, so every id-taking edge refuses before the
 * store is asked.
 *
 * <p>The Gradle test task points {@code user.home} into the build directory,
 * so SESSIONS_DIR never touches the real home.</p>
 */
class SessionEventsShapeTest {

    private final SessionsController controller = new SessionsController();

    @Test
    void eventsServesAStoredSession() {
        String id = "test-" + UUID.randomUUID().toString().substring(0, 8);
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "hi", null, null, 1L));

        assertThat(controller.events(id).getStatusCode().value()).isEqualTo(200);
        assertThat(controller.events(id).getBody()).hasSize(1);
    }

    @Test
    void eventsRefusesIdsOutsideTheSessionIdShape() throws Exception {
        // A contained but out-of-shape name: without the edge check this reads
        // fine, because the file really is a direct child of the store. The
        // shape check makes events() match export and delete — full-match, so
        // no separator and no dot can pass.
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Path oddball = SessionStore.SESSIONS_DIR.resolve("odd_ball.jsonl");
        Files.writeString(oddball, "{}\n");
        try {
            assertThat(controller.events("odd_ball").getStatusCode().value()).isEqualTo(404);
            assertThat(controller.events("../decoy").getStatusCode().value()).isEqualTo(404);
            assertThat(controller.events("").getStatusCode().value()).isEqualTo(404);
        } finally {
            Files.deleteIfExists(oddball);
        }
    }
}
