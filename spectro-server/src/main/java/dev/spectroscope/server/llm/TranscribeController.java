package dev.spectroscope.server.llm;

import dev.spectroscope.cli.voice.CommandRunner;
import dev.spectroscope.cli.voice.ProcessCommandRunner;
import dev.spectroscope.cli.voice.Transcriber;
import dev.spectroscope.cli.voice.WavAudio;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.wire.LlmWireRecorder;
import dev.spectroscope.core.wire.LlmWireTap;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.Base64;
import java.util.Comparator;
import java.util.Map;
import java.util.Optional;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * The web face of voice input: the browser records with MediaRecorder, converts the
 * recording to 16 kHz mono WAV itself, and POSTs that here; the server runs the SAME
 * {@link Transcriber} the CLI uses. The transcript comes back as {@code { "text": ... }}
 * and lands in the composer input — never directly at the agent (the same boundary the
 * CLI draws: an STT error is reviewable text, not an agent instruction).
 *
 * <p><b>One child process, not two</b> (card 187 step 5.4). This endpoint used to write
 * the webm/opus body to a temp file and run ffmpeg over it to produce the WAV whisper
 * wants. The browser already had the audio, and Web Audio can hand over exactly that
 * format, so the conversion moved into the page that recorded it. What the server gains
 * is not speed: it is that the local path needs ONE binary, whisper.cpp, which is MIT —
 * the licence question ffmpeg raised leaves with the dependency, and so does half the
 * bundling job if the offline case ever wants it.</p>
 *
 * <p>What arrives is therefore CHECKED rather than converted ({@link WavAudio}). Card 184
 * is the reason: an unreadable body once went down this pipeline, ffmpeg failed, its exit
 * code was ignored, and whisper's help text came back as a 200 "transcript".</p>
 *
 * <p>Reuse note: {@code Transcriber} lives in spectro-cli, which spectro-server already
 * depends on for the embedded interactive mode, so it is on the classpath here.</p>
 *
 * <p>The process boundary sits behind a {@link CommandRunner} exactly as in the CLI, so
 * this endpoint is testable with a fake runner — no whisper-cli and no model on the
 * machine. If STT is not installed the endpoint answers a clean {@code 503} with the
 * setup hint (the composer's mic button shows a tooltip); never a stack trace.</p>
 */
@RestController
public class TranscribeController {

    private final Transcriber transcriber;
    /** Fast, process-free readiness probe: the pinned model must be present. */
    /** Whether transcription can run RIGHT NOW. A supplier and not a boolean:
     *  readiness used to be decided in the constructor, so a model that appeared
     *  while the server ran was invisible until a restart — which is exactly
     *  what the UI's download produces (card 184 leg 2b). Measured on every
     *  call now, like SttController's status. */
    private final java.util.function.BooleanSupplier sttReady;
    /** Named on the llm-wire record so the file says which model transcribed. */
    private final Path modelPath;
    /** Test seam; null means one day-file recorder per request (see {@link #transcribe}). */
    private final LlmWireRecorder wireRecorder;
    /** Where a recording goes, asked per request (see {@link Choice}). */
    private final java.util.function.Supplier<Choice> choice;

    /** Spring wiring: real child processes, the pinned model under ~/.spectro/models. */
    public TranscribeController() {
        // No snapshot: the probe below runs per request, so a model downloaded
        // through the UI works without restarting the server.
        this(new ProcessCommandRunner(), defaultModelPath(), true);
    }

    /**
     * Seam for tests: inject a runner, a model path, and the readiness flag.
     *
     * @param runner the process boundary — a fake keeps whisper-cli out of tests
     * @param modelPath the whisper model file the transcriber is pointed at
     * @param sttAvailable {@code false} pins the endpoint to 503; {@code true} means
     *                     "probe the model file on every call"
     */
    TranscribeController(CommandRunner runner, Path modelPath, boolean sttAvailable) {
        this(runner, modelPath, sttAvailable, null);
    }

    /**
     * The full seam (card 184): also inject the llm-wire recorder the spoken
     * bytes are recorded through.
     *
     * @param runner the process boundary — a fake keeps whisper-cli out of tests
     * @param modelPath the whisper model file the transcriber is pointed at
     * @param sttAvailable readiness override — {@code false} makes the endpoint answer 503
     * @param wireRecorder the recorder to write the stt exchange to; null opens
     *                     the shared day file per request
     */
    TranscribeController(CommandRunner runner, Path modelPath, boolean sttAvailable,
                         LlmWireRecorder wireRecorder) {
        this(runner, modelPath, sttAvailable, wireRecorder, TranscribeController::liveChoice);
    }

    /**
     * The full seam: also inject where a recording goes, so the hosted route is
     * testable without a network, a key or an account.
     *
     * @param runner the process boundary — a fake keeps whisper-cli out of tests
     * @param modelPath the whisper model file the transcriber is pointed at
     * @param sttAvailable readiness override — {@code false} makes the local route answer 503
     * @param wireRecorder the recorder to write the stt exchange to; null opens
     *                     the shared day file per request
     * @param choice what this call should do, asked ONCE PER REQUEST: a key can
     *               be written through the UI while the server runs, exactly like
     *               the model that leg 2b had to start probing for the same reason
     */
    TranscribeController(CommandRunner runner, Path modelPath, boolean sttAvailable,
                         LlmWireRecorder wireRecorder, java.util.function.Supplier<Choice> choice) {
        this.transcriber = new Transcriber(runner, modelPath);
        // `true` from the production path means "probe the file, every time";
        // an explicit false is a test saying STT is not there at all.
        Path probed = modelPath;
        this.sttReady = sttAvailable ? () -> Files.exists(probed) : () -> false;
        this.modelPath = modelPath;
        this.wireRecorder = wireRecorder;
        this.choice = choice;
    }

    /**
     * What one call should do: which way it goes, the key for the hosted path,
     * the client that would carry it, and the dictation language.
     *
     * @param route where the recording goes
     * @param key the hosted provider's key — blank when there is none
     * @param hosted the hosted client, never null so the route can be reported
     *               honestly even when it cannot run
     * @param language the {@code sttLanguage} setting: {@code auto} leaves
     *                 detection to the model on either route; a code such as
     *                 {@code de} pins whisper's {@code -l} and rides the hosted
     *                 multipart as its own field
     */
    record Choice(SttRoute route, String key, HostedStt hosted, String language) {}

    /** Production: the settings hierarchy and the .env, read fresh per request. */
    private static Choice liveChoice() {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none());
        String key = SpectroConfig.resolveApiKey(HostedTranscriber.KEY_ENV);
        String safeKey = key == null ? "" : key;
        return new Choice(SttRoute.of(config.sttProvider(), !safeKey.isBlank()), safeKey,
                new HostedTranscriber(HostedTranscriber.DEFAULT_MODEL), config.sttLanguage());
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
     * Browser sends a 16 kHz mono WAV -&gt; whisper-cli -&gt; {@code { "text": ... }}.
     *
     * @param audio the converted recording, exactly as the browser encoded it
     * <p>The answer also names its own llm-wire record (card 184 leg 2b) under
     * {@code wire}, because voice happens before any session exists and there is
     * therefore no session socket to mirror the exchange onto. Without it the
     * spoken bytes and the transcript were recorded byte-exactly and appeared in
     * no trace anywhere. A run that never got as far as an exchange carries no
     * {@code wire} at all rather than an empty one, which would read as a record
     * that got lost.</p>
     *
     * @return 200 with the transcript (possibly empty) and its wire record; 400 when the
     *         body is not audio whisper can read; 503 with a setup hint when STT is
     *         missing or the pipeline fails readably; 500 only for temp-dir failure or
     *         interruption
     */
    @PostMapping("/api/transcribe")
    public ResponseEntity<Map<String, Object>> transcribe(@RequestBody byte[] audio) {
        // Which way this recording goes, decided fresh (a key or a model can
        // appear while the server runs). Each route reports ITS OWN obstacle:
        // telling a DMG user to run a shell script when what is missing is a key
        // was the whole reason the card was corrected.
        Choice call = choice.get();
        boolean hosted = call.route() == SttRoute.HOSTED;
        if (hosted && call.key().isBlank()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("error", "Speech-to-text is set to the hosted provider and there is"
                            + " no key — set " + HostedTranscriber.KEY_ENV + " in Settings."));
        }
        if (!hosted && !sttReady.getAsBoolean()) {
            // 503, not 500: STT is optional infrastructure. The hint mirrors the CLI's.
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("error",
                            "Speech-to-text is not installed — run bash scripts/setup-stt.sh."));
        }
        // Before anything is spawned and before an exchange is opened: a body no model
        // can read never reached a model, so it must not leave a record claiming it did.
        Optional<String> unreadable = WavAudio.problem(audio);
        if (unreadable.isPresent()) {
            return ResponseEntity.badRequest().body(Map.of("error", unreadable.get()));
        }

        final Path dir;
        try {
            dir = Files.createTempDirectory("spectroscope-voice-");
        } catch (IOException failure) {
            return ResponseEntity.internalServerError().body(Map.of("error", failure.getMessage()));
        }
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
        // Fidelity "encoded" on BOTH routes, and for the same reason: the base64
        // is the RECORD'S own encoding of the real input bytes, and no socket
        // carried that string — the hosted call puts the same audio inside a
        // multipart envelope. What differs is everything that describes the wire:
        // a child process has no method and no host, an HTTPS call has both.
        LlmWireTap.WireRequest request = hosted
                ? new LlmWireTap.WireRequest("openai", call.hosted().model(), "http", "POST",
                        HostedTranscriber.URL, null, "encoded",
                        Base64.getEncoder().encodeToString(audio), System.currentTimeMillis())
                : new LlmWireTap.WireRequest("whisper-cpp", modelPath.getFileName().toString(),
                        "process", null, "process://whisper-cli", null, "encoded",
                        Base64.getEncoder().encodeToString(audio), System.currentTimeMillis());
        LlmWireTap.Exchange exchange = recorder.bound("composer", null, "stt").begin(request);
        try {
            Optional<String> text;
            if (hosted) {
                // The answer is recorded as it ARRIVED, not as it was read: this
                // one really did come off a socket, so its fidelity is "bytes"
                // and the reader sees the provider's own json.
                String body = call.hosted().post(audio, call.key(), call.language());
                text = Optional.of(HostedTranscriber.textOf(body)).filter(t -> !t.isEmpty());
                exchange.end(new LlmWireTap.WireOutcome(200, "bytes", body, false, null,
                        System.currentTimeMillis()));
            } else {
                // Straight to disk: the browser already produced the 16 kHz mono WAV that
                // whisper reads, so nothing rewrites these bytes between the microphone and
                // the model — which is also what makes the record above the real input.
                Files.write(wavPath, audio);
                text = transcriber.transcribe(wavPath, call.language());
                // "process-output": whisper's stdout as the Transcriber parsed it —
                // not socket bytes, and the label says so.
                exchange.end(new LlmWireTap.WireOutcome(200, "process-output",
                        text.orElse(""), false, null, System.currentTimeMillis()));
            }
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
            wire.put("transport", meta.transport());
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
            // Two different failures used to wear the same number, and the browser
            // treats 503 as "STT is not set up" and takes the microphone button
            // away until reload. A hosted provider that refused (a 429, a blip)
            // is not a setup problem -- it is the far side failing, which is what
            // 502 says, and the browser keeps the button so the next press can
            // succeed. Only the LOCAL route's failures are setup: 503 as before.
            int status = hosted ? 502 : 503;
            exchange.end(new LlmWireTap.WireOutcome(status, hosted ? "bytes" : "process-output",
                    null, false, failure.getMessage(), System.currentTimeMillis()));
            return ResponseEntity.status(hosted ? HttpStatus.BAD_GATEWAY : HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("error", failure.getMessage()));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            exchange.end(new LlmWireTap.WireOutcome(500, hosted ? "bytes" : "process-output",
                    null, false, "transcription interrupted", System.currentTimeMillis()));
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
