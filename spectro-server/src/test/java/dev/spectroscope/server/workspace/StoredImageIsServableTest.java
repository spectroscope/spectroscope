package dev.spectroscope.server.workspace;

import dev.spectroscope.core.image.ImageStore;
import dev.spectroscope.server.session.SessionsController;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

/**
 * The store and the serve endpoint are two halves of one promise — card 198,
 * AC 5: an attached image is VISIBLE in the session via {@code /api/images/{file}}.
 * They live in different modules and neither compiles against the other's list:
 * {@link ImageStore} decides the extension a blob is written under, and
 * {@code SessionsController.IMAGE_NAME} decides which names may be asked for.
 *
 * <p>This test holds the two together. Widening the store's servable set without
 * teaching the endpoint the new extension turns every such image into a 400 —
 * exactly the gap an {@code image/gif} from an MCP server fell into.
 */
class StoredImageIsServableTest {

    private final SessionsController controller = new SessionsController();

    @Test
    void everyTypeTheStoreCallsServableProducesANameTheEndpointAccepts(@TempDir Path dir) {
        ImageStore store = new ImageStore(dir);

        for (String mediaType : ImageStore.servableMediaTypes()) {
            String fileName = store.put(mediaType.getBytes(StandardCharsets.UTF_8), mediaType)
                    .file().getFileName().toString();

            // 400 is the name contract refusing; 404 is it passing and the blob simply
            // not living under this test's home. Only the first is a broken promise.
            assertNotEquals(400,
                    controller.image(fileName, new MockHttpServletRequest()).getStatusCode().value(),
                    fileName + " (" + mediaType + ") is stored under a name GET /api/images/{file}"
                            + " refuses — the session could never show this image");
        }
    }

    @Test
    void aBlobTheStoreCouldNotNameIsIndeedUnservable(@TempDir Path dir) {
        // The counter-proof, so the test above cannot pass by accepting everything:
        // .bin is what an unservable type stores as, and the endpoint rejects it.
        String fileName = new ImageStore(dir).put(new byte[] {1}, "image/gif")
                .file().getFileName().toString();

        assertEquals(400,
                controller.image(fileName, new MockHttpServletRequest()).getStatusCode().value(),
                fileName + " must not be servable — nothing may be stored under it");
    }
}
