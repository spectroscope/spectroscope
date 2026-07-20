package dev.spectroscope.cli.voice;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * The voice channel proven WITHOUT any binary: a fake {@link CommandRunner} captures
 * the argv and returns a canned transcript, so the whole flow (argv construction,
 * marker filtering, missing-binary/missing-model errors) is exercised with no ffmpeg,
 * no whisper-cli and no model file present. That is the point of the runner seam.
 */
class TranscriberTest {

    /** Records every command it is asked to run; returns scripted transcription output. */
    private static final class FakeRunner implements CommandRunner {
        final List<List<String>> recorded = new ArrayList<>();
        List<String> transcriptLines = List.of();
        long durationMs = 1234;
        IOException recordFailure;
        IOException transcribeFailure;

        @Override
        public long record(List<String> command, BufferedReader stopSignal) throws IOException {
            recorded.add(command);
            if (recordFailure != null) {
                throw recordFailure;
            }
            return durationMs;
        }

        @Override
        public List<String> runCapturingOutput(List<String> command) throws IOException {
            recorded.add(command);
            if (transcribeFailure != null) {
                throw transcribeFailure;
            }
            return transcriptLines;
        }
    }

    private static Path presentModel(Path dir) throws IOException {
        Path model = dir.resolve("ggml-small.bin");
        Files.writeString(model, "not a real model, just present");
        return model;
    }

    @Test
    void transcribeReturnsTheCleanedTranscriptFromWhisperOutput(@TempDir Path dir) throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.transcriptLines = List.of("  Name three files in the current directory  ");
        Transcriber transcriber = new Transcriber(runner, presentModel(dir));

        Optional<String> text = transcriber.transcribe(dir.resolve("recording.wav"));

