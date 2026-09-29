package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.session.CompactionThreshold;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 456: a whole-file read is bounded by the context window the run has,
 * plus a fixed fuse in bytes. The owner's case: a 56 kB CLAUDE.md, refused by
 * a 50 kB constant nobody chose, under a loaded window of 250,368 tokens.
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class ReadBudgetTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The window the owner's LM Studio instance served, measured 2026-08-17. */
    private static final int LOADED_WINDOW = 250_368;

    /** Small enough that a quarter of it cannot hold a 56 kB file. */
    private static final int SMALL_WINDOW = 32_768;

    /** The size of the owner's file in the report. */
    private static final int OWNER_FILE_BYTES = 56_000;

    private static Map<String, Tool> tools() {
        return StandardTools.all(10).stream()
                .collect(Collectors.toMap(Tool::name, Function.identity()));
    }

    /** A context that carries the window the loop derived for this run. */
    private static ToolContext windowed(Path cwd, int window) {
        return new ToolContext(cwd, new CancelSignal(), "main", "c1", event -> { },
                attachment -> { }, change -> { }, millis -> { }, false, window);
    }

    private static ObjectNode path(String relative) {
        return JSON.createObjectNode().put("path", relative);
    }

    /** ASCII markdown of exactly {@code bytes} bytes, ending in a newline. */
    private static String markdown(int bytes) {
        StringBuilder text = new StringBuilder();
        int section = 0;
        while (text.length() < bytes) {
            text.append("## Section ").append(++section).append('\n')
                    .append("Plain prose about the project, one line of it.\n");
        }
        text.setLength(bytes - 1);
        return text.append('\n').toString();
    }

    // ---- read_file, whole ----------------------------------------------------------

    @Test
    void aFiftySixKilobyteFileReadsWholeUnderTheWindowTheOwnerLoaded(@TempDir Path cwd)
            throws IOException {
        String text = markdown(OWNER_FILE_BYTES);
        Files.writeString(cwd.resolve("CLAUDE.md"), text);

        String read = tools().get("read_file").execute(path("CLAUDE.md"),
                windowed(cwd, LOADED_WINDOW));

        assertEquals(text, read, "the whole file comes back in one answer");
    }

    @Test
    void theSameFileUnderASmallWindowIsRefusedWithEveryFactItWasJudgedOn(@TempDir Path cwd)
            throws IOException {
        Files.writeString(cwd.resolve("CLAUDE.md"), markdown(OWNER_FILE_BYTES));

        String refused = tools().get("read_file").execute(path("CLAUDE.md"),
                windowed(cwd, SMALL_WINDOW));

        assertTrue(refused.startsWith("ERROR: "), refused);
        assertTrue(refused.contains(OWNER_FILE_BYTES + " bytes"), "names the size: " + refused);
        assertTrue(refused.contains(ReadBudget.estimatedTokens(OWNER_FILE_BYTES) + " tokens"),
                "names the estimated tokens: " + refused);
        assertTrue(refused.contains(SMALL_WINDOW + " tokens"), "names the window: " + refused);
        assertTrue(refused.contains(ReadBudget.WINDOW_SHARE_PERCENT + " %"),
                "names the share: " + refused);
        assertTrue(refused.contains("offset") && refused.contains("limit"),
                "still offers paging: " + refused);
    }

    @Test
    void aFileAboveTheFuseIsRefusedUnderAnyWindow(@TempDir Path cwd) throws IOException {
        long size = ReadBudget.FUSE_BYTES + 1;
        Files.write(cwd.resolve("giant.log"), new byte[(int) size]);

        for (int window : List.of(0, SMALL_WINDOW, LOADED_WINDOW, 2_000_000, Integer.MAX_VALUE)) {
            String refused = tools().get("read_file").execute(path("giant.log"),
                    windowed(cwd, window));
            assertTrue(refused.startsWith("ERROR: "), "window " + window + ": " + refused);
            assertTrue(refused.contains(size + " bytes"), "names the size: " + refused);
            assertTrue(refused.contains(String.valueOf(ReadBudget.FUSE_BYTES)),
                    "names the fuse: " + refused);
            assertTrue(refused.contains("offset") && refused.contains("limit"),
                    "offers paging: " + refused);
        }
    }

    @Test
    void theBoundaryIsExactOnBothSides(@TempDir Path cwd) throws IOException {
        long bound = ReadBudget.wholeReadBytes(SMALL_WINDOW);
        Files.writeString(cwd.resolve("fits.md"), markdown((int) bound));
        Files.writeString(cwd.resolve("over.md"), markdown((int) bound + 1));

        assertFalse(tools().get("read_file").execute(path("fits.md"), windowed(cwd, SMALL_WINDOW))
                .startsWith("ERROR: "), "a file of exactly the bound reads");
        assertTrue(tools().get("read_file").execute(path("over.md"), windowed(cwd, SMALL_WINDOW))
                .startsWith("ERROR: "), "one byte over the bound is refused");
    }

    @Test
    void aRunWithNoKnownWindowIsJudgedAgainstTheCompactionFallback(@TempDir Path cwd)
            throws IOException {
        long bound = ReadBudget.wholeReadBytes(CompactionThreshold.FALLBACK_THRESHOLD);
        Files.writeString(cwd.resolve("over.md"), markdown((int) bound + 1));

        String refused = tools().get("read_file").execute(path("over.md"), windowed(cwd, 0));

        assertTrue(refused.startsWith("ERROR: "), refused);
        assertTrue(refused.contains(CompactionThreshold.FALLBACK_THRESHOLD + " tokens"),
                "an unknown window is named as the fallback it was judged on: " + refused);
        assertEquals(ReadBudget.wholeReadBytes(CompactionThreshold.FALLBACK_THRESHOLD),
                ReadBudget.wholeReadBytes(0), "0 is not a window, it is 'nothing known'");
    }

    // ---- read_file, paged ----------------------------------------------------------

    @Test
    void aPagedWindowIsCountedInBytesLikeItsBound(@TempDir Path cwd) throws IOException {
        // Two-byte characters: a page whose CHARACTER count is under the bound
        // while its BYTE count is over it. Counted in characters, it would pass.
        long bound = ReadBudget.wholeReadBytes(8_192);
        int perLine = 100;
        int lines = (int) (bound / (perLine + 1));
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < lines * 2; i++) {
            text.append("ä".repeat(perLine)).append('\n');
        }
        Files.writeString(cwd.resolve("umlauts.txt"), text.toString());
        ObjectNode page = path("umlauts.txt");
        page.put("offset", 1).put("limit", lines);
        int chars = lines * (perLine + 1) - 1;
        assertTrue(chars <= bound, "the premise: in characters the page fits (" + chars + ")");

        String refused = tools().get("read_file").execute(page, windowed(cwd, 8_192));

        assertTrue(refused.startsWith("ERROR: "), "counted in bytes it does not: " + refused);
        assertTrue(refused.contains("bytes"), refused);
    }

    @Test
    void aPagedWindowUnderTheBoundStillReads(@TempDir Path cwd) throws IOException {
        StringBuilder text = new StringBuilder();
        for (int i = 1; i <= 3_000; i++) {
            text.append("line ").append(i).append('\n');
        }
        Files.writeString(cwd.resolve("long.txt"), text.toString());
        ObjectNode page = path("long.txt");
        page.put("offset", 2_999).put("limit", 10);

        assertEquals("line 2999\nline 3000",
                tools().get("read_file").execute(page, windowed(cwd, 8_192)));
    }

    // ---- the model-facing words ----------------------------------------------------

    @Test
    void theDescriptionStatesTheRuleAndThePagingEscapeInsteadOfAByteCount() {
        String description = tools().get("read_file").description();

        assertFalse(description.contains("50 kB"), description);
        assertTrue(description.contains("context window"), description);
        assertTrue(description.contains("offset") && description.contains("limit"), description);
    }

    // ---- grep ----------------------------------------------------------------------

    @Test
    void grepFindsAHitInAFileBetweenTheOldCapAndTheFuse(@TempDir Path cwd) throws IOException {
        Files.writeString(cwd.resolve("CLAUDE.md"), markdown(OWNER_FILE_BYTES) + "needle-456\n");

        String hits = tools().get("grep").execute(
                JSON.createObjectNode().put("pattern", "needle-456"), windowed(cwd, LOADED_WINDOW));

        assertTrue(hits.contains("CLAUDE.md:"), "the hit inside a 56 kB file is found: " + hits);
    }

    @Test
    void grepNamesAFileItSkipsInsteadOfDroppingItSilently(@TempDir Path cwd) throws IOException {
        byte[] giant = new byte[(int) ReadBudget.FUSE_BYTES + 1];
        byte[] needle = "needle-456\n".getBytes(StandardCharsets.UTF_8);
        java.util.Arrays.fill(giant, (byte) 'x');
        System.arraycopy(needle, 0, giant, 0, needle.length);
        Files.write(cwd.resolve("giant.log"), giant);
        Files.writeString(cwd.resolve("small.txt"), "needle-456\n");

        String hits = tools().get("grep").execute(
                JSON.createObjectNode().put("pattern", "needle-456"), windowed(cwd, LOADED_WINDOW));

        assertTrue(hits.contains("small.txt:1:needle-456"), "the readable hit stays: " + hits);
        assertFalse(hits.contains("giant.log:1:"), "the giant file is not searched: " + hits);
        assertTrue(hits.contains("giant.log"), "but it is named as skipped: " + hits);
        assertTrue(hits.contains(String.valueOf(ReadBudget.FUSE_BYTES)),
                "with the fuse that skipped it: " + hits);
    }

    // ---- edit_file -----------------------------------------------------------------

    @Test
    void editFileWorksOnAFileOverTheOldFiftyKilobytes(@TempDir Path cwd) throws IOException {
        Files.writeString(cwd.resolve("CLAUDE.md"), markdown(OWNER_FILE_BYTES) + "old tail\n");
        ObjectNode edit = JSON.createObjectNode().put("path", "CLAUDE.md")
                .put("old_string", "old tail").put("new_string", "new tail");

        String answer = tools().get("edit_file").execute(edit, windowed(cwd, SMALL_WINDOW));

        assertFalse(answer.startsWith("ERROR: "), answer);
        assertTrue(Files.readString(cwd.resolve("CLAUDE.md")).endsWith("new tail\n"));
    }

    @Test
    void editFileStillRefusesAFileAboveTheFuse(@TempDir Path cwd) throws IOException {
        Files.write(cwd.resolve("giant.log"), new byte[(int) ReadBudget.FUSE_BYTES + 1]);
        ObjectNode edit = JSON.createObjectNode().put("path", "giant.log")
                .put("old_string", "a").put("new_string", "b");

        String answer = tools().get("edit_file").execute(edit, windowed(cwd, LOADED_WINDOW));

        assertTrue(answer.startsWith("ERROR: "), answer);
        assertTrue(answer.contains(String.valueOf(ReadBudget.FUSE_BYTES)), answer);
    }
}
