package dev.spectroscope.server;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The native folder picker endpoint, proven through the dialog seam — no real
 * osascript, no real dialog: a pick answers the path, a cancel answers 204,
 * a platform without a dialog answers 501, a broken dialog answers 500.
 */
class WorkspacePickControllerTest {

    @Test
    void aPickAnswersThePath() {
        var controller = new WorkspacePickController(() -> Optional.of("/Users/me/playground"));
        var response = controller.pick();
        assertEquals(200, response.getStatusCode().value());
        assertEquals(Map.of("path", "/Users/me/playground"), response.getBody());
    }

    @Test
    void aCancelAnswersNoContent() {
        var controller = new WorkspacePickController(Optional::empty);
        assertEquals(204, controller.pick().getStatusCode().value());
    }

    @Test
    void aPlatformWithoutADialogAnswers501() {
        var controller = new WorkspacePickController(() -> {
            throw new UnsupportedOperationException("The native folder picker needs macOS.");
        });
        assertEquals(501, controller.pick().getStatusCode().value());
    }

    @Test
    void aFailingDialogAnswers500() {
        var controller = new WorkspacePickController(() -> {
            throw new IOException("osascript exploded");
        });
        assertEquals(500, controller.pick().getStatusCode().value());
    }
}
