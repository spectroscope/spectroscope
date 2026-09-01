package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** The safeguards of the built-in tools: sandbox, size cap, timeout, error contract. */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class StandardToolsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Tools by name — collectors keep the lookup readable. */
    private static Map<String, Tool> tools(long commandTimeoutSeconds) {
        return StandardTools.all(commandTimeoutSeconds).stream()
                .collect(Collectors.toMap(Tool::name, Function.identity()));
    }

    private static ToolContext contextIn(Path cwd) {
        return new ToolContext(cwd, new CancelSignal());
    }

    /** A context that keeps what the tool reported about the file (card 269). */
    private static ToolContext reportingContextIn(Path cwd, List<Tool.FileChange> into) {
        return new ToolContext(cwd, new CancelSignal(), "main", "c1", event -> { },
                attachment -> { }, into::add, millis -> { });
    }

    private static ObjectNode input(String field, String value) {
        return JSON.createObjectNode().put(field, value);
    }

    @Test
    void everyToolAdvertisesAnObjectSchemaWithARequiredField() {
        StandardTools.all().forEach(tool -> {
            assertEquals("object", tool.inputSchema().path("type").asText());
            assertTrue(tool.inputSchema().path("required").isArray(),
                    tool.name() + " must declare its required parameter");
        });
    }

    @Test
    void writesAndCommandsNeedPermission() {
        // Real tools: write_file, run_command and edit_file are the mutating,
        // permission-gated tools (grep/glob are read-only). Order = registration order.
        List<String> guarded = StandardTools.all().stream()
                .filter(Tool::needsPermission)
                .map(Tool::name)
                .toList();
        assertEquals(List.of("write_file", "run_command", "edit_file"), guarded);
    }

    // ------------------------------------------------- write_file: the difference

    /**
     * Card 269. The measured loop wrote the same 31 files and asked the harness,
     * in the model's own words, whether anything had moved — then spent a whole
     * turn on a read_file to find out. The write already knew.
     */
    @Test
    void writeFileSaysWhetherItCreatedOrChangedTheFile(@TempDir Path cwd) throws IOException {
        Tool write = tools(10).get("write_file");

        ObjectNode fresh = JSON.createObjectNode();
        fresh.put("path", "pi.py");
        fresh.put("content", "import math\n");
        assertEquals("Wrote: pi.py (12 bytes) — created",
                write.execute(fresh, contextIn(cwd)));

        ObjectNode grown = JSON.createObjectNode();
        grown.put("path", "pi.py");
        grown.put("content", "import math\nprint(math.pi)\n");
        // The delta is the SIZE, not the line count: a different length proves a
        // different file without opening it, and opening it to count lines would
        // buy prose at the price of the read this card promised not to make.
        assertEquals("Wrote: pi.py (27 bytes) — changed (+15 bytes)",
                write.execute(grown, contextIn(cwd)));

        // Same length, other bytes: a signed delta of zero would read as "nothing
        // happened", which is the exact confusion this card exists to end.
        ObjectNode swapped = JSON.createObjectNode();
        swapped.put("path", "pi.py");
        swapped.put("content", "import math\nprint(math.e_)\n");
        assertEquals("Wrote: pi.py (27 bytes) — changed (same size, different bytes)",
                write.execute(swapped, contextIn(cwd)));
    }

    /**
     * The pin that matters (card 269, AC 5): three identical writes in a row each
     * report unchanged, and the third does not report changed. A guard that only
     * catches the SECOND write would let the 31-file loop run on from there.
     */
    @Test
    void threeIdenticalWritesEachSayUnchangedAndNeverSayChanged(@TempDir Path cwd) {
        Tool write = tools(10).get("write_file");
        ObjectNode same = JSON.createObjectNode();
        same.put("path", "src/particleEngine.js");
        same.put("content", "export const spawn = () => {};\n");
        List<Tool.FileChange> reported = new ArrayList<>();

        assertEquals("Wrote: src/particleEngine.js (31 bytes) — created",
                write.execute(same, reportingContextIn(cwd, reported)));
        for (int attempt = 2; attempt <= 4; attempt++) {
            assertEquals("Wrote: src/particleEngine.js (31 bytes) — unchanged (the file already"
                            + " contained exactly these bytes)",
                    write.execute(same, reportingContextIn(cwd, reported)), "write #" + attempt);
        }
        // The word, not the prose: "unchanged" CONTAINS "changed", so a substring
        // pin on the sentence would pass while the field said the opposite.
        assertEquals(List.of(Tool.FileChange.CREATED, Tool.FileChange.UNCHANGED,
                        Tool.FileChange.UNCHANGED, Tool.FileChange.UNCHANGED), reported,
                "the third identical write must still say unchanged, never changed");
    }

    @Test
    void anUnreadableFileMakesNoClaimRatherThanAWrongOne(@TempDir Path cwd) throws IOException {
        Path writeOnly = cwd.resolve("write-only.txt");
        Files.writeString(writeOnly, "abc\n");
        assumeTrue(Files.getFileStore(writeOnly).supportsFileAttributeView("posix"),
                "the case needs POSIX permissions to build");
        Files.setPosixFilePermissions(writeOnly, PosixFilePermissions.fromString("-w-------"));
        assumeTrue(!Files.isReadable(writeOnly), "running as root reads it anyway");

        ObjectNode in = JSON.createObjectNode();
        in.put("path", "write-only.txt");
        in.put("content", "xyz\n"); // same length, so the size shortcut cannot answer
        // The write itself is allowed; only the comparison is not. Reporting
        // "unchanged" here would be a guess, and an ERROR would break a write
        // that works — so the line falls back to exactly its pre-269 shape.
        assertEquals("Wrote: write-only.txt (4 bytes)",
                tools(10).get("write_file").execute(in, contextIn(cwd)));
        Files.setPosixFilePermissions(writeOnly, PosixFilePermissions.fromString("rw-------"));
        assertEquals("xyz\n", Files.readString(writeOnly), "the write still happened");
    }

    // ---------------------------------------------------------------- edit_file

    /**
     * Card 269, AC 2: "I found nothing to replace" and "I replaced it with
     * itself" are different news, and a loop that cannot tell them apart keeps
     * sending the second one.
     */
    @Test
    void editFileSeparatesAReplacementWithItselfFromNothingToReplace(@TempDir Path cwd) throws IOException {
        Files.writeString(cwd.resolve("config.txt"), "port=8080\n");
        Tool edit = tools(10).get("edit_file");

        ObjectNode itself = JSON.createObjectNode();
        itself.put("path", "config.txt");
        itself.put("old_string", "port=8080");
        itself.put("new_string", "port=8080");
        assertEquals("Edited: config.txt (1 replacement) — unchanged (the replacement produced"
                + " identical content)", edit.execute(itself, contextIn(cwd)));

        ObjectNode absent = JSON.createObjectNode();
        absent.put("path", "config.txt");
        absent.put("old_string", "port=9999");
        absent.put("new_string", "port=8080");
        assertEquals("ERROR: old_string not found in config.txt.",
                edit.execute(absent, contextIn(cwd)));
    }

    /**
     * Card 269, AC 2 and AC 3 for edit_file — the FIELD half, which the verify
     * pass of 2026-08-17 found pinned by nothing: deleting the one line that
     * publishes an edit's outcome left all 1460 core tests green, because the
     * test above builds its context without a change sink and reads only the
     * sentence. The sentence is the echo; the field is what the tool card, the
     * export and card 262's guard actually read.
     *
     * <p>The no-match case is here on purpose too: it reports NO word at all.
     * "I found nothing to replace" is a fact about the call, not about the file,
     * and inventing an outcome for it would tell the loop the file is fine.
     */
    @Test
    void editFileReportsWhatItDidAsAFieldAndSaysNothingWhenItFoundNothing(@TempDir Path cwd)
            throws IOException {
        Files.writeString(cwd.resolve("config.txt"), "port=8080\nhost=localhost\n");
        Tool edit = tools(10).get("edit_file");
        List<Tool.FileChange> reported = new ArrayList<>();

        ObjectNode itself = JSON.createObjectNode();
        itself.put("path", "config.txt");
        itself.put("old_string", "port=8080");
        itself.put("new_string", "port=8080");
        edit.execute(itself, reportingContextIn(cwd, reported));

        ObjectNode real = JSON.createObjectNode();
        real.put("path", "config.txt");
        real.put("old_string", "host=localhost");
        real.put("new_string", "host=127.0.0.1");
        edit.execute(real, reportingContextIn(cwd, reported));

        ObjectNode absent = JSON.createObjectNode();
        absent.put("path", "config.txt");
        absent.put("old_string", "port=9999");
        absent.put("new_string", "port=8080");
        edit.execute(absent, reportingContextIn(cwd, reported));

        assertEquals(List.of(Tool.FileChange.UNCHANGED, Tool.FileChange.CHANGED), reported,
                "the replacement with itself, then the real one, and no word for the no-match");
    }

    @Test
    void editFileReplacesAUniqueString(@TempDir Path cwd) throws IOException {
        Files.writeString(cwd.resolve("config.txt"), "host=localhost\nport=8080\n");
        ObjectNode in = JSON.createObjectNode();
        in.put("path", "config.txt");
        in.put("old_string", "port=8080");
        in.put("new_string", "port=9090");
        assertEquals("Edited: config.txt (1 replacement) — changed (same size, different bytes)",
                tools(10).get("edit_file").execute(in, contextIn(cwd)));
        assertEquals("host=localhost\nport=9090\n",
                Files.readString(cwd.resolve("config.txt")));
    }

    @Test
    void editFileRejectsMissingAndNonUniqueStrings(@TempDir Path cwd) throws IOException {
        Files.writeString(cwd.resolve("a.txt"), "x\nx\n");

        ObjectNode missing = JSON.createObjectNode();
        missing.put("path", "a.txt");
        missing.put("old_string", "y");
        missing.put("new_string", "z");
        assertEquals("ERROR: old_string not found in a.txt.",
                tools(10).get("edit_file").execute(missing, contextIn(cwd)));

        ObjectNode ambiguous = JSON.createObjectNode();
        ambiguous.put("path", "a.txt");
        ambiguous.put("old_string", "x");
        ambiguous.put("new_string", "y");
        String result = tools(10).get("edit_file").execute(ambiguous, contextIn(cwd));
        assertTrue(result.startsWith("ERROR: old_string is not unique (2 matches)"), result);
        assertEquals("x\nx\n", Files.readString(cwd.resolve("a.txt")), "a rejected edit writes nothing");

        ambiguous.put("replace_all", true);
        assertEquals("Edited: a.txt (2 replacements) — changed (same size, different bytes)",
                tools(10).get("edit_file").execute(ambiguous, contextIn(cwd)));
        assertEquals("y\ny\n", Files.readString(cwd.resolve("a.txt")));
    }

    @Test
    void editFileRejectsPathsOutsideTheWorkingDirectory(@TempDir Path cwd) {
        ObjectNode escape = JSON.createObjectNode();
        escape.put("path", "../../etc/passwd");
        escape.put("old_string", "root");
        escape.put("new_string", "x");
        String result = tools(10).get("edit_file").execute(escape, contextIn(cwd));
        assertTrue(result.startsWith("ERROR: "));
        assertTrue(result.contains("outside the working directory"));
    }

    // ---------------------------------------------------------------- glob

    @Test
    void globFindsFilesByPatternAndSkipsIgnoredDirs(@TempDir Path cwd) throws IOException {
        Files.createDirectories(cwd.resolve("src/app"));
        Files.writeString(cwd.resolve("src/app/Main.java"), "class Main {}");
        Files.writeString(cwd.resolve("src/Util.java"), "class Util {}");
        Files.writeString(cwd.resolve("README.md"), "# readme");
        Files.createDirectories(cwd.resolve("build"));
        Files.writeString(cwd.resolve("build/Generated.java"), "class Generated {}");

        String matches = tools(10).get("glob")
                .execute(input("pattern", "**/*.java"), contextIn(cwd));
        assertEquals("src/Util.java\nsrc/app/Main.java", matches);
    }

    @Test
    void globReportsNoMatchesAndRejectsEscapes(@TempDir Path cwd) {
        assertEquals("(no matches)", tools(10).get("glob")
                .execute(input("pattern", "**/*.py"), contextIn(cwd)));

        ObjectNode escape = JSON.createObjectNode();
        escape.put("pattern", "*");
        escape.put("path", "../..");
        String result = tools(10).get("glob").execute(escape, contextIn(cwd));
        assertTrue(result.startsWith("ERROR: "));
        assertTrue(result.contains("outside the working directory"));
    }

    // ---------------------------------------------------------------- grep

    @Test
    void grepFindsMatchingLinesWithLineNumbers(@TempDir Path cwd) throws IOException {
        Files.writeString(cwd.resolve("a.txt"), "first line\nTODO fix me\nlast line");
        Files.writeString(cwd.resolve("b.txt"), "nothing here");

        String hits = tools(10).get("grep")
                .execute(JSON.createObjectNode().put("pattern", "TODO"), contextIn(cwd));
        assertEquals("a.txt:2:TODO fix me\n", hits);
    }

    @Test
    void grepRejectsInvalidRegexAndPathEscapes(@TempDir Path cwd) {
        String bad = tools(10).get("grep")
                .execute(JSON.createObjectNode().put("pattern", "[unclosed"), contextIn(cwd));
        assertTrue(bad.startsWith("ERROR: invalid regex"), bad);

        ObjectNode escape = JSON.createObjectNode();
        escape.put("pattern", "x");
        escape.put("path", "../..");
        String result = tools(10).get("grep").execute(escape, contextIn(cwd));
        assertTrue(result.startsWith("ERROR: "));
        assertTrue(result.contains("outside the working directory"));
    }

    // ---------------------------------------------------------------- sandbox

    @Test
    void pathsOutsideTheWorkingDirectoryAreRejected(@TempDir Path cwd) {
        String listing = tools(10).get("list_dir").execute(input("path", "../.."), contextIn(cwd));
        assertTrue(listing.startsWith("ERROR: "));
        assertTrue(listing.contains("outside the working directory"));

        String read = tools(10).get("read_file")
                .execute(input("path", "../../etc/passwd"), contextIn(cwd));
        assertTrue(read.startsWith("ERROR: "));
    }

    // ------------------------------------- the sandbox is REAL, not lexical (card 367)

    /**
     * The escape, measured before the fix. {@code resolveInside} was
     * {@code base.resolve(relative).normalize()} plus a {@code startsWith} —
     * {@code normalize} resolves {@code ..} in the TEXT and asks the filesystem
     * nothing, while every read and write below follows links. So a link planted
     * inside cwd was inside it lexically and outside it really, and the check
     * could not tell. Each route gets its own test: one test that dies with its
     * neighbours pins nothing.
     *
     * @param tempDir the parent of both the sandbox and the file outside it
     * @return the working directory, with {@code notes.txt} linked to
     *         {@code ../outside.txt} and that file holding {@code content}
     */
    private static Path sandboxWithALinkOut(Path tempDir, String content) throws IOException {
        Path cwd = Files.createDirectory(tempDir.resolve("cwd"));
        Path outside = tempDir.resolve("outside.txt");
        Files.writeString(outside, content);
        Files.createSymbolicLink(cwd.resolve("notes.txt"), outside);
        return cwd;
    }

    @Test
    void aSymlinkPlantedInsideTheSandboxCannotBeReadThrough(@TempDir Path tempDir)
            throws IOException {
        Path cwd = sandboxWithALinkOut(tempDir, "SECRET-OUTSIDE-THE-SANDBOX");

        String read = tools(10).get("read_file")
                .execute(input("path", "notes.txt"), contextIn(cwd));

        assertTrue(read.startsWith("ERROR: path is outside the working directory"), read);
        assertFalse(read.contains("SECRET-OUTSIDE-THE-SANDBOX"), read);
    }

    @Test
    void aSymlinkPlantedInsideTheSandboxCannotBePagedThrough(@TempDir Path tempDir)
            throws IOException {
        // The paging branch takes the same resolved path and streams lines from
        // it, so it is the same escape with a different reader.
        Path cwd = sandboxWithALinkOut(tempDir, "SECRET-OUTSIDE-THE-SANDBOX");
        ObjectNode paged = JSON.createObjectNode();
        paged.put("path", "notes.txt");
        paged.put("offset", 1);
        paged.put("limit", 10);

        String read = tools(10).get("read_file").execute(paged, contextIn(cwd));

        assertTrue(read.startsWith("ERROR: path is outside the working directory"), read);
        assertFalse(read.contains("SECRET-OUTSIDE-THE-SANDBOX"), read);
    }

    @Test
    void aSymlinkPlantedInsideTheSandboxCannotBeWrittenThrough(@TempDir Path tempDir)
            throws IOException {
        // The half that is not a read escape: the tool answered "Wrote: notes.txt"
        // and the file OUTSIDE held the new bytes, so nothing in the transcript
        // named the file that moved.
        Path cwd = sandboxWithALinkOut(tempDir, "ORIGINAL");
        ObjectNode write = JSON.createObjectNode();
        write.put("path", "notes.txt");
        write.put("content", "OVERWRITTEN");

        String result = tools(10).get("write_file").execute(write, contextIn(cwd));

        assertTrue(result.startsWith("ERROR: path is outside the working directory"), result);
        assertEquals("ORIGINAL", Files.readString(tempDir.resolve("outside.txt")),
                "the file outside the sandbox was overwritten through the link");
    }

    @Test
    void aSymlinkPlantedInsideTheSandboxCannotBeEditedThrough(@TempDir Path tempDir)
            throws IOException {
        Path cwd = sandboxWithALinkOut(tempDir, "ORIGINAL");
        ObjectNode edit = JSON.createObjectNode();
        edit.put("path", "notes.txt");
        edit.put("old_string", "ORIGINAL");
        edit.put("new_string", "EDITED-OUTSIDE-THE-SANDBOX");

        String result = tools(10).get("edit_file").execute(edit, contextIn(cwd));

        assertTrue(result.startsWith("ERROR: path is outside the working directory"), result);
        assertEquals("ORIGINAL", Files.readString(tempDir.resolve("outside.txt")),
                "the file outside the sandbox was edited through the link");
    }

    @Test
    void aSymlinkToADirectoryOutsideTheSandboxCannotBeListed(@TempDir Path tempDir)
            throws IOException {
        Path cwd = Files.createDirectory(tempDir.resolve("cwd"));
        Path elsewhere = Files.createDirectory(tempDir.resolve("elsewhere"));
        Files.writeString(elsewhere.resolve("leak.md"), "not for the model");
        Files.createSymbolicLink(cwd.resolve("linked"), elsewhere);

        String listing = tools(10).get("list_dir").execute(input("path", "linked"), contextIn(cwd));

        assertTrue(listing.startsWith("ERROR: path is outside the working directory"), listing);
        assertFalse(listing.contains("leak.md"), listing);
    }

    @Test
    void aSymlinkPlantedInsideTheSandboxCannotBeAttachedAsADocument(@TempDir Path tempDir)
            throws IOException {
        // view_file resolves through the same call site; it needs a .pdf name to
        // get as far as reading, and never validates the bytes.
        Path cwd = Files.createDirectory(tempDir.resolve("cwd"));
        Path outside = tempDir.resolve("outside.pdf");
        Files.writeString(outside, "%PDF-1.4 SECRET-OUTSIDE-THE-SANDBOX");
        Files.createSymbolicLink(cwd.resolve("notes.pdf"), outside);
        List<Tool.AttachedDocument> attached = new ArrayList<>();

        String result = tools(10).get("view_file")
                .execute(input("path", "notes.pdf"), documentContext(cwd, attached));

        assertTrue(result.startsWith("ERROR: path is outside the working directory"), result);
        assertTrue(attached.isEmpty(), "a refused call must attach nothing");
    }

    @Test
    void aSymlinkPlantedInsideTheSandboxCannotBeAttachedAsAnImage(@TempDir Path tempDir)
            throws IOException {
        Path cwd = Files.createDirectory(tempDir.resolve("cwd"));
        Path outside = tempDir.resolve("outside.png");
        javax.imageio.ImageIO.write(new java.awt.image.BufferedImage(
                2, 2, java.awt.image.BufferedImage.TYPE_INT_RGB), "png", outside.toFile());
        Files.createSymbolicLink(cwd.resolve("notes.png"), outside);
        List<Tool.AttachedImage> attached = new ArrayList<>();

        String result = tools(10).get("view_image")
                .execute(input("path", "notes.png"), attachingContext(cwd, attached));

        assertTrue(result.startsWith("ERROR: path is outside the working directory"), result);
        assertTrue(attached.isEmpty(), "a refused call must attach nothing");
    }

    @Test
    void aSymlinkedWalkRootIsRefusedInsteadOfSearchedSilently(@TempDir Path tempDir)
            throws IOException {
        // glob and grep already canonicalized every CANDIDATE, so the escape came
        // back as "(no matches)" — an empty answer that reads like an empty
        // directory. Through the shared rule the root itself is refused, and the
        // model is told which fence it hit.
        Path cwd = Files.createDirectory(tempDir.resolve("cwd"));
        Path elsewhere = Files.createDirectory(tempDir.resolve("elsewhere"));
        Files.writeString(elsewhere.resolve("leak.md"), "not for the model");
        Files.createSymbolicLink(cwd.resolve("linked"), elsewhere);

        ObjectNode globbed = JSON.createObjectNode();
        globbed.put("pattern", "**/*.md");
        globbed.put("path", "linked");
        String matches = tools(10).get("glob").execute(globbed, contextIn(cwd));
        assertTrue(matches.startsWith("ERROR: path is outside the working directory"), matches);

        ObjectNode grepped = JSON.createObjectNode();
        grepped.put("pattern", "model");
        grepped.put("path", "linked");
        String hits = tools(10).get("grep").execute(grepped, contextIn(cwd));
        assertTrue(hits.startsWith("ERROR: path is outside the working directory"), hits);
        assertFalse(hits.contains("not for the model"), hits);
    }

    @Test
    void aDanglingLinkCannotBeUsedToCREATEAFileOutsideTheSandbox(@TempDir Path tempDir)
            throws IOException {
        // The write escape without a file to escape to: the link resolves to
        // nothing, so nothing can prove where it lands — and Files.write would
        // follow it and create the target.
        Path cwd = Files.createDirectory(tempDir.resolve("cwd"));
        Path never = tempDir.resolve("planted.txt");
        Files.createSymbolicLink(cwd.resolve("notes.txt"), never);
        ObjectNode write = JSON.createObjectNode();
        write.put("path", "notes.txt");
        write.put("content", "PLANTED");

        String result = tools(10).get("write_file").execute(write, contextIn(cwd));

        assertTrue(result.startsWith("ERROR: "), result);
        assertFalse(result.startsWith("Wrote:"), result);
        assertFalse(Files.exists(never),
                "a dangling link outside the sandbox was followed and the target created");
    }

    @Test
    void aSymlinkThatStaysInsideTheSandboxStillWorks(@TempDir Path tempDir) throws IOException {
        // The rule is about LEAVING, not about links. A guard that refused every
        // symlink would be a different and wrong rule, and would break ordinary
        // checkouts — node_modules links, worktrees, a linked config.
        Path cwd = Files.createDirectory(tempDir.resolve("cwd"));
        Path real = Files.createDirectory(cwd.resolve("real"));
        Files.writeString(real.resolve("target.txt"), "inside");
        Files.createSymbolicLink(cwd.resolve("alias.txt"), real.resolve("target.txt"));
        Files.createSymbolicLink(cwd.resolve("aliasdir"), real);

        assertEquals("inside", tools(10).get("read_file")
                .execute(input("path", "alias.txt"), contextIn(cwd)));
        assertEquals("target.txt", tools(10).get("list_dir")
                .execute(input("path", "aliasdir"), contextIn(cwd)));

        ObjectNode write = JSON.createObjectNode();
        write.put("path", "alias.txt");
        write.put("content", "written through the link");
        assertTrue(tools(10).get("write_file").execute(write, contextIn(cwd))
                .startsWith("Wrote: alias.txt"));
        assertEquals("written through the link", Files.readString(real.resolve("target.txt")));
    }

    @Test
    void aMissingFileIsStillAMissingFileAndNotAnEscape(@TempDir Path cwd) {
        // toRealPath() throws for a missing file and for a link that leaves, and
        // the two must not collapse into one message: an operator told "outside
        // the working directory" about their own typo looks for a fence that is
        // not there.
        String read = tools(10).get("read_file")
                .execute(input("path", "nope.txt"), contextIn(cwd));

        assertTrue(read.startsWith("ERROR: "), read);
        assertTrue(read.contains("nope.txt"), read);
        assertFalse(read.contains("outside the working directory"), read);
    }

    @Test
    void writeFileStillCreatesAFileAndTheDirectoriesAboveIt(@TempDir Path cwd) throws IOException {
        // The one real behaviour change the canonical form forces: toRealPath()
        // throws for a path that does not exist yet, so the write path proves
        // the DIRECTORY it will land in instead of the file.
        ObjectNode write = JSON.createObjectNode();
        write.put("path", "fresh/deeper/new.txt");
        write.put("content", "hello");

        String result = tools(10).get("write_file").execute(write, contextIn(cwd));

        assertTrue(result.startsWith("Wrote: fresh/deeper/new.txt"), result);
        assertEquals("hello", Files.readString(cwd.resolve("fresh/deeper/new.txt")));
    }

    @Test
    void listDirSortsAndMarksDirectories(@TempDir Path cwd) throws IOException {
        Files.createDirectory(cwd.resolve("src"));
        Files.writeString(cwd.resolve("build.gradle.kts"), "// build");
        String listing = tools(10).get("list_dir").execute(input("path", "."), contextIn(cwd));
        assertEquals("build.gradle.kts\nsrc/", listing);
    }

    // --------------------------------------------------------------- read_file

    @Test
    void readFileReturnsContentAndEnforcesTheCap(@TempDir Path cwd) throws IOException {
        Files.writeString(cwd.resolve("note.txt"), "spectroscope");
        assertEquals("spectroscope", tools(10).get("read_file")
                .execute(input("path", "note.txt"), contextIn(cwd)));

        Files.write(cwd.resolve("big.bin"), new byte[50_001]);
        String tooBig = tools(10).get("read_file").execute(input("path", "big.bin"), contextIn(cwd));
        assertTrue(tooBig.startsWith("ERROR: file too large"));
    }

    // ------------------------------------------------------------- run_command

    @Test
    void runCommandCapturesOutputAndReportsSilence(@TempDir Path cwd) {
        Map<String, Tool> tools = tools(10);
        assertEquals("hello\n", tools.get("run_command")
                .execute(input("command", "echo hello"), contextIn(cwd)));
        assertEquals("(no output)", tools.get("run_command")
                .execute(input("command", "true"), contextIn(cwd)));
    }

    @Test
    void runCommandSurvivesOutputLargerThanThePipeBuffer(@TempDir Path cwd) {
        // The drained runner must not time out on big output (the old wait-then-read
        // pattern deadlocked past the OS pipe buffer); the result is the clipped head.
        String result = tools(5).get("run_command")
                .execute(input("command", "head -c 200000 /dev/zero | tr '\\0' x"), contextIn(cwd));
        assertFalse(result.startsWith("ERROR:"), result);
        assertEquals(10_000, result.length());
    }

    @Test
    void runCommandKillsCommandsThatOutliveTheTimeout(@TempDir Path cwd) {
        String result = tools(1).get("run_command")
                .execute(input("command", "sleep 30"), contextIn(cwd));
        assertTrue(result.startsWith("ERROR: command timed out after 1 s"));
    }

    @Test
    void runCommandKillsCommandsHangingOnStdin(@TempDir Path cwd) {
        String result = tools(1).get("run_command")
                .execute(input("command", "cat"), contextIn(cwd));
        assertTrue(result.startsWith("ERROR: command timed out after 1 s"));
    }

    @Test
    void aCancelledSignalKillsTheRunningCommand(@TempDir Path cwd) {
        CancelSignal signal = new CancelSignal();
        Thread canceller = Thread.ofVirtual().start(() -> {
            try {
                Thread.sleep(200);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            signal.cancel();
        });
        long started = System.currentTimeMillis();
        String result = tools(30).get("run_command")
                .execute(input("command", "sleep 30"), new ToolContext(cwd, signal));
        long elapsed = System.currentTimeMillis() - started;
        assertTrue(elapsed < 5_000, "cancel must kill the child well before the timeout, took " + elapsed);
        assertTrue(result.startsWith("ERROR: "), "a killed command reports an error, got: " + result);
        try {
            canceller.join();
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    // ---- view_file (file_upload) -----------------------------------------

    /** A context whose attach sink collects documents into the given list. */
    private static ToolContext documentContext(Path cwd, List<Tool.AttachedDocument> sink) {
        return new ToolContext(cwd, new CancelSignal(), "main", "c1", event -> { },
                attachment -> {
                    if (attachment instanceof Tool.AttachedDocument document) {
                        sink.add(document);
                    }
                });
    }

    @Test
    void viewFileAttachesASandboxedPdfForTheModel(@TempDir Path cwd) throws IOException {
        byte[] pdf = "%PDF-1.4 fake".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Files.write(cwd.resolve("paper.pdf"), pdf);
        List<Tool.AttachedDocument> attached = new ArrayList<>();

        String output = tools(5).get("view_file")
                .execute(input("path", "paper.pdf"), documentContext(cwd, attached));

        assertFalse(output.startsWith("ERROR: "), output);
        assertTrue(output.contains("paper.pdf"), "the result names the file, got: " + output);
        assertEquals(1, attached.size());
        assertEquals("application/pdf", attached.getFirst().mediaType());
        assertEquals("paper.pdf", attached.getFirst().name());
        assertEquals(java.util.Base64.getEncoder().encodeToString(pdf),
                attached.getFirst().dataBase64());
    }

    @Test
    void viewFileIsPdfOnlyAndPointsAtTheRightTools(@TempDir Path cwd) throws IOException {
        Files.writeString(cwd.resolve("notes.docx"), "not a pdf");
        List<Tool.AttachedDocument> attached = new ArrayList<>();

        String output = tools(5).get("view_file")
                .execute(input("path", "notes.docx"), documentContext(cwd, attached));

        assertTrue(output.startsWith("ERROR: "), output);
        assertTrue(output.contains("pdf"), "names the supported type, got: " + output);
        assertTrue(attached.isEmpty());
    }

    @Test
    void viewFileRefusesOversizedPdfsReadably(@TempDir Path cwd) throws IOException {
        byte[] big = new byte[10 * 1024 * 1024 + 1];
        big[0] = '%';
        Files.write(cwd.resolve("huge.pdf"), big);

        String output = tools(5).get("view_file")
                .execute(input("path", "huge.pdf"), documentContext(cwd, new ArrayList<>()));

        assertTrue(output.startsWith("ERROR: "), output);
        assertTrue(output.contains("10"), "names the limit, got: " + output);
    }

    @Test
    void viewFileStaysInsideTheSandboxAndNeedsNoPermission(@TempDir Path cwd) {
        Tool viewFile = tools(5).get("view_file");
        assertFalse(viewFile.needsPermission(), "read-only inside the sandbox — no gate");
        String output = viewFile.execute(input("path", "../outside.pdf"),
                documentContext(cwd, new ArrayList<>()));
        assertTrue(output.startsWith("ERROR: "), output);
    }

    // ---- read_file paging (file_upload) ------------------------------------

    @Test
    void readFilePagesThroughWithOffsetAndLimit(@TempDir Path cwd) throws IOException {
        StringBuilder content = new StringBuilder();
        for (int line = 1; line <= 30; line++) {
            content.append("line ").append(line).append('\n');
        }
        Files.writeString(cwd.resolve("long.txt"), content.toString());

        ObjectNode paged = input("path", "long.txt");
        paged.put("offset", 11).put("limit", 5);
        String window = tools(10).get("read_file").execute(paged, contextIn(cwd));

        assertEquals("line 11\nline 12\nline 13\nline 14\nline 15", window);
    }

    @Test
    void readFilePagingUnlocksFilesOverTheWholeFileCap(@TempDir Path cwd) throws IOException {
        // 60 kB of lines: whole-file reads refuse (the 50 kB cap), a paged
        // window reads fine — that is the point of paging.
        StringBuilder content = new StringBuilder();
        for (int line = 1; line <= 3_000; line++) {
            content.append("x".repeat(19)).append(' ').append(line).append('\n');
        }
        Files.writeString(cwd.resolve("big.txt"), content.toString());

        String whole = tools(10).get("read_file").execute(input("path", "big.txt"), contextIn(cwd));
        assertTrue(whole.startsWith("ERROR: "), "whole-file read keeps the cap, got: " + whole);

        ObjectNode paged = input("path", "big.txt");
        paged.put("offset", 2_999).put("limit", 10);
        String window = tools(10).get("read_file").execute(paged, contextIn(cwd));
        assertFalse(window.startsWith("ERROR: "), window);
        assertTrue(window.contains("2999") && window.contains("3000"),
                "the tail window is readable, got: " + window);
    }

    // ---- view_image ------------------------------------------------------

    /** A context whose attach sink collects images into the given list. */
    private static ToolContext attachingContext(Path cwd, List<Tool.AttachedImage> sink) {
        return new ToolContext(cwd, new CancelSignal(), "main", "c1", event -> { },
                attachment -> {
                    if (attachment instanceof Tool.AttachedImage image) {
                        sink.add(image);
                    }
                });
    }

    @Test
    void viewImageAttachesTheSandboxedFileForTheModel(@TempDir Path cwd) throws IOException {
        byte[] png = {(byte) 0x89, 'P', 'N', 'G'};
        Files.write(cwd.resolve("red.png"), png);
        List<Tool.AttachedImage> attached = new ArrayList<>();

        String output = tools(5).get("view_image")
                .execute(input("path", "red.png"), attachingContext(cwd, attached));

        assertFalse(output.startsWith("ERROR: "), output);
        assertEquals(1, attached.size());
        assertEquals("image/png", attached.getFirst().mediaType());
        assertEquals(java.util.Base64.getEncoder().encodeToString(png),
                attached.getFirst().dataBase64());
    }

    @Test
    void viewImageRefusesEscapeUnsupportedTypesAndUndecodableOversize(@TempDir Path cwd) throws IOException {
        List<Tool.AttachedImage> attached = new ArrayList<>();
        Tool viewImage = tools(5).get("view_image");

        assertTrue(viewImage.execute(input("path", "../outside.png"),
                attachingContext(cwd, attached)).startsWith("ERROR: "), "traversal is refused");

        Files.writeString(cwd.resolve("notes.txt"), "text");
        assertTrue(viewImage.execute(input("path", "notes.txt"),
                attachingContext(cwd, attached)).startsWith("ERROR: "), "non-image types are refused");

        assertTrue(viewImage.execute(input("path", "missing.png"),
                attachingContext(cwd, attached)).startsWith("ERROR: "), "a missing file is an error");

        // Oversized AND undecodable (junk bytes): downscaling cannot save it.
        Files.write(cwd.resolve("huge.png"), new byte[5 * 1024 * 1024 + 1]);
        assertTrue(viewImage.execute(input("path", "huge.png"),
                attachingContext(cwd, attached)).startsWith("ERROR: "), "junk cannot be downscaled");

        assertTrue(attached.isEmpty(), "refused calls never attach anything");
        assertFalse(viewImage.needsPermission(), "read-only inside the sandbox: no gate");
    }

    @Test
    void viewImageDownscalesAnOversizedPhotoInsteadOfRefusing(@TempDir Path cwd) throws IOException {
        // The iPhone case: a real photo well over the providers' 5 MB per-image
        // limit — noise compresses terribly, so 3000x2000 easily exceeds it.
        var photo = new java.awt.image.BufferedImage(5000, 4000,
                java.awt.image.BufferedImage.TYPE_INT_RGB);
        var random = new java.util.Random(42);
        int[] pixels = new int[photo.getWidth() * photo.getHeight()];
        for (int i = 0; i < pixels.length; i++) {
            pixels[i] = random.nextInt(0xFFFFFF);
        }
        photo.setRGB(0, 0, photo.getWidth(), photo.getHeight(), pixels, 0, photo.getWidth());
        javax.imageio.ImageIO.write(photo, "jpeg", cwd.resolve("iphone.jpg").toFile());
        assertTrue(Files.size(cwd.resolve("iphone.jpg")) > 5L * 1024 * 1024,
                "the fixture must exceed the wire limit to prove the downscale");

        List<Tool.AttachedImage> attached = new ArrayList<>();
        String output = tools(5).get("view_image")
                .execute(input("path", "iphone.jpg"), attachingContext(cwd, attached));

        assertFalse(output.startsWith("ERROR: "), output);
        assertTrue(output.contains("downscaled"), "the result names the downscale honestly");
        assertEquals(1, attached.size());
        assertEquals("image/jpeg", attached.getFirst().mediaType());
        byte[] wireBytes = java.util.Base64.getDecoder().decode(attached.getFirst().dataBase64());
        assertTrue(wireBytes.length <= 5L * 1024 * 1024, "the wire image fits the provider limit");
        var scaled = javax.imageio.ImageIO.read(new java.io.ByteArrayInputStream(wireBytes));
        assertTrue(Math.max(scaled.getWidth(), scaled.getHeight()) <= 2576,
                "the long edge walks the downscale ladder (2576 = the high-res vision max)");
    }
}
