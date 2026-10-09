package dev.spectroscope.server.observability;

import dev.spectroscope.core.wire.LlmWireRecorder;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 473, the server half of the import's local fallback: an imported plain
 * JSONL whose referenced wire exists on this machine asks
 * {@code GET /api/sessions/{id}/llm-wire} for it. The endpoint answers only for
 * a name of the id shape whose file lies in {@code ~/.spectro/llm-wire/}
 * itself, and never follows a name with a slash or a dot segment, nor a link
 * that leads out of the folder.
 */
class LlmWireLocalFallbackTest {

    private final LlmWireController controller = new LlmWireController();

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    @Test
    void theFallbackServesAWellShapedNameFromTheWireFolder() throws Exception {
        String id = "test-fallback-" + UUID.randomUUID().toString().substring(0, 8);
        Path file = LlmWireRecorder.fileFor(id);
        Files.createDirectories(file.getParent());
        Files.writeString(file, "{\"type\":\"llm_request\",\"xid\":\"x\",\"ts\":1}\n");
        try {
            ResponseEntity<String> res = controller.download(id, local());
            assertEquals(200, res.getStatusCode().value());
            assertEquals(Files.readString(file), res.getBody());
        } finally {
            Files.deleteIfExists(file);
        }
    }

    @Test
    void aWireWithATornMultibyteTailIsStillServed() throws Exception {
        // A crash mid-write (card 406) can leave half a UTF-8 character at the
        // end. The reader skips that line; the endpoint must not answer "not
        // found" for the whole wire because of it.
        String id = "test-fallback-torn-" + UUID.randomUUID().toString().substring(0, 8);
        Path file = LlmWireRecorder.fileFor(id);
        Files.createDirectories(file.getParent());
        String whole = "{\"type\":\"llm_request\",\"xid\":\"x\",\"body\":\"Gr\u00fc\u00df\",\"ts\":1}\n";
        byte[] good = whole.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] torn = "{\"type\":\"llm_request\",\"body\":\"\u00e4".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] bytes = new byte[good.length + torn.length - 1]; // the last byte of the umlaut is cut
        System.arraycopy(good, 0, bytes, 0, good.length);
        System.arraycopy(torn, 0, bytes, good.length, torn.length - 1);
        Files.write(file, bytes);
        try {
            ResponseEntity<String> res = controller.download(id, local());
            assertEquals(200, res.getStatusCode().value(), "a torn tail is not a missing wire");
            assertEquals(whole, res.getBody().substring(0, whole.length()),
                    "every whole line is served as written");
        } finally {
            Files.deleteIfExists(file);
        }
    }

    @Test
    void theFallbackRefusesAPathShapedName() {
        for (String evil : new String[] {"..", ".", "../secrets", "a/b", "/etc/passwd", "a.llm.jsonl",
                "..%2Fx", "%2e%2e", "x/../y", ""}) {
            ResponseEntity<String> res = controller.download(evil, local());
            assertEquals(404, res.getStatusCode().value(), "name \"" + evil + "\" must be refused");
        }
    }

    @Test
    void theFallbackDoesNotFollowALinkOutOfTheWireFolder() throws Exception {
        // A well-shaped name whose file is a symbolic link to a file outside
        // the folder: the name passes the shape check, so only a check on the
        // file itself keeps the read inside ~/.spectro/llm-wire/.
        String id = "test-fallback-link-" + UUID.randomUUID().toString().substring(0, 8);
        Path link = LlmWireRecorder.fileFor(id);
        Files.createDirectories(link.getParent());
        Path outside = Files.createTempFile("outside-the-wire-folder", ".txt");
        Files.writeString(outside, "not a wire");
        Files.createSymbolicLink(link, outside);
        try {
            assertEquals(404, controller.download(id, local()).getStatusCode().value(),
                    "a link out of the folder is not a wire");
            assertEquals(404, controller.index(id, local()).getStatusCode().value());
        } finally {
            Files.deleteIfExists(link);
            Files.deleteIfExists(outside);
        }
    }
}
