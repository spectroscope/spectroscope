package dev.spectroscope.server;

import dev.spectroscope.cli.voice.CommandRunner;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The /api/transcribe endpoint proven WITHOUT ffmpeg, whisper-cli or a model file:
 * a fake {@link CommandRunner} stands in for both child processes (the webm→wav
 * conversion and whisper). Two guarantees matter — a good clip returns its text, and
 * a machine without STT gets a clean 503 with the setup hint, never a stack trace.
 */
class TranscribeControllerTest {

    /** ffmpeg (conversion) writes the wav; whisper returns the canned transcript. */
    private static final class FakeRunner implements CommandRunner {
        List<String> transcriptLines = List.of("what is in the readme");

        @Override
        public long record(List<String> command, BufferedReader stopSignal) {
            throw new UnsupportedOperationException("the server never records");
        }

        @Override
        public List<String> runCapturingOutput(List<String> command) throws IOException {
            // The conversion step (ffmpeg) ends with the wav path; create it so the
            // subsequent transcribe() sees a file, then return the whisper transcript.
            if (command.contains("-i")) {                 // the ffmpeg conversion call
                Files.writeString(Path.of(command.getLast()), "fake wav bytes");
                return List.of();
            }
            return transcriptLines;                        // the whisper-cli call
        }
    }

    private static Path presentModel(Path dir) throws IOException {
        Path model = dir.resolve("ggml-small.bin");
        Files.writeString(model, "present");
        return model;
    }

    @Test
    void aGoodClipReturnsTheTranscriptAsJson(@TempDir Path dir) throws IOException {
        TranscribeController controller =
                new TranscribeController(new FakeRunner(), presentModel(dir), true);

        ResponseEntity<Map<String, String>> response =
                controller.transcribe("webm bytes".getBytes());

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("what is in the readme", response.getBody().get("text"));
    }

    @Test
    void whenSttIsNotInstalledTheEndpointAnswers503WithTheSetupHint(@TempDir Path dir)
            throws IOException {
        // Availability is flagged false (the production check is "model file present").
        TranscribeController controller =
                new TranscribeController(new FakeRunner(), presentModel(dir), false);

        ResponseEntity<Map<String, String>> response =
                controller.transcribe("webm bytes".getBytes());

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode(),
                "STT is optional infrastructure — 503, not 500");
        assertTrue(response.getBody().get("error").contains("scripts/setup-stt.sh"),
                "the body must point the user at the setup script: " + response.getBody());
    }

    @Test
    void aMissingModelAlsoDegradesTo503RatherThanAStackTrace(@TempDir Path dir) {
        // available=true but the model file is absent: transcribe() throws a readable
        // IOException, which the controller turns into a 503 with the hint.
        Path absentModel = dir.resolve("gone").resolve("ggml-small.bin");
        TranscribeController controller =
                new TranscribeController(new FakeRunner(), absentModel, true);

        ResponseEntity<Map<String, String>> response =
                controller.transcribe("webm bytes".getBytes());

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode());
        assertTrue(response.getBody().get("error").contains("scripts/setup-stt.sh"),
                response.getBody().toString());
    }
}
