package dev.spectroscope.server;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The one destructive REST endpoint: DELETE /api/sessions/{id}. The store
 * itself proves the path jail in SessionStoreTest; here the contract of the
 * controller is pinned — status codes and the id-shape guard.
 *
 * <p>The Gradle test task points {@code user.home} into the build directory,
 * so SESSIONS_DIR never touches the real home.</p>
 */
class SessionDeleteTest {

    private final SessionsController controller = new SessionsController();

    private static String storedSession() {
        String id = "test-" + UUID.randomUUID().toString().substring(0, 8);
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "hi", null, null, 1L));
        return id;
    }

    @Test
    void deletesAStoredSessionWith204AndItIsGoneFromDiskAndList() {
        String id = storedSession();
        Path file = SessionStore.SESSIONS_DIR.resolve(id + ".jsonl");
        assertThat(Files.exists(file)).isTrue();

        assertThat(controller.deleteSession(id).getStatusCode().value()).isEqualTo(204);

        assertThat(Files.notExists(file)).isTrue();
        assertThat(controller.sessions()).noneMatch(info -> info.id().equals(id));
    }

    @Test
    void unknownIdAnswers404() {
        assertThat(controller.deleteSession("test-doesnotexist").getStatusCode().value())
                .isEqualTo(404);
    }

    @Test
    void nonSessionShapesAnswer400WithoutTouchingTheStore() {
        assertThat(controller.deleteSession("..%2Fdecoy").getStatusCode().value()).isEqualTo(400);
        assertThat(controller.deleteSession(".hidden").getStatusCode().value()).isEqualTo(400);
        assertThat(controller.deleteSession("a b").getStatusCode().value()).isEqualTo(400);
    }
}
