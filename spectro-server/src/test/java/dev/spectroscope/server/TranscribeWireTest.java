package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.cli.voice.CommandRunner;
import dev.spectroscope.core.wire.LlmWireRecorder;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 184, the stt leg: the spoken bytes ARE a model exchange, so a transcribe
 * call leaves an llm-wire record — the recording verbatim (base64) on the
 * request line, whisper's transcript on the response line, and the failure path
 * honest about its status.
 */
class TranscribeWireTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Same fake as TranscribeControllerTest: ffmpeg writes the wav, whisper answers. */
    private static final class FakeRunner implements CommandRunner {
        @Override
        public long record(List<String> command, BufferedReader stopSignal) {
            throw new UnsupportedOperationException("the server never records");
        }

        @Override
        public List<String> runCapturingOutput(List<String> command) throws IOException {
            if (command.contains("-i")) {
                Files.writeString(Path.of(command.getLast()), "fake wav bytes");
                return List.of();
            }
            return List.of("hallo spectroscope");
        }
    }

    @Test
    void aTranscribeCallRecordsAudioBytesAndTranscript(@TempDir Path dir) throws Exception {
        Path wireFile = dir.resolve("stt.llm.jsonl");
        Path model = dir.resolve("ggml-small.bin");
        Files.writeString(model, "present");
        byte[] audio = "webm opus bytes".getBytes();
        try (LlmWireRecorder recorder = new LlmWireRecorder(wireFile, 1_000_000)) {
            TranscribeController controller =
                    new TranscribeController(new FakeRunner(), model, true, recorder);
            controller.transcribe(audio);
        }

        List<String> lines = Files.readAllLines(wireFile);
        assertEquals(2, lines.size());
        JsonNode request = JSON.readTree(lines.get(0));
        JsonNode response = JSON.readTree(lines.get(1));

        assertEquals("stt", request.get("kind").asText());
        // "encoded": the base64 is the recording's own, no socket carried it —
        // and a process pipeline has no HTTP method to claim.
        assertEquals("encoded", request.get("fidelity").asText());
        assertNull(request.get("method"));
        assertEquals("composer", request.get("agentId").asText());
        assertEquals("whisper-cpp", request.get("provider").asText());
        assertEquals("ggml-small.bin", request.get("model").asText());
        // The spoken bytes ride VERBATIM, base64-encoded for the JSON line.
        assertEquals(Base64.getEncoder().encodeToString(audio), request.get("body").asText());

        assertEquals(200, response.get("status").asInt());
        assertEquals("process-output", response.get("fidelity").asText());
        assertEquals("hallo spectroscope", response.get("body").asText());
    }

    @Test
    void aFailedPipelineRecordsTheErrorNotSilence(@TempDir Path dir) throws Exception {
        Path wireFile = dir.resolve("stt-fail.llm.jsonl");
        Path absentModel = dir.resolve("gone").resolve("ggml-small.bin");
        try (LlmWireRecorder recorder = new LlmWireRecorder(wireFile, 1_000_000)) {
            TranscribeController controller =
                    new TranscribeController(new FakeRunner(), absentModel, true, recorder);
            controller.transcribe("bytes".getBytes());
        }

        List<String> lines = Files.readAllLines(wireFile);
        assertEquals(2, lines.size());
        JsonNode response = JSON.readTree(lines.get(1));
        assertEquals(503, response.get("status").asInt());
        assertTrue(response.get("error").asText().contains("setup-stt"),
                "the record carries the readable cause: " + response.get("error"));
    }
}
