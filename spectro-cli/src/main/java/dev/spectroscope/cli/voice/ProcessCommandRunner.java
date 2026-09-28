package dev.spectroscope.cli.voice;

import dev.spectroscope.core.tools.ToolPath;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

/**
 * The production {@link CommandRunner}: recording and transcription run as
 * {@code ProcessBuilder} child processes — no audio library enters the project.
 * Blocking style, as everywhere in this codebase: the recorder blocks on the REPL's
 * reader until Enter, whisper-cli's stdout is drained before {@code waitFor()}.
 *
 * <p><b>Which program runs</b> (card 449). A bare name such as
 * {@code whisper-cli} is looked up with {@link ToolPath#locate(String)}, the
 * same lookup the STT status and {@code spectro doctor} use, and the child is
 * started at the absolute path that lookup found. {@code ProcessBuilder} would
 * otherwise search the JVM's own PATH, which for an app started from the Finder
 * is launchd's four folders without Homebrew. A command whose first element
 * already contains a separator is started as given.</p>
 */
public final class ProcessCommandRunner implements CommandRunner {

    /** Where a bare program name sits, and the folders searched for it. */
    private final Function<String, ToolPath.Lookup> locator;

    /** Production: programs are looked up on the tool shell's PATH. */
    public ProcessCommandRunner() {
        this(ToolPath::locate);
    }

    /**
     * Seam for tests: the lookup over given folders.
     *
     * @param locator where a bare program name sits
     */
    ProcessCommandRunner(Function<String, ToolPath.Lookup> locator) {
        this.locator = locator;
    }

    /**
     * The command with its program replaced by the absolute path the lookup
     * found. A program that is already a path is left alone.
     *
     * @param command the argv, element 0 the program
     * @return the argv to start
     * @throws IOException when the program is not found, naming the folders
     *                     searched and the setup script
     */
    private List<String> resolved(List<String> command) throws IOException {
        String program = command.getFirst();
        if (program.indexOf('/') >= 0 || program.indexOf(File.separatorChar) >= 0) {
            return command;
        }
        ToolPath.Lookup lookup = locator.apply(program);
        if (!lookup.isFound()) {
            throw new IOException(program + " not found in " + String.join(", ", lookup.searched())
                    + ". Run bash scripts/setup-stt.sh.");
        }
        List<String> argv = new ArrayList<>(command);
        argv.set(0, lookup.found());
        return argv;
    }

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
        List<String> argv = resolved(command);
        Process process;
        try {
            process = new ProcessBuilder(argv).redirectErrorStream(true).start();
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
     * A missing binary throws with a hint at the setup script; a NON-ZERO exit throws
     * with the child's own words. Found live (card 184): ffmpeg failed to convert,
     * the exit code was ignored, and whisper-cli's help text became a 200
     * "transcript" — a child that failed must never hand its noise onward as a result.
     *
     * @param command the argv to execute — element 0 is the binary named in the missing-binary hint
     * @return every line the process printed, stdout and stderr merged
     */
    @Override
    public List<String> runCapturingOutput(List<String> command)
            throws IOException, InterruptedException {
        List<String> argv = resolved(command);
        Process process;
        try {
            process = new ProcessBuilder(argv).redirectErrorStream(true).start();
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
        int exit = process.waitFor();
        if (exit != 0) {
            // The tail carries the actual error (ffmpeg prints it last); the whole
            // output would bury it under banner noise.
            List<String> tail = lines.subList(Math.max(0, lines.size() - 5), lines.size());
            throw new IOException(command.getFirst() + " exited " + exit
                    + (tail.isEmpty() ? "" : ": " + String.join(" | ", tail)));
        }
        return lines;
    }
}
