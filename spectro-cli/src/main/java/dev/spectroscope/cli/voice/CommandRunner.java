package dev.spectroscope.cli.voice;

import java.io.BufferedReader;
import java.io.IOException;
import java.util.List;

/**
 * The process boundary of the voice channel, behind one narrow interface so the
 * {@link Transcriber}'s argv-building logic is testable WITHOUT a real ffmpeg or
 * whisper-cli on the machine. Production wires {@link ProcessCommandRunner};
 * a test injects a fake that records the argv and returns a canned transcript.
 *
 * <p>Two operations, matching the two child processes the blueprint prescribes:
 * a long-running recorder stopped by the user pressing Enter, and a one-shot
 * transcription whose stdout is captured. Nothing else about the flow (temp
 * files, marker filtering, confirmation) touches a process — so nothing else
 * needs a binary to be exercised.</p>
 */
public interface CommandRunner {

    /**
     * Starts the recorder ({@code command}, e.g. an ffmpeg invocation), blocks on
     * {@code stopSignal.readLine()} until the user presses Enter, then stops the
     * process cleanly and returns the elapsed recording time in milliseconds.
     *
     * @param command    the recorder argv — element 0 is the binary, the rest its arguments
     * @param stopSignal the REPL's own stdin reader; one line read from it ends the recording
     * @return the elapsed recording time in milliseconds
     * @throws IOException if the recorder binary is missing or produced no audio
     */
    long record(List<String> command, BufferedReader stopSignal)
            throws IOException, InterruptedException;

    /**
     * Runs {@code command} (e.g. a whisper-cli invocation) to completion and returns
     * its stdout as a list of lines (stderr folded in). The implementation MUST drain
     * the output fully before waiting for exit, or a full pipe buffer deadlocks the
     * child.
     *
     * @param command the one-shot argv — element 0 is the binary, the rest its arguments
     * @return every output line the process produced, stdout and stderr merged, fully drained
     * @throws IOException if the binary is missing
     */
    List<String> runCapturingOutput(List<String> command)
            throws IOException, InterruptedException;
}
