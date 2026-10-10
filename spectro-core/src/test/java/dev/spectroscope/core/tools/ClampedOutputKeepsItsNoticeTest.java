package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.function.LongConsumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 489, criterion 5: the notice a clamped result carries stays when the
 * clamp is the window's.
 *
 * <p>Which tools write a notice beside a clamped text is derived from the code
 * by {@code ToolOutputClampDriftTest.everyNoticeBesideAClampedTextStaysWholeAndIsPinned},
 * and each one it finds is bound to the test that pins it on a window of 8,192
 * tokens. The three {@code run_command} and {@code grep} notices are pinned here:
 * the time limit notice (card 384), the exit code line and grep's line naming the
 * files over the fixed fuse. The others are pinned beside their tools, in
 * {@code BrowserToolsTest}, {@code LaunchToolsTest} and {@code HookRunnerTest}.</p>
 */
class ClampedOutputKeepsItsNoticeTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static Tool.ToolContext context(Path cwd, int window) {
        LongConsumer noWait = millis -> { };
        return new Tool.ToolContext(cwd, new CancelSignal(), "main", "c1",
                event -> { }, attachment -> { }, change -> { }, noWait, false, window);
    }

    private static Tool tool(String name) {
        return StandardTools.all(1).stream()
                .filter(candidate -> name.equals(candidate.name()))
                .findFirst().orElseThrow();
    }

    private static String runCommand(String command, Path cwd, int window) {
        ObjectNode input = JSON.createObjectNode().put("command", command);
        return tool("run_command").execute(input, context(cwd, window));
    }

    @Test
    void aCommandCutByItsTimeLimitKeepsItsNoticeOnASmallWindow(@TempDir Path cwd) {
        String result = runCommand(
                "yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c 20000; exec sleep 10",
                cwd, 8_192);
        System.out.println("clamp-notice window=8192 chars=" + result.length()
                + " head=" + result.substring(0, result.indexOf('\n',
                        result.indexOf('\n') + 1) + 2).replace("\n", "\\n"));

        String[] parts = result.split("\n", 3);
        assertEquals("ERROR: command timed out after 1 s. Raise commandTimeoutSeconds if the"
                + " command needs longer.", parts[0], "the error line");
        assertEquals(StandardTools.CUT_OUTPUT_MARKER, parts[1], "the marker line");
        assertTrue(parts[2].startsWith("…"), "the ellipsis in front of the kept end");
        assertEquals(6_144, parts[2].length(),
                "the kept end, ellipsis included, is the window's clamp");
    }

    /**
     * A command that exits non-zero is answered with its exit code on the first
     * line, in front of what it printed. The line stays whole; what the command
     * printed is clamped to the window: 6,144 characters at 8,192 tokens, 10,000
     * at 200,000.
     */
    @Test
    void aCommandThatFailedKeepsItsExitLineOnASmallWindow(@TempDir Path cwd) {
        for (int[] windowAndBound : new int[][] {{8_192, 6_144}, {200_000, 10_000}}) {
            String result = runCommand(
                    "yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c 20000; exit 3",
                    cwd, windowAndBound[0]);
            System.out.println("clamp-notice exit window=" + windowAndBound[0]
                    + " chars=" + result.length());
            String[] parts = result.split("\n", 2);
            assertEquals("ERROR: exit code 3", parts[0],
                    "the exit line on a window of " + windowAndBound[0]);
            assertEquals(windowAndBound[1], parts[1].length(),
                    "what the command printed, on a window of " + windowAndBound[0]);
        }
    }

    /**
     * grep names the files it did not search because they are over the fixed
     * fuse in a line after its hits. With 6,130 characters of hits that line
     * fits a window of 200,000 tokens whole and pushes the result past the
     * 6,144 characters of a window of 8,192 tokens. On the small window the
     * hits give way and the line stays whole, so the result is exactly the
     * window's clamp and still names the file.
     */
    @Test
    void grepKeepsItsUnsearchedFilesNoticeOnASmallWindow(@TempDir Path cwd) throws IOException {
        String prefix = "f.txt:1:";
        String line = "needle" + "x".repeat(6_130 - prefix.length() - "needle".length() - 1);
        Files.writeString(cwd.resolve("f.txt"), line + "\n");
        try (RandomAccessFile huge = new RandomAccessFile(cwd.resolve("huge.txt").toFile(), "rw")) {
            huge.setLength(ReadBudget.FUSE_BYTES + 1);
        }
        String hits = prefix + line + "\n";
        String notice = "(not searched, over the fixed fuse of " + ReadBudget.FUSE_BYTES
                + " bytes: huge.txt)";
        assertEquals(6_130, hits.length(), "the fixture's hits");

        ObjectNode input = JSON.createObjectNode().put("pattern", "needle");
        String large = tool("grep").execute(input, context(cwd, 200_000));
        String small = tool("grep").execute(input, context(cwd, 8_192));
        System.out.println("clamp-notice grep window=200000 chars=" + large.length()
                + " window=8192 chars=" + small.length());

        assertEquals(hits + notice, large, "on a large window the hits and the notice, whole");
        assertTrue(small.endsWith(notice), "the notice stays whole on a window of 8,192: "
                + small.substring(Math.max(0, small.length() - 120)));
        assertEquals(6_144, small.length(), "the result is the window's clamp");
        assertEquals(hits.substring(0, 6_144 - notice.length()),
                small.substring(0, small.length() - notice.length()),
                "the hits give way from their end");
    }
}
