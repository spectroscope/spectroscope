package dev.spectroscope.server;

import dev.spectroscope.cli.voice.CommandRunner;
import dev.spectroscope.cli.voice.ProcessCommandRunner;
import dev.spectroscope.cli.voice.Transcriber;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.wire.LlmWireRecorder;
import dev.spectroscope.core.wire.LlmWireTap;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.Base64;
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
    /** Named on the llm-wire record so the file says which model transcribed. */
    private final Path modelPath;
    /** Test seam; null means one day-file recorder per request (see {@link #transcribe}). */
    private final LlmWireRecorder wireRecorder;

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
        this(runner, modelPath, sttAvailable, null);
    }

    /**
     * The full seam (card 184): also inject the llm-wire recorder the spoken
     * bytes are recorded through.
     *
     * @param runner the process boundary — a fake keeps ffmpeg/whisper out of tests
     * @param modelPath the whisper model file the transcriber is pointed at
     * @param sttAvailable readiness override — {@code false} makes the endpoint answer 503
     * @param wireRecorder the recorder to write the stt exchange to; null opens
     *                     the shared day file per request
     */
    TranscribeController(CommandRunner runner, Path modelPath, boolean sttAvailable,
                         LlmWireRecorder wireRecorder) {
        this.runner = runner;
        this.transcriber = new Transcriber(runner, modelPath);
        this.sttAvailable = sttAvailable;
        this.modelPath = modelPath;
        this.wireRecorder = wireRecorder;
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
     * <p>The answer also names its own llm-wire record (card 184 leg 2b) under
     * {@code wire}, because voice happens before any session exists and there is
     * therefore no session socket to mirror the exchange onto. Without it the
     * spoken bytes and the transcript were recorded byte-exactly and appeared in
     * no trace anywhere. A run that never got as far as an exchange carries no
     * {@code wire} at all rather than an empty one, which would read as a record
     * that got lost.</p>
     *
     * @return 200 with the transcript (possibly empty) and its wire record; 503 with a setup hint when
     *         STT is missing or the pipeline fails readably; 500 only for temp-dir
     *         failure or interruption
     */
    @PostMapping("/api/transcribe")
    public ResponseEntity<Map<String, Object>> transcribe(@RequestBody byte[] audio) {
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
        // The spoken bytes are a real model exchange (card 184): the recording
        // rides the llm-wire record verbatim (base64), the transcript comes back
        // as the response. Voice happens BEFORE any session exists, so the
        // record lives in a shared day file, agent "composer", kind "stt".
        // Voice happens BEFORE any session exists, so the record lives in a
        // shared day file — and that is also why the browser cannot learn about
        // it the way it learns about a chat turn. There is no session socket to
        // mirror onto (card 184 leg 2b). So the exchange announces itself in
        // THIS response, to the one caller that certainly wants it: the browser
        // that just spoke. It builds its own trace rows from this, and asks the
        // gated endpoint for the bytes under the day file's id.
        String wireSession = "stt-" + LocalDate.now();
        LlmWireRecorder recorder = wireRecorder != null ? wireRecorder
                : LlmWireRecorder.forSession(wireSession);
        java.util.concurrent.atomic.AtomicReference<LlmWireRecorder.ExchangeMeta> recorded =
                new java.util.concurrent.atomic.AtomicReference<>();
        recorder.onExchange(recorded::set);
        // Fidelity "encoded", not "bytes": the base64 is the RECORDING'S OWN
        // encoding of the real input bytes — no socket ever carried this string.
        // Method stays null for the same reason: a child-process pipeline has none.
        LlmWireTap.Exchange exchange = recorder.bound("composer", null, "stt").begin(
                new LlmWireTap.WireRequest("whisper-cpp", modelPath.getFileName().toString(),
                        "process", null, "process://ffmpeg+whisper-cli", null, "encoded",
                        Base64.getEncoder().encodeToString(audio), System.currentTimeMillis()));
        try {
            Files.write(webmPath, audio);            // browser delivers webm/opus
            // Convert to 16 kHz mono WAV through the SAME runner seam — reusing the
            // drain-then-wait implementation keeps the process boundary in one place.
            runner.runCapturingOutput(List.of(
                    "ffmpeg", "-hide_banner", "-loglevel", "error",
                    "-i", webmPath.toString(), "-ar", "16000", "-ac", "1", "-y", wavPath.toString()));
            Optional<String> text = transcriber.transcribe(wavPath);
            // "process-output": whisper's stdout as the Transcriber parsed it —
            // not socket bytes, and the label says so.
            exchange.end(new LlmWireTap.WireOutcome(200, "process-output",
                    text.orElse(""), false, null, System.currentTimeMillis()));
            LlmWireRecorder.ExchangeMeta meta = recorded.get();
            if (meta == null) {
                // No record to point at: say the transcript and nothing more,
                // rather than an empty `wire` object that looks like a lost one.
                return ResponseEntity.ok(Map.of("text", text.orElse("")));
            }
            Map<String, Object> wire = new java.util.LinkedHashMap<>();
            wire.put("session", wireSession);
            wire.put("xid", meta.xid());
            wire.put("agentId", meta.agentId());
            wire.put("kind", meta.kind());
            wire.put("provider", meta.provider());
            wire.put("model", meta.model());
            wire.put("url", meta.url());
            wire.put("status", meta.status());
            wire.put("requestBytes", meta.requestBytes());
            wire.put("responseBytes", meta.responseBytes());
            wire.put("responseLines", meta.responseLines());
            wire.put("aborted", meta.aborted());
            wire.put("fidelity", meta.fidelity());
            wire.put("durationMs", meta.durationMs());
            wire.put("ts", meta.ts());
            Map<String, Object> answer = new java.util.LinkedHashMap<>();
            answer.put("text", text.orElse(""));
            answer.put("wire", wire);
            return ResponseEntity.ok(answer);
        } catch (IOException failure) {
            // Missing binary/model surfaces here as a readable message → 503 with the hint.
            exchange.end(new LlmWireTap.WireOutcome(503, "process-output", null, false,
                    failure.getMessage(), System.currentTimeMillis()));
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("error", failure.getMessage()));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            exchange.end(new LlmWireTap.WireOutcome(500, "process-output", null, false,
                    "transcription interrupted", System.currentTimeMillis()));
            return ResponseEntity.internalServerError().body(Map.of("error", "transcription interrupted"));
        } finally {
            if (wireRecorder == null) {
                recorder.close(); // per-request day-file handle; flushed per line
            }
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
