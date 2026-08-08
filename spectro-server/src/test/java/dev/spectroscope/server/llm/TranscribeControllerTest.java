package dev.spectroscope.server.llm;

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

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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
        IOException refuse; // set to make the child fail the way a real one does
        final List<List<String>> commands = new ArrayList<>();

        @Override
        public long record(List<String> command, BufferedReader stopSignal) {
            throw new UnsupportedOperationException("the server never records");
        }

        @Override
        public List<String> runCapturingOutput(List<String> command) throws IOException {
            commands.add(command);
            if (refuse != null) {
                throw refuse;
            }
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

    // ---- the hosted route (card 187, the correction) -----------------------

    /** Stands in for the transcription API: no network, no key, no account. */
    private static final class FakeHosted implements HostedStt {
        byte[] posted;
        String keyUsed;
        String languageUsed;
        String answer = "{\"text\":\"hello from the hosted one\"}";
        IOException refuse;

        @Override
        public String post(byte[] wav, String key, String language) throws IOException {
            posted = wav;
            keyUsed = key;
            languageUsed = language;
            if (refuse != null) {
                throw refuse;
            }
            return answer;
        }

        @Override
        public String model() {
            return "gpt-transcribe";
        }
    }

    /**
     * The point of the whole correction: a machine with NO whisper and NO model
     * transcribes anyway. Before this, `sttReady` gated every call, so the one
     * reader a DMG exists for got a 503 telling them to run a shell script.
     */
    @Test
    void theHostedRouteTranscribesOnAMachineWithNothingInstalled(@TempDir Path dir) {
        FakeHosted hosted = new FakeHosted();
        Path noModel = dir.resolve("nothing-here.bin");
        TranscribeController controller = new TranscribeController(
                new FakeRunner(), noModel, true, null,
                () -> new TranscribeController.Choice(SttRoute.HOSTED, "sk-test", hosted, "auto"));

        ResponseEntity<Map<String, Object>> response = controller.transcribe(VoiceFixtures.clip());

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("hello from the hosted one", response.getBody().get("text"));
        assertArrayEquals(VoiceFixtures.clip(), hosted.posted,
                "the browser's own bytes travel on, unrewritten — one encoder, two destinations");
        assertEquals("sk-test", hosted.keyUsed);
    }

    /** The sttLanguage setting reaches whisper-cli as {@code -l <code>}. */
    @Test
    void theConfiguredLanguageReachesWhisperCli(@TempDir Path dir) throws IOException {
        FakeRunner runner = new FakeRunner();
        TranscribeController controller = new TranscribeController(
                runner, presentModel(dir), true, null,
                () -> new TranscribeController.Choice(SttRoute.LOCAL, "", new FakeHosted(), "de"));

        controller.transcribe(VoiceFixtures.clip());

        List<String> argv = runner.commands.getFirst();
        assertEquals("de", argv.get(argv.indexOf("-l") + 1),
                "sttLanguage=de must pin whisper to German: " + argv);
    }

    /** And "auto" keeps the request whisper always got: {@code -l auto}. */
    @Test
    void autoKeepsWhisperOnAutoDetection(@TempDir Path dir) throws IOException {
        FakeRunner runner = new FakeRunner();
        TranscribeController controller = new TranscribeController(
                runner, presentModel(dir), true, null,
                () -> new TranscribeController.Choice(SttRoute.LOCAL, "", new FakeHosted(), "auto"));

        controller.transcribe(VoiceFixtures.clip());

        List<String> argv = runner.commands.getFirst();
        assertEquals("auto", argv.get(argv.indexOf("-l") + 1),
                "sttLanguage=auto must leave detection to the model: " + argv);
    }

    /** The same setting reaches the hosted provider on its route. */
    @Test
    void theConfiguredLanguageReachesTheHostedProvider(@TempDir Path dir) {
        FakeHosted hosted = new FakeHosted();
        TranscribeController controller = new TranscribeController(
                new FakeRunner(), dir.resolve("nothing-here.bin"), true, null,
                () -> new TranscribeController.Choice(SttRoute.HOSTED, "sk-test", hosted, "de"));

        controller.transcribe(VoiceFixtures.clip());

        assertEquals("de", hosted.languageUsed,
                "the hosted call must carry the configured language");
    }

    @Test
    void theHostedRouteWithoutAKeySaysSoRatherThanNamingTheSetupScript(@TempDir Path dir) {
        TranscribeController controller = new TranscribeController(
                new FakeRunner(), presentModelQuietly(dir), true, null,
                () -> new TranscribeController.Choice(SttRoute.HOSTED, "", new FakeHosted(), "auto"));

        ResponseEntity<Map<String, Object>> response = controller.transcribe(VoiceFixtures.clip());

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode());
        String error = String.valueOf(response.getBody().get("error"));
        assertTrue(error.contains("OPENAI_API_KEY"), error);
        assertFalse(error.contains("setup-stt.sh"),
                "that sentence belongs to the other route: " + error);
    }

    @Test
    void aRefusalFromTheApiComesBackAsItsOwnSentenceAndAs502(@TempDir Path dir) {
        // Replaced, not loosened: this test used to pin 503 for EVERY hosted
        // failure, and 503 is the number the browser reads as "STT is not set
        // up" -- it removes the microphone button until reload. One transient
        // 429 from the provider therefore killed voice for the session. The
        // far side failing is 502; the sentence still travels.
        FakeHosted hosted = new FakeHosted();
        hosted.refuse = new IOException("Transcription failed with HTTP 401 — Incorrect API key provided");
        TranscribeController controller = new TranscribeController(
                new FakeRunner(), dir.resolve("none"), true, null,
                () -> new TranscribeController.Choice(SttRoute.HOSTED, "sk-bad", hosted, "auto"));

        ResponseEntity<Map<String, Object>> response = controller.transcribe(VoiceFixtures.clip());

        assertEquals(HttpStatus.BAD_GATEWAY, response.getStatusCode());
        assertTrue(String.valueOf(response.getBody().get("error")).contains("401"),
                response.getBody().toString());
    }

    @Test
    void aLocalRouteFailureStays503BecauseThatOneIsSetup(@TempDir Path dir) throws IOException {
        // The other half of the split: a local whisper-cli that cannot run IS
        // a setup problem, and 503 is what routes the reader to the pane with
        // the fix.
        FakeRunner runner = new FakeRunner();
        runner.refuse = new IOException("whisper-cli: model file is unreadable");
        TranscribeController controller = new TranscribeController(
                runner, presentModel(dir), true, null,
                () -> new TranscribeController.Choice(SttRoute.LOCAL, "", new FakeHosted(), "auto"));

        ResponseEntity<Map<String, Object>> response = controller.transcribe(VoiceFixtures.clip());

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode());
    }

    private static Path presentModelQuietly(Path dir) {
        try {
            return presentModel(dir);
        } catch (IOException impossible) {
            throw new IllegalStateException(impossible);
        }
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
