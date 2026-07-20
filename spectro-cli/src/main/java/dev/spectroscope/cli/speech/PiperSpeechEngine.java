package dev.spectroscope.cli.speech;

import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The production {@link SpeechEngine}: local synthesis with piper and playback
 * with the OS audio player, both as plain {@link ProcessBuilder} child processes.
 * No Java TTS/audio library — piper (installed by {@code scripts/setup-tts.sh})
 * and afplay/aplay/ffplay do the work. This class is the one place that touches a
 * binary; the {@link SpeechRenderer} above it stays testable through the
 * interface.
 *
 * <p>piper reads a sentence from stdin and writes a WAV; the player reads that
 * WAV. piper logs progress to stderr — discarded, so it never mixes into the
 * terminal output. The player is started WITHOUT a shell so
 * {@link Playback#stop()} destroys the player itself, not a shell wrapper (that
 * would leave a ghost sentence talking after Ctrl+C).</p>
 */
public final class PiperSpeechEngine implements SpeechEngine {

    private static final Path PIPER_BIN =
            Path.of(System.getProperty("user.home"), ".spectro", "models", "piper", "piper");

    private final Path modelPath;
    private final Path tmpDir;
    private final AtomicInteger counter = new AtomicInteger();

    /**
     * Resolves the voice model and creates the per-process temp folder the WAVs
     * land in — failing loudly at construction when even that folder cannot exist.
     *
     * @param voice the voice name (config {@code tts.voice}); resolves the .onnx under ~/.spectro/models.
     */
    public PiperSpeechEngine(String voice) {
        this.modelPath = Path.of(System.getProperty("user.home"), ".spectro", "models", voice + ".onnx");
        try {
            this.tmpDir = Files.createTempDirectory("spectroscope-tts-");
        } catch (IOException failure) {
            throw new UncheckedIOException("Cannot create the TTS temp directory", failure);
        }
    }

    /**
     * All three legs checked: the piper binary is executable, the voice model exists,
     * and an OS audio player is found — voice output stays off if any is missing.
     *
     * @return true only when synthesis and playback can both work on this machine
     */
    @Override
    public boolean isAvailable() {
        return Files.isExecutable(PIPER_BIN) && Files.exists(modelPath) && pickPlayer() != null;
    }

    /**
     * Runs piper as a blocking child: the sentence goes in on stdin (then stdin closes,
     * which is piper's end-of-input signal), a numbered WAV comes out in the temp folder.
     * A non-zero exit deletes the partial WAV and fails the sentence.
     *
     * @param sentence the text to synthesize — one sentence, markdown already stripped
     * @return a {@link WavClip} carrying the sentence and its WAV path
     */
    @Override
    public Clip synthesize(String sentence) throws IOException, InterruptedException {
        Path wav = tmpDir.resolve("sentence-" + counter.incrementAndGet() + ".wav");
        ProcessBuilder builder = new ProcessBuilder(
                PIPER_BIN.toString(), "--model", modelPath.toString(), "--output_file", wav.toString());
        builder.redirectOutput(ProcessBuilder.Redirect.DISCARD);
        builder.redirectError(ProcessBuilder.Redirect.DISCARD); // piper logs to stderr — keep it out of the terminal
        Process process = builder.start();
        try (OutputStream stdin = process.getOutputStream()) {
            stdin.write((sentence + "\n").getBytes(StandardCharsets.UTF_8)); // write the sentence, then close stdin
        }
        int code = process.waitFor();
        if (code != 0) {
            deleteQuietly(wav);
            throw new IOException("piper exit code " + code);
        }
        return new WavClip(sentence, wav);
    }

    /**
     * Starts the OS audio player directly on the clip's WAV — deliberately without a
     * shell, so {@link Playback#stop()} kills the player itself, not a wrapper.
     *
     * @param clip the {@link WavClip} to play (this engine only ever receives its own clips)
     * @return the handle of the started player process
     */
    @Override
    public Playback play(Clip clip) throws IOException {
        Player chosen = pickPlayer();
        Path wav = ((WavClip) clip).wav;
        // NO shell: stop() must hit the player itself, not a shell.
        ProcessBuilder builder = new ProcessBuilder(chosen.command(wav));
        builder.redirectOutput(ProcessBuilder.Redirect.DISCARD);
        builder.redirectError(ProcessBuilder.Redirect.DISCARD);
        return new ProcessPlayback(builder.start());
    }

    /** A synthesized WAV in the temp folder; discarded (deleted) after playback. */
    private static final class WavClip implements Clip {
        private final String sentence;
        private final Path wav;

        /**
         * @param sentence the text this clip speaks — kept for ordering assertions
         * @param wav      the synthesized audio file in the engine's temp folder
         */
        WavClip(String sentence, Path wav) {
            this.sentence = sentence;
            this.wav = wav;
        }

        /**
         * The text handed to synthesis.
         *
         * @return the sentence this WAV speaks
         */
        @Override
        public String sentence() {
            return sentence;
        }

        /** Deletes the WAV best-effort — a leftover temp file is harmless. */
        @Override
        public void discard() {
            deleteQuietly(wav);
        }
    }

    /** A running player process; await() blocks, stop() destroys it (the abort path). */
    private static final class ProcessPlayback implements Playback {
        private final Process process;

        /** @param process the already-started player child process */
        ProcessPlayback(Process process) {
            this.process = process;
        }

        /** Blocks until the player exits; an interrupt re-flags the thread and returns. */
        @Override
        public void await() {
            try {
                process.waitFor();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }

        /** SIGTERMs the player — the abort path that cuts a sentence off mid-word. */
        @Override
        public void stop() {
            process.destroy();
        }
    }

    // --- player selection ----------------------------------------------------

    /** A player command: given a WAV path it returns the argv (no shell). */
    private interface Player {
        /**
         * The player invocation for one WAV — argv only, never a shell line.
         *
         * @param wav the audio file to play
         * @return the complete argv, ready for {@link ProcessBuilder}
         */
        List<String> command(Path wav);
    }

    /**
     * The first player this OS offers: afplay on macOS, else aplay, else ffplay —
     * probed in that order.
     *
     * @return the chosen player, or null when none is installed (voice output then
     *         reports itself unavailable)
     */
    private static Player pickPlayer() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        if (os.contains("mac")) {
            return wav -> List.of("afplay", wav.toString());
        }
        if (hasCommand("aplay")) {
            return wav -> List.of("aplay", "-q", wav.toString());
        }
        if (hasCommand("ffplay")) {
            return wav -> List.of("ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", wav.toString());
        }
        return null;
    }

    /**
     * PATH probe via {@code which} — quiet, and any failure (missing which, interrupt)
     * simply counts as "not installed".
     *
     * @param command the binary name to look up, e.g. {@code "aplay"}
     * @return true when the binary resolves on the PATH
     */
    private static boolean hasCommand(String command) {
        try {
            Process which = new ProcessBuilder("which", command)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .start();
            return which.waitFor() == 0;
        } catch (IOException failure) {
            return false;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /**
     * Best-effort delete for temp WAVs — cleanup must never break the speech flow.
     *
     * @param path the file to remove; a failure is swallowed on purpose
     */
    private static void deleteQuietly(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException ignored) {
            // best effort: a leftover temp file is harmless
        }
    }
}
