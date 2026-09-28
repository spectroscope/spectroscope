package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 453, criteria 3, 4 and 7: the working-directory fence of the seven file
 * tools opens in the {@code extended} mode and stays closed, with the same
 * refusal text, in every other mode.
 *
 * <p>The layout is the owner's case: the agent works in an inner folder, and
 * the file it needs lives one level up.</p>
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class ExtendedFenceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final Map<String, Tool> TOOLS = StandardTools.all(10).stream()
            .collect(Collectors.toMap(Tool::name, Function.identity()));

    @TempDir
    Path outer;

    private Path cwd;

    @BeforeEach
    void layout() throws IOException {
        cwd = Files.createDirectories(outer.resolve("inner"));
        Files.writeString(outer.resolve("note.txt"), "outside line\n");
        Files.write(outer.resolve("doc.pdf"), "%PDF-1.4\n%%EOF\n".getBytes());
    }

    /** The fence closed: the context every mode but extended hands the tools. */
    private ToolContext fenced() {
        return new ToolContext(cwd, new CancelSignal());
    }

    /** The fence open: the context the extended mode hands the tools. */
    private ToolContext extended() {
        return new ToolContext(cwd, new CancelSignal(), "main", "c1", event -> { },
                attachment -> { }, change -> { }, millis -> { }, true);
    }

    private static String run(String tool, ObjectNode input, ToolContext context) {
        return TOOLS.get(tool).execute(input, context);
    }

    private static ObjectNode path(String value) {
        return JSON.createObjectNode().put("path", value);
    }

    /** One call per fenced tool, aimed at {@code file} or the folder {@code dir}. */
    private static Map<String, ObjectNode> callsAt(String file, String dir) {
        Map<String, ObjectNode> calls = new LinkedHashMap<>();
        calls.put("view_file", path(dir + "/doc.pdf"));
        calls.put("read_file", path(file));
        calls.put("list_dir", path(dir));
        calls.put("edit_file", path(file).put("old_string", "outside").put("new_string", "edited"));
        calls.put("write_file", path(file).put("content", "written\n"));
        calls.put("glob", path(dir).put("pattern", "*.txt"));
        calls.put("grep", path(dir).put("pattern", "outside"));
        return calls;
    }

    // ---------------------------------------------------------------- criterion 4

    @Test
    void everyOtherModeRefusesEachToolWithTheUnchangedText() {
        callsAt("../note.txt", "..").forEach((tool, input) -> {
            String expected = "ERROR: path is outside the working directory: "
                    + input.path("path").asText();
            assertEquals(expected, run(tool, input, fenced()),
                    tool + " must refuse with today's text, byte for byte");
        });
    }

    @Test
    void anAbsolutePathOutsideIsRefusedWithTheUnchangedText() {
        String absolute = outer.resolve("note.txt").toString();
        assertEquals("ERROR: path is outside the working directory: " + absolute,
                run("read_file", path(absolute), fenced()));
    }

    // ---------------------------------------------------------------- criterion 3

    @Test
    void extendedOpensTheFenceForEachToolWithARelativePath() throws IOException {
        Map<String, ObjectNode> calls = callsAt("../note.txt", "..");
        assertTrue(run("view_file", calls.get("view_file"), extended()).startsWith("Attached doc.pdf"));
        assertEquals("outside line\n", run("read_file", calls.get("read_file"), extended()));
        assertTrue(run("list_dir", calls.get("list_dir"), extended()).contains("note.txt"));
        assertTrue(run("glob", calls.get("glob"), extended()).contains("note.txt"));
        assertTrue(run("grep", calls.get("grep"), extended()).contains("note.txt:1:outside line"));
        String edited = run("edit_file", calls.get("edit_file"), extended());
        assertTrue(edited.startsWith("Edited: ../note.txt"), edited);
        assertEquals("edited line\n", Files.readString(outer.resolve("note.txt")));
        String written = run("write_file", calls.get("write_file"), extended());
        assertTrue(written.startsWith("Wrote: ../note.txt"), written);
        assertEquals("written\n", Files.readString(outer.resolve("note.txt")));
    }

    @Test
    void extendedOpensTheFenceForEachToolWithAnAbsolutePath() throws IOException {
        String dir = outer.toString();
        String file = outer.resolve("note.txt").toString();
        Map<String, ObjectNode> calls = callsAt(file, dir);
        calls.forEach((tool, input) -> {
            String result = run(tool, input, extended());
            assertFalse(result.startsWith("ERROR: "), tool + " refused an absolute path: " + result);
        });
        assertEquals("written\n", Files.readString(outer.resolve("note.txt")),
                "the last call wrote through the absolute path");
    }

    @Test
    void extendedWritesANewFileAboveTheWorkingFolder() throws IOException {
        String result = run("write_file", path("../fresh.txt").put("content", "new\n"), extended());
        assertTrue(result.startsWith("Wrote: ../fresh.txt"), result);
        assertEquals("new\n", Files.readString(outer.resolve("fresh.txt")));
    }

    @Test
    void extendedWritesANewFileInDirectoriesThatDoNotExistYet() throws IOException {
        String result = run("write_file",
                path("../made/on/demand.txt").put("content", "deep\n"), extended());
        assertTrue(result.startsWith("Wrote: ../made/on/demand.txt"), result);
        assertEquals("deep\n", Files.readString(outer.resolve("made/on/demand.txt")));
    }

    @Test
    void theSameNewFileIsRefusedWhenTheFenceIsClosed() {
        assertEquals("ERROR: path is outside the working directory: ../fresh.txt",
                run("write_file", path("../fresh.txt").put("content", "new\n"), fenced()));
        assertFalse(Files.exists(outer.resolve("fresh.txt")));
    }

    @Test
    void aRelativePathStillResolvesAgainstTheWorkingDirectory() throws IOException {
        String result = run("write_file", path("sub/in.txt").put("content", "in\n"), extended());
        assertTrue(result.startsWith("Wrote: sub/in.txt"), result);
        assertEquals("in\n", Files.readString(cwd.resolve("sub/in.txt")));
        assertFalse(Files.exists(outer.resolve("sub/in.txt")));
    }

    @Test
    void aMissingFileOutsideIsAMissingFileAndNotTheFence() {
        String result = run("read_file", path("../missing.txt"), extended());
        assertTrue(result.startsWith("ERROR: "), result);
        assertFalse(result.contains("outside the working directory"),
                "extended must not answer a typo with the fence text: " + result);
    }

    @Test
    void aLinkPointingOutsideIsFollowedInExtendedAndRefusedOtherwise() throws IOException {
        Files.createSymbolicLink(cwd.resolve("link.txt"), outer.resolve("note.txt"));
        assertEquals("ERROR: path is outside the working directory: link.txt",
                run("read_file", path("link.txt"), fenced()));
        assertEquals("outside line\n", run("read_file", path("link.txt"), extended()));
    }

    // ---------------------------------------------------------------- criterion 7

    @Test
    void theLaunchFileRefusalHoldsInExtendedInsideTheWorkingFolder() {
        String result = run("write_file",
                path(".spectro/launch.json").put("content", "{}"), extended());
        assertTrue(result.startsWith("ERROR: write_file will not author .spectro/launch.json"), result);
    }

    @Test
    void theLaunchFileRefusalHoldsInExtendedForAFolderAbove() {
        String result = run("write_file",
                path("../.spectro/launch.json").put("content", "{}"), extended());
        assertTrue(result.startsWith("ERROR: write_file will not author .spectro/launch.json"), result);
        assertFalse(Files.exists(outer.resolve(".spectro/launch.json")));
    }
}
