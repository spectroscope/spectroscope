package dev.spectroscope.core.trace;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The first port (KONZEPT §4.3): the JSONL sink is the seam-swapped form of
 * the hard-wired {@code store.append} — same file, same lines, same failure
 * behaviour, just registered instead of inlined.
 *
 * <p>The Gradle test task points {@code user.home} into the build directory,
 * so SESSIONS_DIR never touches the real home.</p>
 */
class JsonlSinkTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void writesEveryEventToTheSessionFileLikeDirectAppend() throws IOException {
        SessionStore store = new SessionStore("test-" + UUID.randomUUID().toString().substring(0, 8));
        JsonlSink sink = new JsonlSink(store);

        sink.onEvent(new RunEvent.RunStart("r1", "main", null, "hi", "anthropic", null, 1L));
        sink.onEvent(new RunEvent.TextDelta("main", "Hello", 2L));

        List<String> lines = Files.readAllLines(store.file(), StandardCharsets.UTF_8);
        assertEquals(2, lines.size());
        assertEquals("run_start", JSON.readTree(lines.get(0)).get("type").asText());
        assertEquals("text_delta", JSON.readTree(lines.get(1)).get("type").asText());
    }
}
