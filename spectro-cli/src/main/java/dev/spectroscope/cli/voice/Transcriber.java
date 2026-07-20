package dev.spectroscope.cli.voice;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * Voice input: recording (ffmpeg) + local transcription (whisper-cli). The channel
 * sits IN FRONT OF the event stream — the core sees only the finished text, so the
 * session JSONL is indistinguishable from a typed conversation.
 *
 * <p>The two process invocations sit behind a {@link CommandRunner}: this class only
 * BUILDS the argv (per-OS ffmpeg input, the whisper-cli command with the model path
 * and language) and interprets the output. That seam is what makes the whole flow
 * testable with a fake runner — no ffmpeg, no whisper-cli, no model file required in
 * a test. Production wires {@link ProcessCommandRunner}.</p>
 */
public final class Transcriber {

    /** Named in the audit event's {@code model} field and in the trace tab. */
    public static final String MODEL_NAME = "ggml-small";

    private final CommandRunner runner;

    // Default from setup-stt.sh; SPECTRO_STT_MODEL overrides (swap models without a code
    // change), matching the ASSIGNMENT's "keep the model path configurable" hint.
    private final Path modelPath;

    /** Production: real child processes, the pinned model under ~/.spectro/models. */
    public Transcriber() {
        this(new ProcessCommandRunner(), defaultModelPath());
    }

    /**
     * Production with the settings hierarchy's model path (settings-productization
     * Task 3): real child processes; {@code configuredSttModel} — typically
     * {@code SpectroConfig.sttModel()}, which already folds in {@code SPECTRO_STT_MODEL}
     * — wins over the built-in default when non-blank, else today's env-or-default chain.
     *
     * @param configuredSttModel the resolved config.sttModel() value; null or blank
     *                           defers to {@link #defaultModelPath()}
     */
    public Transcriber(String configuredSttModel) {
        this(new ProcessCommandRunner(), modelPath(configuredSttModel));
    }

    /**
     * Seam for tests and the server: inject a runner (and an explicit model path).
     *
     * @param runner    executes the two child processes — a fake here makes the whole flow binary-free
     * @param modelPath the whisper ggml model file the transcription command points at
     */
    public Transcriber(CommandRunner runner, Path modelPath) {
        this.runner = runner;
        this.modelPath = modelPath;
    }

    /**
     * The pinned model from setup-stt.sh under ~/.spectro/models — unless
     * {@code SPECTRO_STT_MODEL} points elsewhere, so models swap without a code change.
     *
     * @return the model path production runs with
     */
    private static Path defaultModelPath() {
        String override = System.getenv("SPECTRO_STT_MODEL");
        return (override != null && !override.isBlank())
                ? Path.of(override)
                : Path.of(System.getProperty("user.home"), ".spectro", "models", "ggml-small.bin");
    }

    /**
     * Resolves the effective model path: {@code configured} wins when non-blank,
     * else exactly {@link #defaultModelPath()}'s SPECTRO_STT_MODEL-env-or-default chain.
     *
     * @param configured the resolved config.sttModel() value; null or blank defers
     * @return the effective whisper model path
     */
    static Path modelPath(String configured) {
        return (configured != null && !configured.isBlank())
                ? Path.of(configured)
                : defaultModelPath();
    }

    /**
     * Records from the default microphone until the user presses Enter. whisper.cpp
     * wants 16 kHz mono WAV — record in that format directly (a wrong sample rate is
     * the classic "it recognizes nothing" mistake). Returns the recording duration in
     * ms. The REPL's reader is passed in: no second reader on stdin (that would garble
     * the prompt).
     *
     * @param wavPath    where ffmpeg writes the recording; an empty or missing file
     *                   afterwards fails with a microphone-permission hint
     * @param replReader the REPL's stdin reader whose next line stops the recording
     * @return the recording duration in milliseconds
     */
    public long record(Path wavPath, BufferedReader replReader)
            throws IOException, InterruptedException {
        System.out.print("Recording — press Enter to stop. ");
        System.out.flush();

        long durationMs = runner.record(recordCommand(wavPath), replReader);

        if (!Files.exists(wavPath) || Files.size(wavPath) == 0) {
            throw new IOException("No recording produced — check the terminal's microphone "
                    + "permission (macOS: System Settings > Privacy & Security > Microphone).");
        }
        return durationMs;
    }

    /**
     * The ffmpeg recording argv for this OS: 16 kHz mono WAV, default microphone.
     *
     * @param wavPath the output file the argv ends with
     * @return the complete argv — avfoundation input on macOS, alsa elsewhere
     */
    static List<String> recordCommand(Path wavPath) {
        String os = System.getProperty("os.name").toLowerCase(Locale.ROOT);
        List<String> inputArgs = (os.contains("mac") || os.contains("darwin"))
                ? List.of("-f", "avfoundation", "-i", ":0")   // ":0" = audio only, default device
                : List.of("-f", "alsa", "-i", "default");

        List<String> command = new ArrayList<>(List.of(
                "ffmpeg", "-hide_banner", "-loglevel", "error"));
        command.addAll(inputArgs);
        command.addAll(List.of("-ar", "16000", "-ac", "1", "-y", wavPath.toString()));
        return List.copyOf(command);
    }

