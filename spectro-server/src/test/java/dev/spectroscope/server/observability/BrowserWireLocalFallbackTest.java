package dev.spectroscope.server.observability;

import dev.spectroscope.core.wire.BrowserWireRecorder;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 473: the import's local fallback asks for the browser wire too, by the
 * referenced name, so the browser wire's read endpoints keep the same fence
 * as the llm wire's: a well-shaped name whose file is a link out of
 * {@code ~/.spectro/browser-wire/} is not a wire.
 */
class BrowserWireLocalFallbackTest {

    private final BrowserWireController controller = new BrowserWireController();

    @Test
    void aWireWithATornMultibyteTailIsStillServed() throws Exception {
        String id = "test-bfallback-torn-" + UUID.randomUUID().toString().substring(0, 8);
        Path file = BrowserWireRecorder.fileFor(id);
        Files.createDirectories(file.getParent());
        String whole = "{\"type\":\"browser_open\",\"epoch\":1,\"title\":\"\u00fc\",\"ts\":1}\n";
        byte[] good = whole.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] bytes = java.util.Arrays.copyOf(good, good.length + 1);
        bytes[good.length] = (byte) 0xC3; // the first half of a two-byte character
        Files.write(file, bytes);
        try {
            var res = controller.download(id, new MockHttpServletRequest());
            assertEquals(200, res.getStatusCode().value(), "a torn tail is not a missing wire");
            assertEquals(whole, res.getBody().substring(0, whole.length()));
        } finally {
            Files.deleteIfExists(file);
        }
    }

    @Test
    void theFallbackServesAWellShapedNameFromTheWireFolder() throws Exception {
        String id = "test-bfallback-" + UUID.randomUUID().toString().substring(0, 8);
        Path file = BrowserWireRecorder.fileFor(id);
        Files.createDirectories(file.getParent());
        Files.writeString(file, "{\"type\":\"browser_open\",\"epoch\":1,\"ts\":1}\n");
        try {
            assertEquals(200, controller.download(id, new MockHttpServletRequest()).getStatusCode().value());
        } finally {
            Files.deleteIfExists(file);
        }
    }

    @Test
    void theFallbackDoesNotFollowALinkOutOfTheWireFolder() throws Exception {
        String id = "test-bfallback-link-" + UUID.randomUUID().toString().substring(0, 8);
        Path link = BrowserWireRecorder.fileFor(id);
        Files.createDirectories(link.getParent());
        Path outside = Files.createTempFile("outside-the-browser-wire-folder", ".txt");
        Files.writeString(outside, "not a wire");
        Files.createSymbolicLink(link, outside);
        try {
            assertEquals(404, controller.download(id, new MockHttpServletRequest()).getStatusCode().value());
            assertEquals(404, controller.index(id, new MockHttpServletRequest()).getStatusCode().value());
        } finally {
            Files.deleteIfExists(link);
            Files.deleteIfExists(outside);
        }
    }
}
