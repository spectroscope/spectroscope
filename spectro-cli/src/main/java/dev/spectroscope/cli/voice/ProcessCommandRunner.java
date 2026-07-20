package dev.spectroscope.cli.voice;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * The production {@link CommandRunner}: recording and transcription run as
 * {@code ProcessBuilder} child processes — no audio library enters the project.
 * Blocking style, as everywhere in this codebase: the recorder blocks on the REPL's
 * reader until Enter, whisper-cli's stdout is drained before {@code waitFor()}.
 */
public final class ProcessCommandRunner implements CommandRunner {

    /**
     * Starts the recorder as a child process (stderr folded into stdout), blocks on the
     * REPL reader until Enter, then stops it with SIGTERM so ffmpeg finalizes the WAV
     * header cleanly — SIGKILL only as the 5-second fallback. A missing binary throws
     * with a hint at the setup script.
     *
     * @param command    the recorder argv — element 0 is the binary named in the missing-binary hint
     * @param stopSignal the REPL's stdin reader; its next line ends the recording
     * @return wall-clock milliseconds between process start and the user's Enter
     */
    @Override
    public long record(List<String> command, BufferedReader stopSignal)
            throws IOException, InterruptedException {
        Process process;
        try {
            process = new ProcessBuilder(command).redirectErrorStream(true).start();
        } catch (IOException notFound) {
            // The first arg is the recorder binary (ffmpeg) — name it in the hint.
            throw new IOException(command.getFirst()
                    + " not found — run bash scripts/setup-stt.sh.", notFound);
        }

        long startedAt = System.currentTimeMillis();
        stopSignal.readLine();                     // blocks until Enter (blocking style)
        long durationMs = System.currentTimeMillis() - startedAt;

        // destroy() sends SIGTERM (like pressing 'q'): ffmpeg finalizes the WAV header
        // cleanly. NEVER destroyForcibly() as the primary stop — SIGKILL leaves a broken
        // WAV header behind; it is only the 5-second fallback.
        process.destroy();
        if (!process.waitFor(5, TimeUnit.SECONDS)) {
            process.destroyForcibly();
        }
        return durationMs;
    }

    /**
     * Runs the one-shot child process and drains its merged output COMPLETELY before
     * {@code waitFor()} — the order that avoids the classic full-pipe-buffer deadlock.
     * A missing binary throws with a hint at the setup script.
     *
     * @param command the argv to execute — element 0 is the binary named in the missing-binary hint
     * @return every line the process printed, stdout and stderr merged
     */
    @Override
    public List<String> runCapturingOutput(List<String> command)
            throws IOException, InterruptedException {
        Process process;
        try {
            process = new ProcessBuilder(command).redirectErrorStream(true).start();
        } catch (IOException notFound) {
            throw new IOException(command.getFirst()
                    + " not found — run bash scripts/setup-stt.sh.", notFound);
        }

        // Drain stdout COMPLETELY before waitFor() — a full pipe buffer would deadlock
        // the child (the classic ProcessBuilder trap).
        List<String> lines = new ArrayList<>();
        try (BufferedReader out = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = out.readLine()) != null) {
                lines.add(line);
            }
        }
        process.waitFor();
        return lines;
    }
}