        assertEquals(Optional.of("Name three files in the current directory"), text);
    }

    @Test
    void transcribeArgvCarriesModelAutoLanguageAndTheTranscriptFile(@TempDir Path dir) throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.transcriptLines = List.of("hello");
        Path model = presentModel(dir);
        Path wav = dir.resolve("recording.wav");
        Transcriber transcriber = new Transcriber(runner, model);

        transcriber.transcribe(wav);

        List<String> argv = runner.recorded.getFirst();
        assertEquals("whisper-cli", argv.getFirst(), "the transcriber runs whisper-cli");
        // model path passed with -m, exactly the file the setup script pins
        assertEquals(model.toString(), argv.get(argv.indexOf("-m") + 1));
        // auto language detection (German dictation must not go through English),
        // no timestamps, no runtime prints, the wav as the input file
        assertEquals("auto", argv.get(argv.indexOf("-l") + 1));
        assertTrue(argv.contains("--no-timestamps"));
        assertTrue(argv.contains("--no-prints"));
        assertEquals(wav.toString(), argv.get(argv.indexOf("-f") + 1));
        // and the transcript is ALSO written to a file next to the wav
        assertTrue(argv.contains("-otxt"));
        assertEquals(wav.resolveSibling("transcript").toString(), argv.get(argv.indexOf("-of") + 1));
    }

    @Test
    void backendLogNoiseIsIgnoredWhenTheTranscriptFileExists(@TempDir Path dir) throws Exception {
        FakeRunner runner = new FakeRunner();
        // Newer whisper/ggml builds spray backend logs onto the process output …
        runner.transcriptLines = List.of(
                "load_backend: loaded BLAS backend", "ggml_metal_init: allocating", "Fake words");
        // … but the -otxt file carries only the spoken text; it wins.
        Files.writeString(dir.resolve("transcript.txt"), "Eins zwei drei, spectroscope Test\n");
        Transcriber transcriber = new Transcriber(runner, presentModel(dir));

        Optional<String> text = transcriber.transcribe(dir.resolve("recording.wav"));

        assertEquals(Optional.of("Eins zwei drei, spectroscope Test"), text);
    }

    @Test
    void nonSpeechMarkerLinesAreDroppedFromTheTranscript(@TempDir Path dir) throws Exception {
        FakeRunner runner = new FakeRunner();
        // whisper-cli prints these even with --no-timestamps — they are not spoken text.
        runner.transcriptLines = List.of("[BLANK_AUDIO]", "(music)", "Actual words here", "  ");
        Transcriber transcriber = new Transcriber(runner, presentModel(dir));

        Optional<String> text = transcriber.transcribe(dir.resolve("recording.wav"));

        assertEquals(Optional.of("Actual words here"), text);
    }

    @Test
    void anEmptyOrMarkerOnlyTranscriptBecomesEmpty(@TempDir Path dir) throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.transcriptLines = List.of("[BLANK_AUDIO]", "   ");
        Transcriber transcriber = new Transcriber(runner, presentModel(dir));

        assertTrue(transcriber.transcribe(dir.resolve("recording.wav")).isEmpty(),
                "silence must never be sent to the agent");
    }

    @Test
    void configuredSttModelPathWinsOverTheDefault() {
        // config.sttModel() (settings hierarchy / SPECTRO_STT_MODEL, already folded
        // by SpectroConfig) wins over the built-in ~/.spectro/models default whenever
        // it is non-blank — settings-productization Task 3.
        assertEquals(Path.of("/custom/models/ggml-medium.bin"),
                Transcriber.modelPath("/custom/models/ggml-medium.bin"));
    }

    @Test
    void aMissingModelFailsWithAMessagePointingAtTheSetupScript(@TempDir Path dir) {
        FakeRunner runner = new FakeRunner();
        Path absentModel = dir.resolve("nope").resolve("ggml-small.bin");
        Transcriber transcriber = new Transcriber(runner, absentModel);

        IOException failure = assertThrows(IOException.class,
                () -> transcriber.transcribe(dir.resolve("recording.wav")));
        assertTrue(failure.getMessage().contains("STT model missing"), failure.getMessage());
        assertTrue(failure.getMessage().contains("scripts/setup-stt.sh"), failure.getMessage());
        assertTrue(runner.recorded.isEmpty(), "no process is started when the model is absent");
    }

    @Test
    void aMissingWhisperBinarySurfacesTheRunnersReadableError(@TempDir Path dir) throws Exception {
        FakeRunner runner = new FakeRunner();
        // What ProcessCommandRunner throws when the binary is not on the PATH.
        runner.transcribeFailure =
                new IOException("whisper-cli not found — run bash scripts/setup-stt.sh.");
        Transcriber transcriber = new Transcriber(runner, presentModel(dir));

        IOException failure = assertThrows(IOException.class,
                () -> transcriber.transcribe(dir.resolve("recording.wav")));
        assertTrue(failure.getMessage().contains("whisper-cli not found"), failure.getMessage());
        assertTrue(failure.getMessage().contains("scripts/setup-stt.sh"), failure.getMessage());
    }

    @Test
    void recordBuildsA16kHzMonoWavArgvAndReportsTheDuration(@TempDir Path dir) throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.durationMs = 3200;
        Path wav = dir.resolve("recording.wav");
        // record() checks the wav exists afterwards — the fake does not write it, so
        // create it here to isolate the argv/duration assertions from that guard.
        Files.writeString(wav, "fake wav bytes");
        Transcriber transcriber = new Transcriber(runner, presentModel(dir));

        long duration = transcriber.record(wav, new BufferedReader(new java.io.StringReader("\n")));

        assertEquals(3200, duration);
        List<String> argv = runner.recorded.getFirst();
        assertEquals("ffmpeg", argv.getFirst());
        assertEquals("16000", argv.get(argv.indexOf("-ar") + 1), "whisper wants 16 kHz");
        assertEquals("1", argv.get(argv.indexOf("-ac") + 1), "mono");
        assertEquals(wav.toString(), argv.getLast());
    }

    @Test
    void recordRejectsAnEmptyRecordingWithAMicrophoneHint(@TempDir Path dir) throws Exception {
        FakeRunner runner = new FakeRunner();
        Transcriber transcriber = new Transcriber(runner, presentModel(dir));
        // The fake produced no wav file — record() must notice and explain.
        IOException failure = assertThrows(IOException.class,
                () -> transcriber.record(dir.resolve("recording.wav"),
                        new BufferedReader(new java.io.StringReader("\n"))));
        assertTrue(failure.getMessage().contains("No recording produced"), failure.getMessage());
    }

    @Test
    void voiceInputConfirmationAllowsEditingBeforeSending(@TempDir Path dir) throws Exception {
        // voiceInput() records into its own temp wav, then transcribes it. The fake
        // record() writes to whatever wav path it is handed so record()'s existence
        // guard passes; runCapturingOutput returns the raw transcript. The reader
        // supplies [Enter to stop], then the correction typed at the confirmation prompt.
        CommandRunner runner = new CommandRunner() {
            @Override
            public long record(List<String> command, BufferedReader stopSignal) throws IOException {
                stopSignal.readLine();
                Files.writeString(Path.of(command.getLast()), "fake wav");
                return 2500;
            }

            @Override
            public List<String> runCapturingOutput(List<String> command) {
                return List.of("read the readme");
            }
        };
        Transcriber transcriber = new Transcriber(runner, presentModel(dir));

        BufferedReader reader = new BufferedReader(new java.io.StringReader(
                "\n" + "delete the readme\n")); // stop, then a typed correction
        Optional<String> confirmed = transcriber.voiceInput(reader);

        assertEquals(Optional.of("delete the readme"), confirmed,
                "a typed line replaces the transcript — the human stays the editor");
        assertEquals(2500, transcriber.lastDurationMs());
    }

    @Test
    void voiceInputBlankLineSendsTheTranscriptUnchanged(@TempDir Path dir) throws Exception {
        CommandRunner runner = new CommandRunner() {
            @Override
            public long record(List<String> command, BufferedReader stopSignal) throws IOException {
                stopSignal.readLine();
                Files.writeString(Path.of(command.getLast()), "fake wav");
                return 1000;
            }

            @Override
            public List<String> runCapturingOutput(List<String> command) {
                return List.of("what is in the readme");
            }
        };
        Transcriber transcriber = new Transcriber(runner, presentModel(dir));

        // stop, then a blank line at the confirmation prompt = send unchanged.
        BufferedReader reader = new BufferedReader(new java.io.StringReader("\n\n"));
        Optional<String> confirmed = transcriber.voiceInput(reader);

        assertEquals(Optional.of("what is in the readme"), confirmed);
    }

    @Test
    void voiceInputEmptyTranscriptSendsNothing(@TempDir Path dir) throws Exception {
        CommandRunner runner = new CommandRunner() {
            @Override
            public long record(List<String> command, BufferedReader stopSignal) throws IOException {
                stopSignal.readLine();
                Files.writeString(Path.of(command.getLast()), "fake wav");
                return 500;
            }

            @Override
            public List<String> runCapturingOutput(List<String> command) {
                return List.of("[BLANK_AUDIO]");       // silence
            }
        };
        Transcriber transcriber = new Transcriber(runner, presentModel(dir));

        BufferedReader reader = new BufferedReader(new java.io.StringReader("\n"));
        Optional<String> confirmed = transcriber.voiceInput(reader);

        assertFalse(confirmed.isPresent(), "an empty transcript starts no turn");
    }
}
