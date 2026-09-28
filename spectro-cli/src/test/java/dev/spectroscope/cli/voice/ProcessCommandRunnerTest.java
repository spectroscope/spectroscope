package dev.spectroscope.cli.voice;

import dev.spectroscope.core.tools.ToolPath;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.Reader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The voice pipeline's silent-failure hole, found live (card 184): ffmpeg
 * failed to convert, its exit code was ignored, and whisper-cli's help text
 * became a 200 "transcript". A child that exits non-zero must throw with its
 * own words, not hand its noise onward as a result.
 *
 * <p>Card 449: the runner starts a program at the path the tool PATH lookup
 * found. A bare name handed to {@code ProcessBuilder} is searched on the JVM's
 * own PATH, which for an app started from the Finder is launchd's four folders,
 * so a status that found {@code whisper-cli} could still fail to run it.
 */
class ProcessCommandRunnerTest {

    /** launchd's PATH for an app started from the Finder or the Dock. */
    private static final String LAUNCHD = "/usr/bin:/bin:/usr/sbin:/sbin";

    /** A name no machine has. */
    private static final String NOBODY = "spectro-card-449-no-such-program";

    /**
     * The tool PATH lookup over launchd's PATH with {@code prefix} standing in
     * for the Homebrew prefix.
     *
     * @param prefix the package-manager folder
     * @return the lookup the runner asks
     */
    private static Function<String, ToolPath.Lookup> finderLaunchWith(Path prefix) {
        return name -> ToolPath.locate(name, LAUNCHD, Path.of(""), List.of(prefix.toString()));
    }

    private static Path script(Path dir, String name, String body) throws IOException {
        Files.createDirectories(dir);
        Path file = dir.resolve(name);
        Files.writeString(file, "#!/bin/sh\n" + body + "\n");
        assertTrue(file.toFile().setExecutable(true), "could not mark " + file + " executable");
        return file;
    }

    @Test
    void aCleanExitReturnsTheOutputLines() throws Exception {
        List<String> lines = new ProcessCommandRunner()
                .runCapturingOutput(List.of("sh", "-c", "echo one; echo two"));
        assertEquals(List.of("one", "two"), lines);
    }

    @Test
    void aNonZeroExitThrowsWithTheChildsOwnWords() {
        IOException failure = assertThrows(IOException.class, () -> new ProcessCommandRunner()
                .runCapturingOutput(List.of("sh", "-c", "echo out; echo boom >&2; exit 3")));
        assertTrue(failure.getMessage().contains("exited 3"), failure.getMessage());
        assertTrue(failure.getMessage().contains("boom"),
                "the child's stderr must ride the message: " + failure.getMessage());
    }

    @Test
    void theTranscriberRunsWhisperAtThePathTheLookupFound(@TempDir Path dir) throws Exception {
        Path prefix = dir.resolve("homebrew").resolve("bin");
        Path whisper = script(prefix, "whisper-cli", "echo \"$0\"");

        List<String> lines = new ProcessCommandRunner(finderLaunchWith(prefix))
                .runCapturingOutput(List.of("whisper-cli", "-f", "x.wav"));

        assertEquals(List.of(whisper.toString()), lines,
                "the program that ran is the one the lookup found, started by its absolute path");
    }

    @Test
    void theRecorderIsStartedAtThePathTheLookupFoundToo(@TempDir Path dir) throws Exception {
        Path prefix = dir.resolve("homebrew").resolve("bin");
        Path marker = dir.resolve("started-as");
        // Written aside and renamed, so the marker never exists half written.
        Path ffmpeg = script(prefix, "ffmpeg", "echo \"$0\" > '" + marker + ".tmp'\n"
                + "mv '" + marker + ".tmp' '" + marker + "'\nexec sleep 30");

        new ProcessCommandRunner(finderLaunchWith(prefix))
                .record(List.of("ffmpeg", "-y", "out.wav"), new BufferedReader(untilExists(marker)));

        assertEquals(ffmpeg.toString(), Files.readString(marker).strip());
    }

    @Test
    void aMissingProgramNamesTheFoldersItSearched(@TempDir Path dir) throws Exception {
        Path prefix = Files.createDirectories(dir.resolve("homebrew").resolve("bin"));
        Function<String, ToolPath.Lookup> lookup = finderLaunchWith(prefix);

        IOException failure = assertThrows(IOException.class,
                () -> new ProcessCommandRunner(lookup).runCapturingOutput(List.of(NOBODY)));

        assertTrue(failure.getMessage().startsWith(NOBODY + " not found"), failure.getMessage());
        for (String folder : lookup.apply(NOBODY).searched()) {
            assertTrue(failure.getMessage().contains(folder),
                    folder + " was searched and is not named: " + failure.getMessage());
        }
        assertTrue(failure.getMessage().contains("scripts/setup-stt.sh"), failure.getMessage());
    }

    @Test
    void aCommandThatIsAlreadyAPathIsStartedAsGiven(@TempDir Path dir) throws Exception {
        Path tool = script(dir.resolve("elsewhere"), "tool", "echo ran");
        Function<String, ToolPath.Lookup> refuses = name -> {
            throw new AssertionError("a path was looked up as a name: " + name);
        };

        assertEquals(List.of("ran"),
                new ProcessCommandRunner(refuses).runCapturingOutput(List.of(tool.toString())));
    }

    /**
     * A reader whose first line arrives once {@code file} exists, so the
     * recorder is stopped only after it has started. Gives up after ten seconds.
     *
     * @param file the file the recorder writes when it starts
     * @return a reader yielding one newline
     */
    private static Reader untilExists(Path file) {
        return new Reader() {
            private boolean sent;

            @Override
            public int read(char[] buffer, int offset, int length) throws IOException {
                if (sent) {
                    return -1;
                }
                long deadline = System.currentTimeMillis() + 10_000;
                while (!Files.exists(file) && System.currentTimeMillis() < deadline) {
                    try {
                        Thread.sleep(20);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new IOException("interrupted", interrupted);
                    }
                }
                sent = true;
                buffer[offset] = '\n';
                return 1;
            }

            @Override
            public void close() {
            }
        };
    }
}
