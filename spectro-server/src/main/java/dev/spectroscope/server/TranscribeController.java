package dev.spectroscope.server;

import dev.spectroscope.cli.voice.CommandRunner;
import dev.spectroscope.cli.voice.ProcessCommandRunner;
import dev.spectroscope.cli.voice.Transcriber;
import dev.spectroscope.core.config.SpectroConfig;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * The web face of voice input: the browser records with MediaRecorder and POSTs the
 * webm/opus bytes here; the server converts them to 16 kHz mono WAV (an ffmpeg child
 * process) and runs the SAME {@link Transcriber} the CLI uses. The transcript comes
 * back as {@code { "text": ... }} and lands in the composer input — never directly at
 * the agent (the same boundary the CLI draws: an STT error is reviewable text, not an
 * agent instruction).
 *
 * <p>Reuse note: {@code Transcriber} lives in spectro-cli, which spectro-server already
 * depends on for the embedded interactive mode, so it is on the classpath here.</p>
 *
 * <p>The process boundary sits behind a {@link CommandRunner} exactly as in the CLI, so
 * this endpoint is testable with a fake runner — no ffmpeg, no whisper-cli, no model on
 * the machine. If STT is not installed the endpoint answers a clean {@code 503} with the
 * setup hint (the composer's mic button shows a tooltip); never a stack trace.</p>
 */
@RestController
public class TranscribeController {

    private final CommandRunner runner;
    private final Transcriber transcriber;
    /** Fast, process-free readiness probe: the pinned model must be present. */
    private final boolean sttAvailable;

    /** Spring wiring: real child processes, the pinned model under ~/.spectro/models. */
    public TranscribeController() {
        this(new ProcessCommandRunner(), defaultModelPath(), Files.exists(defaultModelPath()));
    }

    /**
     * Seam for tests: inject a runner, a model path, and the readiness flag.
     *
     * @param runner the process boundary — a fake keeps ffmpeg/whisper out of tests
     * @param modelPath the whisper model file the transcriber is pointed at
     * @param sttAvailable readiness override — {@code false} makes the endpoint answer 503
     */
    TranscribeController(CommandRunner runner, Path modelPath, boolean sttAvailable) {
        this.runner = runner;
        this.transcriber = new Transcriber(runner, modelPath);
        this.sttAvailable = sttAvailable;
    }

    /**
     * The pinned STT model location: the settings hierarchy
     * ({@code SpectroConfig.sttModel()}, which already folds in
     * {@code SPECTRO_STT_MODEL}) wins, otherwise the same env-or-default chain
     * this endpoint always used — {@code ~/.spectro/models/ggml-small.bin} as
     * installed by setup-stt.sh.
     */
    private static Path defaultModelPath() {
        String configured = SpectroConfig.load(SpectroConfig.Overrides.none()).sttModel();
        if (configured != null && !configured.isBlank()) {
            return Path.of(configured);
        }
        String override = System.getenv("SPECTRO_STT_MODEL");
        return (override != null && !override.isBlank())
                ? Path.of(override)
                : Path.of(System.getProperty("user.home"), ".spectro", "models", "ggml-small.bin");
    }

    /**
     * Browser sends webm/opus bytes -&gt; WAV -&gt; whisper-cli -&gt; {@code { "text": ... }}.
     *
     * @param audio the recording exactly as the browser's MediaRecorder produced it
     * @return 200 with the transcript (possibly empty); 503 with a setup hint when
     *         STT is missing or the pipeline fails readably; 500 only for temp-dir
     *         failure or interruption
     */
    @PostMapping("/api/transcribe")
    public ResponseEntity<Map<String, String>> transcribe(@RequestBody byte[] audio) {
        if (!sttAvailable) {
            // 503, not 500: STT is optional infrastructure. The hint mirrors the CLI's.
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("error",
                            "Speech-to-text is not installed — run bash scripts/setup-stt.sh."));
        }

        final Path dir;
        try {
            dir = Files.createTempDirectory("spectroscope-voice-");
        } catch (IOException failure) {
            return ResponseEntity.internalServerError().body(Map.of("error", failure.getMessage()));
        }
        Path webmPath = dir.resolve("recording.webm");
        Path wavPath = dir.resolve("recording.wav");
        try {
            Files.write(webmPath, audio);            // browser delivers webm/opus
            // Convert to 16 kHz mono WAV through the SAME runner seam — reusing the
            // drain-then-wait implementation keeps the process boundary in one place.
            runner.runCapturingOutput(List.of(
                    "ffmpeg", "-hide_banner", "-loglevel", "error",
                    "-i", webmPath.toString(), "-ar", "16000", "-ac", "1", "-y", wavPath.toString()));
            Optional<String> text = transcriber.transcribe(wavPath);
            return ResponseEntity.ok(Map.of("text", text.orElse("")));
        } catch (IOException failure) {
            // Missing binary/model surfaces here as a readable message → 503 with the hint.
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("error", failure.getMessage()));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return ResponseEntity.internalServerError().body(Map.of("error", "transcription interrupted"));
        } finally {
            deleteRecursively(dir);
        }
    }

    /**
     * Best-effort cleanup of the per-request temp directory — a leftover file
     * must never fail a request that already has its answer.
     *
     * @param dir the temp directory to remove with everything in it
     */
    private static void deleteRecursively(Path dir) {
        try (var paths = Files.walk(dir)) {
            paths.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                    // best effort
                }
            });
        } catch (IOException ignored) {
            // best effort
        }
    }
}
