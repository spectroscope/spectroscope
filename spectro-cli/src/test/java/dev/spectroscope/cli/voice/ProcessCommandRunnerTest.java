package dev.spectroscope.cli.voice;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The voice pipeline's silent-failure hole, found live (card 184): ffmpeg
 * failed to convert, its exit code was ignored, and whisper-cli's help text
 * became a 200 "transcript". A child that exits non-zero must throw with its
 * own words, not hand its noise onward as a result.
 */
class ProcessCommandRunnerTest {

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
}
