package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.function.LongConsumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 489, criterion 5: the notice a clamped result carries stays when the
 * clamp is the window's.
 *
 * <p>Of the five tools that share the clamp, only a {@code run_command} cut by
 * its time limit carries a notice: the error line, {@link
 * StandardTools#CUT_OUTPUT_MARKER} and a leading ellipsis in front of the kept
 * end (card 384). The other results are cut without one, in v0.14.4 and
 * after this card. This test captures a cut result on a window of 8,192
 * tokens and checks all three parts of the notice and the new length.</p>
 */
class ClampedOutputKeepsItsNoticeTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static String runCommand(String command, Path cwd, int window) {
        Tool tool = StandardTools.all(1).stream()
                .filter(candidate -> "run_command".equals(candidate.name()))
                .findFirst().orElseThrow();
        ObjectNode input = JSON.createObjectNode().put("command", command);
        LongConsumer noWait = millis -> { };
        return tool.execute(input, new Tool.ToolContext(cwd, new CancelSignal(), "main", "c1",
                event -> { }, attachment -> { }, change -> { }, noWait, false, window));
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
}
