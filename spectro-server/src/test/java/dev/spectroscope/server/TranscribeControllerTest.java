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
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The /api/transcribe endpoint proven WITHOUT whisper-cli or a model file: a fake
 * {@link CommandRunner} stands in for the one child process left. Three guarantees
 * matter — a good clip returns its text, a machine without STT gets a clean 503 with
 * the setup hint rather than a stack trace, and audio the model cannot read is refused
 * with a sentence instead of being handed over anyway.
 *
 * <p>Card 187 step 5.4 removed the second child process: the browser now converts its
 * own recording to 16 kHz mono WAV, so the body arrives ready and ffmpeg is gone from
 * this path. {@link #theOnlyChildProcessLeftIsWhisper} is what keeps it gone.</p>
 */
class TranscribeControllerTest {

    /** Whisper returns the canned transcript, and remembers what it was asked to run. */
    private static final class FakeRunner implements CommandRunner {
        List<String> transcriptLines = List.of("what is in the readme");
        final List<List<String>> commands = new ArrayList<>();

        @Override
        public long record(List<String> command, BufferedReader stopSignal) {
            throw new UnsupportedOperationException("the server never records");
        }

        @Override
        public List<String> runCapturingOutput(List<String> command) {
            commands.add(command);
            return transcriptLines;
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

        ResponseEntity<Map<String, Object>> response =
                controller.transcribe(VoiceFixtures.clip());

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("what is in the readme", response.getBody().get("text"));
    }

    /**
     * The whole point of step 5.4: one binary, not two. If a conversion call ever
     * comes back, this fails — which is the only way "ffmpeg is gone" stays true
     * after somebody edits this endpoint a year from now.
     */
    @Test
    void theOnlyChildProcessLeftIsWhisper(@TempDir Path dir) throws IOException {
        FakeRunner runner = new FakeRunner();
        TranscribeController controller =
                new TranscribeController(runner, presentModel(dir), true);

        controller.transcribe(VoiceFixtures.clip());

        assertEquals(1, runner.commands.size(),
                "one child process per recording: " + runner.commands);
        assertEquals("whisper-cli", runner.commands.getFirst().getFirst());
    }

    /**
     * The browser sends WAV now, so anything else is a client that did not convert.
     * Card 184 watched the alternative: unreadable audio went down the pipeline, the
     * failure was swallowed, and whisper's HELP TEXT came back as a 200 "transcript".
     */
    @Test
    void audioTheModelCannotReadIsRefusedWithASentenceAndNoChildProcess(@TempDir Path dir)
            throws IOException {
        FakeRunner runner = new FakeRunner();
        TranscribeController controller =
                new TranscribeController(runner, presentModel(dir), true);
        byte[] webm = {0x1A, 0x45, (byte) 0xDF, (byte) 0xA3, 0, 0, 0, 0, 0, 0, 0, 0};

        ResponseEntity<Map<String, Object>> response = controller.transcribe(webm);

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        assertTrue(String.valueOf(response.getBody().get("error")).contains("WAV"),
                "the answer names what was wrong: " + response.getBody());
        assertTrue(runner.commands.isEmpty(), "nothing was spawned for a body no model can read");
    }

    @Test
    void whenSttIsNotInstalledTheEndpointAnswers503WithTheSetupHint(@TempDir Path dir)
            throws IOException {
        // Availability is flagged false (the production check is "model file present").
        TranscribeController controller =
                new TranscribeController(new FakeRunner(), presentModel(dir), false);

        ResponseEntity<Map<String, Object>> response =
                controller.transcribe(VoiceFixtures.clip());

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode(),
                "STT is optional infrastructure — 503, not 500");
        assertTrue(String.valueOf(response.getBody().get("error")).contains("scripts/setup-stt.sh"),
                "the body must point the user at the setup script: " + response.getBody());
    }

    @Test
    void aMissingModelAlsoDegradesTo503RatherThanAStackTrace(@TempDir Path dir) {
        // available=true but the model file is absent: transcribe() throws a readable
        // IOException, which the controller turns into a 503 with the hint.
        Path absentModel = dir.resolve("gone").resolve("ggml-small.bin");
        TranscribeController controller =
                new TranscribeController(new FakeRunner(), absentModel, true);

        ResponseEntity<Map<String, Object>> response =
                controller.transcribe(VoiceFixtures.clip());

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode());
        assertTrue(String.valueOf(response.getBody().get("error")).contains("scripts/setup-stt.sh"),
                response.getBody().toString());
    }
}
