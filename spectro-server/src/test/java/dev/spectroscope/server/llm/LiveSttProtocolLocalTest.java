package dev.spectroscope.server.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 527: the local route speaks the same socket as the hosted one, with
 * three frames of its own that say what a whisper run over the open window
 * answered.
 */
class LiveSttProtocolLocalTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private JsonNode parse(String raw) throws Exception {
        return JSON.readTree(raw);
    }

    @Test
    void theLocalHandshakeAsksFor16kHzAndNamesTheStep() throws Exception {
        JsonNode frame = parse(LiveSttProtocol.localSessionUpdate("ggml-small.bin", "en", 2000));
        assertEquals("session.update", frame.path("type").asText());
        assertEquals(16000, frame.path("session").path("audio").path("input").path("format").path("rate").asInt());
        assertEquals("ggml-small.bin", frame.path("session").path("model").asText());
        assertEquals("en", frame.path("session").path("language").asText());
        assertEquals(2000, frame.path("session").path("chunkMs").asLong());
    }

    @Test
    void aChunkRunReadsAsAReplacingPartial() throws Exception {
        String raw = LiveSttProtocol.localResult(LiveSttProtocol.LOCAL_PARTIAL, "hello there", 3, 812, 6000, 1);
        LiveSttProtocol.Incoming read = LiveSttProtocol.read(parse(raw));
        assertEquals(LiveSttProtocol.Kind.REPLACE, read.kind());
        assertEquals("hello there", read.text());
        JsonNode frame = parse(raw);
        assertEquals(3, frame.path("chunk").asInt());
        assertEquals(812, frame.path("durationMs").asLong());
        assertEquals(6000, frame.path("audioMs").asLong());
        assertEquals(1, frame.path("skipped").asInt());
    }

    @Test
    void aClosedWindowReadsAsAWindowFinal() throws Exception {
        LiveSttProtocol.Incoming read = LiveSttProtocol.read(parse(
                LiveSttProtocol.localResult(LiveSttProtocol.LOCAL_WINDOW, "Hello there.", 4, 700, 9000, 0)));
        assertEquals(LiveSttProtocol.Kind.WINDOW, read.kind());
        assertEquals("Hello there.", read.text());
    }

    @Test
    void theLastRunAfterCommitReadsAsTheFinal() throws Exception {
        LiveSttProtocol.Incoming read = LiveSttProtocol.read(parse(
                LiveSttProtocol.localResult(LiveSttProtocol.LOCAL_FINAL, "Bye.", 5, 650, 2000, 0)));
        assertEquals(LiveSttProtocol.Kind.FINAL, read.kind());
        assertEquals("Bye.", read.text());
    }
}