    /**
     * The whisper-cli argv: model path, auto-detected language (the owner speaks
     * German, dictation must not be forced through English), no timestamps, no
     * runtime prints — and the transcript ALSO written to a file next to the wav
     * ({@code -otxt -of}), because newer whisper/ggml builds spray backend logs
     * onto stdout/stderr and the process output can no longer be trusted to be
     * only spoken text.
     *
     * @param modelPath the ggml model file to transcribe with
     * @param wavPath   the 16 kHz mono recording to transcribe
     * @return the complete argv, transcript file target included
     */
    static List<String> transcribeCommand(Path modelPath, Path wavPath) {
        return List.of("whisper-cli", "-m", modelPath.toString(),
                "-l", "auto", "--no-timestamps", "--no-prints",
                "-otxt", "-of", wavPath.resolveSibling("transcript").toString(),
                "-f", wavPath.toString());
    }

    /**
     * Where {@code -otxt -of} puts the transcript for this recording.
     *
     * @param wavPath the recording the transcript belongs to
     * @return {@code transcript.txt} next to the wav
     */
    static Path transcriptFile(Path wavPath) {
        return wavPath.resolveSibling("transcript.txt");
    }

    /**
     * Transcribes a 16 kHz mono WAV file with whisper-cli. Returns the cleaned text;
     * an empty transcript (silence, throat-clearing) yields {@link Optional#empty()}.
     * A missing model file fails fast with a message pointing at the setup script.
     *
     * @param wavPath the recording to transcribe
     * @return the cleaned transcript, empty when nothing intelligible was spoken
     */
    public Optional<String> transcribe(Path wavPath) throws IOException, InterruptedException {
        if (!Files.exists(modelPath)) {
            throw new IOException("STT model missing: " + modelPath
                    + " — run bash scripts/setup-stt.sh.");
        }

        List<String> lines = runner.runCapturingOutput(transcribeCommand(modelPath, wavPath));
        // Prefer the -otxt file: it contains ONLY the transcript, regardless of
        // what the backend printed. The process output stays as the fallback for
        // older whisper builds that ignore the flag.
        Path transcript = transcriptFile(wavPath);
        if (Files.exists(transcript)) {
            lines = Files.readAllLines(transcript);
        }
        return Optional.ofNullable(clean(lines)).filter(text -> !text.isEmpty());
    }

    /**
     * Trims whisper-cli's stdout lines, drops non-speech marker lines such as
     * {@code [BLANK_AUDIO]} or {@code (music)}, and joins the rest. Package-private so
     * the filter is pinned by a unit test.
     *
     * @param lines the raw transcript lines (file or process output)
     * @return the joined spoken text — empty when only markers or blanks arrived
     */
    static String clean(List<String> lines) {
        return lines.stream()
                .map(String::trim)
                .filter(line -> !line.isEmpty() && !line.matches("^[\\[(].*[\\])]$"))
                .reduce((a, b) -> a + " " + b)
                .orElse("")
                .trim();
    }

    /**
     * Duration of the last recording — the audit event's {@code durationMs}.
     *
     * @return milliseconds recorded in the most recent {@link #voiceInput} flow
     */
    public long lastDurationMs() {
        return lastDurationMs;
    }

    private long lastDurationMs;

    /**
     * The complete /voice flow: record -&gt; transcribe -&gt; confirm editably. Returns the
     * confirmed text or {@link Optional#empty()} (discarded/empty); errors go to the
     * caller. The confirmation keeps the human as the editor: a plain Enter sends the
     * transcript unchanged, a typed line replaces it, end-of-stream (Ctrl-D) discards —
     * an STT error NEVER reaches the agent unreviewed.
     *
     * @param replReader the REPL's stdin reader — stops the recording, then takes the confirmation
     * @return the text to send as the next user turn, or empty for "no turn"
     */
    public Optional<String> voiceInput(BufferedReader replReader)
            throws IOException, InterruptedException {
        Path dir = Files.createTempDirectory("spectroscope-voice-");
        Path wavPath = dir.resolve("recording.wav");
        try {
            lastDurationMs = record(wavPath, replReader);
            System.out.printf(Locale.ROOT, "Recording finished (%.1f s) — transcribing ...%n",
                    lastDurationMs / 1000.0);

            Optional<String> transcript = transcribe(wavPath);
            if (transcript.isEmpty()) {
                System.out.println("Empty transcript (silence?) — nothing sent.");
                return Optional.empty();
            }

            System.out.println("voice> " + transcript.get());
            System.out.print("Enter to send, type a correction, or a blank line to discard: ");
            System.out.flush();
            String reply = replReader.readLine();
            if (reply == null) {                       // end of stream (Ctrl-D): discard
                System.out.println("Discarded.");
                return Optional.empty();
            }
            String edited = reply.strip();
            if (edited.isEmpty()) {                    // plain Enter: send the transcript unchanged
                return Optional.of(transcript.get());
            }
            return Optional.of(edited);                // a typed line replaces the transcript
        } finally {
            deleteRecursively(dir);
        }
    }

    /**
     * Best-effort removal of the per-recording temp folder (wav + transcript) —
     * cleanup failures never disturb the voice flow.
     *
     * @param dir the temp directory to remove, deepest entries first
     */
    private static void deleteRecursively(Path dir) {
        try (var paths = Files.walk(dir)) {
            paths.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                    // best effort — a temp dir left behind is harmless
                }
            });
        } catch (IOException ignored) {
            // best effort
        }
    }
}
