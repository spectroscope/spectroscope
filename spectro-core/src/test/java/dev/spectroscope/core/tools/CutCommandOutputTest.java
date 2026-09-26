package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 384: a command cut by its time limit hands back what it printed.
 *
 * <p>Before this card {@code ShellCommand} returned an empty output on a
 * timeout, and {@code run_command} turned that into one error line. The model
 * could not see how far the command got. Every cut command here ends in
 * {@code exec sleep}, so the kill at the limit ends the process that holds the
 * pipe and no sleeper outlives the test.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CutCommandOutputTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The card's scenario: four module lines, then a command that outlives its limit. */
    private static final String FOUR_MODULES_THEN_HANG =
            "printf 'module 1 ok\\nmodule 2 ok\\nmodule 3 ok\\nmodule 4 ok\\n'; exec sleep 10";

    private static String runCommand(long budgetSeconds, String command, Path cwd) {
        Tool tool = StandardTools.all(budgetSeconds).stream()
                .filter(candidate -> "run_command".equals(candidate.name()))
                .findFirst().orElseThrow();
        ObjectNode input = JSON.createObjectNode().put("command", command);
        return tool.execute(input, new Tool.ToolContext(cwd, new CancelSignal()));
    }

    /** Everything after the error line and the marker line.
     *  @param result a tool result that carries a marker line
     *  @return the handed back output */
    private static String outputAfterMarker(String result) {
        int first = result.indexOf('\n');
        int second = result.indexOf('\n', first + 1);
        assertTrue(first > 0 && second > first,
                "the result has no error line and marker line above an output: " + result);
        return result.substring(second + 1);
    }

    @Test
    void theBuildLogSurvivesTheCut(@TempDir Path cwd) {
        String result = runCommand(1, FOUR_MODULES_THEN_HANG, cwd);

        List<String> lines = result.lines().toList();
        assertTrue(lines.get(0).startsWith("ERROR: command timed out after 1 s."),
                "the error line has to open the result with its first words unchanged: "
                        + result);
        assertTrue(lines.size() >= 3,
                "a cut command hands back one line and nothing it printed: " + result);
        String marker = lines.get(1);
        assertTrue(marker.contains("unfinished") && marker.contains("time limit"),
                "the line between the error and the output has to say the output is"
                        + " unfinished and that the time limit cut the command: " + marker);
        assertEquals("module 1 ok\nmodule 2 ok\nmodule 3 ok\nmodule 4 ok\n",
                outputAfterMarker(result));
    }

    @Test
    void aCutCommandIsStillAnError(@TempDir Path cwd) {
        // Agent computes isError as startsWith("ERROR: "), and the web paints the
        // tool card red from that flag. The output below the error line must not
        // move the prefix.
        String result = runCommand(1, FOUR_MODULES_THEN_HANG, cwd);
        assertTrue(result.startsWith("ERROR: "), result);
    }

    @Test
    void theErrorLineNamesTheSettingThatSetsTheLimit(@TempDir Path cwd) {
        String result = runCommand(1, FOUR_MODULES_THEN_HANG, cwd);
        String errorLine = result.lines().findFirst().orElse("");
        assertTrue(errorLine.contains("commandTimeoutSeconds"),
                "the reader cannot tell which number to raise: " + errorLine);
    }

    @Test
    void nothingPrintedNothingAppended(@TempDir Path cwd) {
        String result = runCommand(1, "exec sleep 10", cwd);
        assertTrue(result.startsWith("ERROR: command timed out after 1 s."), result);
        assertFalse(result.contains("\n"),
                "a command that printed nothing gets the error line alone: " + result);
        assertTrue(result.contains("commandTimeoutSeconds"), result);
    }

    @Test
    void blankOutputIsNothingPrinted(@TempDir Path cwd) {
        // Two newlines are output, and nothing a reader can use. Card 371 made
        // the same call for a child that was cut after an empty line.
        String result = runCommand(1, "printf '\\n\\n'; exec sleep 10", cwd);
        assertFalse(result.contains("\n"),
                "blank output got a marker over nothing: " + result);
    }

    @Test
    void theEndOfALongLogIsWhatSurvives(@TempDir Path cwd) {
        // About 220 KB of progress, then the failure, then the hang. That is past
        // the cap and past the drain's buffer, so the head and the tail cannot
        // both survive, and the card says the tail does.
        String command = "awk 'BEGIN { for (i = 1; i <= 8000; i++)"
                + " printf \"compiling unit %d of 8000\\n\", i }';"
                + " echo 'FAILED: unit 8000 did not link'; exec sleep 10";
        String result = runCommand(1, command, cwd);
        String kept = outputAfterMarker(result);

        assertTrue(kept.endsWith("compiling unit 7999 of 8000\ncompiling unit 8000 of 8000\n"
                        + "FAILED: unit 8000 did not link\n"),
                "the last lines a build prints are the ones that say what broke. Got the"
                        + " last 120 chars: " + kept.substring(Math.max(0, kept.length() - 120)));
        assertFalse(kept.contains("compiling unit 1 of 8000\n"),
                "the head of the log came back instead of the end");
        assertTrue(kept.startsWith("…"),
                "a tail that lost its start has to say so: " + kept.substring(0, 40));
        assertTrue(kept.length() <= ToolOutput.MAX_OUTPUT_CHARS,
                "the output cap has to hold on the cut too, got " + kept.length());
        assertTrue(kept.length() > ToolOutput.MAX_OUTPUT_CHARS * 9 / 10,
                "the kept tail is a sliver of the cap, got " + kept.length());
    }

    @Test
    void aMultiByteTailDoesNotOpenOnABrokenCharacter(@TempDir Path cwd) throws IOException {
        // 60,000 bytes of a three-byte character, then zero, one or two
        // newlines. Whatever the tail's size, two of the three put the first
        // byte the tail keeps inside a character, and the first thing after the
        // ellipsis still has to be a whole character.
        for (String end : List.of("", "\n", "\n\n")) {
            Path log = cwd.resolve("log.txt");
            Files.writeString(log, "\u4E2D".repeat(20_000) + end, StandardCharsets.UTF_8);
            String result = runCommand(1, "cat log.txt; exec sleep 10", cwd);
            String kept = outputAfterMarker(result);

            assertTrue(kept.startsWith("\u2026\u4E2D"),
                    end.length() + " newlines: " + kept.substring(0, 10));
            assertFalse(kept.contains("\uFFFD"),
                    end.length() + " newlines: a replacement glyph in the kept tail");
        }
    }

    @Test
    void aCutLogThatFitsTheBufferStillKeepsItsEnd(@TempDir Path cwd) throws IOException {
        // About 22 KB: longer than the cap, and short enough that the drain's
        // buffer of four bytes per char of the cap still holds all of it. Here
        // the end is picked by the clip after the drain, not by the ring. A
        // build log cut at its limit often lands in this band.
        StringBuilder log = new StringBuilder();
        for (int i = 1; i <= 850; i++) {
            log.append("compiling unit ").append(i).append(" of 850\n");
        }
        log.append("FAILED: unit 850 did not link\n");
        String printed = log.toString();
        int size = printed.getBytes(StandardCharsets.UTF_8).length;
        assertTrue(size > ToolOutput.MAX_OUTPUT_CHARS && size <= 4 * ToolOutput.MAX_OUTPUT_CHARS,
                "the log has to be longer than the cap and fit the buffer, it is " + size + " bytes");
        Files.writeString(cwd.resolve("log.txt"), printed, StandardCharsets.UTF_8);

        String kept = outputAfterMarker(runCommand(1, "cat log.txt; exec sleep 10", cwd));

        assertTrue(kept.endsWith("compiling unit 850 of 850\nFAILED: unit 850 did not link\n"),
                "the failure line has to end the kept output. Got the last 120 chars: "
                        + kept.substring(Math.max(0, kept.length() - 120)));
        assertFalse(kept.contains("compiling unit 1 of 850\n"),
                "the head of the log came back instead of the end");
        assertTrue(kept.startsWith("\u2026"),
                "a tail that lost its start has to say so: " + kept.substring(0, 40));
        assertEquals("\u2026" + printed.substring(printed.length() - (ToolOutput.MAX_OUTPUT_CHARS - 1)),
                kept, "the kept output has to be the ellipsis and the log's last chars");
    }

    @Test
    void aCutLogJustPastTheBufferKeepsAnUnbrokenEnd(@TempDir Path cwd) throws IOException {
        // A little more than the drain's buffer of four bytes per char of the
        // cap. The read that crosses the buffer's end puts some of its bytes in
        // front of the ring and the rest into it, and too few bytes follow to
        // write over the whole ring. The text after the ellipsis has to be one
        // unbroken piece of the end of the log.
        StringBuilder log = new StringBuilder();
        int line = 0;
        while (log.length() < 4 * ToolOutput.MAX_OUTPUT_CHARS + 1_000) {
            log.append(String.format(Locale.ROOT, "line %05d of the log\n", ++line));
        }
        log.append("FAILED: line ").append(line).append(" was the last\n");
        String printed = log.toString();
        int size = printed.getBytes(StandardCharsets.UTF_8).length;
        assertTrue(size > 4 * ToolOutput.MAX_OUTPUT_CHARS
                        && size < 4 * ToolOutput.MAX_OUTPUT_CHARS + 1_800,
                "the log has to end just past the buffer, it is " + size + " bytes");
        Files.writeString(cwd.resolve("log.txt"), printed, StandardCharsets.UTF_8);

        String kept = outputAfterMarker(runCommand(1, "cat log.txt; exec sleep 10", cwd));

        assertTrue(kept.startsWith("\u2026"),
                "a tail that lost its start has to say so: " + kept.substring(0, 40));
        assertTrue(printed.endsWith(kept.substring(1)),
                "the text after the ellipsis is not one piece of the log's end. It starts with: "
                        + kept.substring(0, Math.min(kept.length(), 60)));
        assertTrue(kept.length() <= ToolOutput.MAX_OUTPUT_CHARS,
                "the output cap has to hold on the cut too, got " + kept.length());
        assertTrue(kept.length() > ToolOutput.MAX_OUTPUT_CHARS * 9 / 10,
                "the kept tail is a sliver of the cap, got " + kept.length());
    }

    // ---- the path that finishes is not moved by this card ---------------------------

    /** What the drain handed back for a finished command before card 384: the
     *  first four bytes per char of the cap, decoded, clipped to the cap.
     *  @param bytes everything the command printed
     *  @param max   the caller's char cap
     *  @return the output a finished command got */
    private static String headBeforeThisCard(byte[] bytes, int max) {
        int kept = Math.min(bytes.length, max * 4);
        return ToolOutput.clip(new String(bytes, 0, kept, StandardCharsets.UTF_8), max);
    }

    /** The same for a goal check, which keeps the tail.
     *  @param bytes everything the command printed
     *  @param max   the caller's char cap
     *  @return the output a finished check got */
    private static String tailBeforeThisCard(byte[] bytes, int max) {
        int held = max * 4;
        if (bytes.length <= held) {
            return ToolOutput.clipTail(new String(bytes, StandardCharsets.UTF_8), max);
        }
        int from = bytes.length - held;
        while (from < bytes.length && (bytes[from] & 0xC0) == 0x80) {
            from++;
        }
        return ToolOutput.clipTail(
                new String(bytes, from, bytes.length - from, StandardCharsets.UTF_8), max);
    }

    /** Streams whose cut points land on every kind of byte: one-byte text,
     *  three-byte text, four-byte text, three-byte text with a four-byte
     *  character across the three-quarter mark at each alignment, and random
     *  bytes that are mostly not valid UTF-8. */
    private static List<byte[]> streams() {
        List<byte[]> streams = new java.util.ArrayList<>();
        streams.add("x".repeat(200_000).getBytes(StandardCharsets.UTF_8));
        streams.add("中".repeat(20_000).getBytes(StandardCharsets.UTF_8));
        streams.add("😀".repeat(20_000).getBytes(StandardCharsets.UTF_8));
        for (int shift = 0; shift < 4; shift++) {
            streams.add(("a".repeat(shift) + "中".repeat(9_999)
                    + "😀".repeat(3_000)).getBytes(StandardCharsets.UTF_8));
        }
        java.util.Random random = new java.util.Random(384);
        for (int i = 0; i < 6; i++) {
            byte[] noise = new byte[60_000 + random.nextInt(40_000)];
            random.nextBytes(noise);
            streams.add(noise);
        }
        for (int i = 0; i < 6; i++) {
            StringBuilder mixed = new StringBuilder();
            while (mixed.length() < 40_000) {
                switch (random.nextInt(4)) {
                    case 0 -> mixed.append('a');
                    case 1 -> mixed.append('é');
                    case 2 -> mixed.append('中');
                    default -> mixed.append("😀");
                }
            }
            streams.add(mixed.toString().getBytes(StandardCharsets.UTF_8));
        }
        return streams;
    }

    @Test
    void aCommandThatFinishesHandsBackTheSameHeadAsBefore(@TempDir Path cwd) throws IOException {
        int max = ToolOutput.MAX_OUTPUT_CHARS;
        int n = 0;
        for (byte[] stream : streams()) {
            Path file = cwd.resolve("stream-" + n++);
            Files.write(file, stream);
            ShellCommand.Result result = ShellCommand.run("cat " + file.getFileName(),
                    Map.of(), cwd, 30, new CancelSignal(), max);
            assertEquals(0, result.exitCode(), result.failure());
            assertEquals(headBeforeThisCard(stream, max), result.output(),
                    "the head of a finished command moved, stream " + (n - 1)
                            + " of " + stream.length + " bytes");
        }
    }

    @Test
    void aCheckThatFinishesHandsBackTheSameTailAsBefore(@TempDir Path cwd) throws IOException {
        int max = 4_000;
        int n = 0;
        for (byte[] stream : streams()) {
            Path file = cwd.resolve("stream-" + n++);
            Files.write(file, stream);
            ShellCommand.Result result = ShellCommand.run("cat " + file.getFileName(),
                    Map.of(), cwd, 30, new CancelSignal(), max, true);
            assertEquals(0, result.exitCode(), result.failure());
            assertEquals(tailBeforeThisCard(stream, max), result.output(),
                    "the tail of a finished check moved, stream " + (n - 1)
                            + " of " + stream.length + " bytes");
        }
    }

    @Test
    void aStoppedCommandStillHandsBackWhatItPrinted(@TempDir Path cwd) {
        // The card's second note: on a stop by hand, waitFor returns because the
        // process was killed, and the normal path already returns the output.
        // This card leaves that path alone; the test says it is so.
        CancelSignal signal = new CancelSignal();
        Thread canceller = Thread.ofVirtual().start(() -> {
            try {
                Thread.sleep(500);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            signal.cancel();
        });
        Tool tool = StandardTools.all(30).stream()
                .filter(candidate -> "run_command".equals(candidate.name()))
                .findFirst().orElseThrow();
        String result = tool.execute(JSON.createObjectNode()
                        .put("command", "printf 'printed before the stop\\n'; exec sleep 30"),
                new Tool.ToolContext(cwd, signal));
        try {
            canceller.join();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        assertTrue(result.startsWith("ERROR: exit code "), result);
        assertTrue(result.contains("printed before the stop"), result);
    }
}
