package dev.spectroscope.core.skills;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 358: the sibling reader. A skill body that names {@code references/x.md}
 * is unusable unless something can open that file, and the six single-file
 * tools cannot — the skill roots are not under the run's sandbox root.
 *
 * <p>The security property under test, in the measurer's words: <b>a
 * model-supplied string may choose a location WITHIN a root, never WHICH
 * root.</b> The root comes from {@code Skill.source().getParent()}, and the
 * model's {@code skill} field is a MAP KEY, never a path fragment.
 */
class ReadSkillFileToolTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path tempDir;

    /** The run's sandbox root — deliberately NOT any skill root. */
    private Path cwd;

    private ToolContext context() throws IOException {
        if (cwd == null) {
            cwd = Files.createDirectories(tempDir.resolve("workspace"));
        }
        return new ToolContext(cwd, new CancelSignal());
    }

    private static ObjectNode input(String skill, String path) {
        return JSON.createObjectNode().put("skill", skill).put("path", path);
    }

    /** Writes {@code root/<folder>/SKILL.md} and returns the skill's own directory. */
    private Path skillIn(Path root, String folder, String body) throws IOException {
        Path dir = root.resolve(folder);
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("SKILL.md"),
                "---\nname: " + folder + "\ndescription: d\n---\n" + body);
        return dir;
    }

    // ---- the wire shape ------------------------------------------------------------------

    @Test
    void theToolIsNamedReadSkillFileAndNeedsNoGate() throws IOException {
        Path root = tempDir.resolve("skills");
        skillIn(root, "tdd", "body");
        Tool tool = SkillLibrary.load(List.of(root)).readSkillFileTool();

        assertEquals("read_skill_file", tool.name());
        assertFalse(tool.needsPermission(),
                "it reads only files the operator installed under a skill root");
        List<String> required = new java.util.ArrayList<>();
        tool.inputSchema().path("required").forEach(node -> required.add(node.asText()));
        assertEquals(List.of("skill", "path"), required,
                "both fields are required — a model that may omit the skill has no root");
    }

    // ---- criterion 3: a relative reference resolves, proven by a REAL read -----------------

    @Test
    void aSiblingTheBodyNamesRelativelyIsRead() throws IOException {
        Path root = tempDir.resolve("skills");
        Path skill = skillIn(root, "systematic-debugging", "See references/root-cause-tracing.md.");
        Files.createDirectories(skill.resolve("references"));
        Files.writeString(skill.resolve("references").resolve("root-cause-tracing.md"),
                "# Root cause tracing\n\nWalk the stack down.");
        Tool tool = SkillLibrary.load(List.of(root)).readSkillFileTool();

        String result = tool.execute(
                input("systematic-debugging", "references/root-cause-tracing.md"), context());

        assertEquals("# Root cause tracing\n\nWalk the stack down.", result);
    }

    // ---- criterion 4: a skill OUTSIDE the run's cwd still works ----------------------------

    @Test
    void aSkillOutsideTheRunsWorkingDirectoryIsReadableAndReadFileStillIsNot() throws IOException {
        // The two places really are different: the skill root lives beside the
        // workspace, not inside it, which is the DEFAULT (WorkspaceResolver hands
        // an unconfigured session a per-session temp dir).
        Path root = tempDir.resolve("elsewhere").resolve("skills");
        Path skill = skillIn(root, "using-superpowers", "See references/codex-tools.md.");
        Files.createDirectories(skill.resolve("references"));
        Files.writeString(skill.resolve("references").resolve("codex-tools.md"), "codex notes");
        ToolContext outside = context();
        assertFalse(skill.startsWith(outside.cwd()), "test premise: the skill is outside cwd");

        String read = SkillLibrary.load(List.of(root)).readSkillFileTool()
                .execute(input("using-superpowers", "references/codex-tools.md"), outside);
        assertEquals("codex notes", read);

        // And the sandbox is untouched: read_file still refuses that same file,
        // because no skill root joined context.cwd(). This is the half that must
        // NOT be "fixed" by widening the sandbox.
        Tool readFile = StandardTools.all().stream()
                .filter(t -> t.name().equals("read_file")).findFirst().orElseThrow();
        String refused = readFile.execute(
                JSON.createObjectNode().put("path",
                        skill.resolve("references").resolve("codex-tools.md").toString()),
                outside);
        assertTrue(refused.startsWith("ERROR: path is outside the working directory"),
                "read_file must still refuse an absolute path outside cwd, got: " + refused);
    }

    // ---- the security property: WITHIN a root, never WHICH root ---------------------------

    @Test
    void theSkillFieldIsALookupKeyAndNeverAPathFragment() throws IOException {
        Path root = tempDir.resolve("skills");
        skillIn(root, "tdd", "body");
        Files.writeString(tempDir.resolve("secret.txt"), "not for the model");
        Tool tool = SkillLibrary.load(List.of(root)).readSkillFileTool();

        String traversal = tool.execute(input("../..", "secret.txt"), context());

        assertTrue(traversal.startsWith("ERROR: unknown skill '../..'"),
                "the skill name is a map key — a path in it names no skill: " + traversal);
    }

    @Test
    void aDotDotPathCannotLeaveTheSkillDirectory() throws IOException {
        Path root = tempDir.resolve("skills");
        skillIn(root, "tdd", "body");
        skillIn(root, "other", "body");
        Files.writeString(root.resolve("other").resolve("private.md"), "the other skill's file");
        Tool tool = SkillLibrary.load(List.of(root)).readSkillFileTool();

        String result = tool.execute(input("tdd", "../other/private.md"), context());

        assertTrue(result.startsWith("ERROR: path is outside the skill directory"), result);
        assertFalse(result.contains("the other skill's file"), result);
    }

    @Test
    void aSiblingWhoseNameStartsWithTheSkillsNameIsStillOutside() throws IOException {
        // ⚠️ THE ONE BRANCH THIRTEEN BITES DID NOT REACH, found by the reviewer of
        // this card and reproduced here before the case was written.
        //
        // The containment rule is `real.startsWith(realBase)` — Path.startsWith
        // compares NAME ELEMENTS, and that is what makes it correct. Nothing
        // pinned it. The three cases above put the target in `other/`, in the
        // temp root, and behind a symlink; none of those names shares a string
        // prefix with `tdd`, so every one of them is refused by a TEXTUAL
        // comparison too. Swap the line for
        // `real.toString().startsWith(realBase.toString())` and the whole skills
        // package stays green — measured: 13/13, 31/31, 1/1, 6/6, zero failures —
        // while `read_skill_file(skill="tdd", path="../tdd-extra/secret.md")`
        // returns the neighbour's file.
        //
        // `tdd-extra` is the fixture that tells the two apart: its absolute path
        // has the skill's absolute path as a STRING prefix and not as a PATH
        // prefix. This is the card's whole stated security property — a
        // model-supplied string may choose a location WITHIN a root, never WHICH
        // root — so it is the one case that must exist.
        Path root = tempDir.resolve("skills");
        skillIn(root, "tdd", "body");
        skillIn(root, "tdd-extra", "body");
        Files.writeString(root.resolve("tdd-extra").resolve("secret.md"), "the neighbour's file");
        Tool tool = SkillLibrary.load(List.of(root)).readSkillFileTool();

        String result = tool.execute(input("tdd", "../tdd-extra/secret.md"), context());

        assertTrue(result.startsWith("ERROR: path is outside the skill directory"), result);
        assertFalse(result.contains("the neighbour's file"), result);
    }

    @Test
    void anAbsolutePathCannotChooseTheRoot() throws IOException {
        Path root = tempDir.resolve("skills");
        skillIn(root, "tdd", "body");
        Path outside = tempDir.resolve("secret.txt");
        Files.writeString(outside, "not for the model");
        Tool tool = SkillLibrary.load(List.of(root)).readSkillFileTool();

        String result = tool.execute(input("tdd", outside.toString()), context());

        assertTrue(result.startsWith("ERROR: path is outside the skill directory"), result);
        assertFalse(result.contains("not for the model"), result);
    }

    @Test
    void aSymlinkPlantedInsideTheSkillDirectoryCannotLeaveIt() throws IOException {
        // THIS is what the canonical form buys over the lexical one: a link's
        // LEXICAL path is inside the root, and every read below follows it.
        // StandardTools.resolveInside carried that hole until card 367 closed it
        // — the escape was demonstrated there against the shipped tools, and it
        // was not only a read escape: write_file and edit_file CHANGED the file
        // outside while answering with the name inside. Its own pins live in
        // StandardToolsTest; this one guards the skill root.
        Path root = tempDir.resolve("skills");
        Path skill = skillIn(root, "tdd", "body");
        Path outside = tempDir.resolve("secret.txt");
        Files.writeString(outside, "not for the model");
        Files.createSymbolicLink(skill.resolve("escape.md"), outside);
        Tool tool = SkillLibrary.load(List.of(root)).readSkillFileTool();

        String result = tool.execute(input("tdd", "escape.md"), context());

        assertTrue(result.startsWith("ERROR: path is outside the skill directory"), result);
        assertFalse(result.contains("not for the model"), result);
    }

    @Test
    void aSymlinkThatStaysInsideTheSkillDirectoryIsFine() throws IOException {
        // The refusal above must be about LEAVING, not about links — otherwise the
        // guard would be "no symlinks", which is a different and wrong rule.
        Path root = tempDir.resolve("skills");
        Path skill = skillIn(root, "tdd", "body");
        Files.writeString(skill.resolve("real.md"), "a sibling");
        Files.createSymbolicLink(skill.resolve("alias.md"), skill.resolve("real.md"));
        Tool tool = SkillLibrary.load(List.of(root)).readSkillFileTool();

        assertEquals("a sibling", tool.execute(input("tdd", "alias.md"), context()));
    }

    // ---- the ordinary refusals -------------------------------------------------------------

    @Test
    void anUnknownSkillListsWhatIsInstalled() throws IOException {
        Path root = tempDir.resolve("skills");
        skillIn(root, "alpha", "body");
        skillIn(root, "zeta", "body");
        Tool tool = SkillLibrary.load(List.of(root)).readSkillFileTool();

        assertEquals("ERROR: unknown skill 'gamma'. Available: alpha, zeta",
                tool.execute(input("gamma", "x.md"), context()));
    }

    @Test
    void anEmptyLibraryAnswersLikeUseSkillDoes() throws IOException {
        Tool tool = SkillLibrary.load(List.of(tempDir.resolve("nowhere"))).readSkillFileTool();

        assertEquals("ERROR: no skills are installed.",
                tool.execute(input("anything", "x.md"), context()));
    }

    @Test
    void aMissingFileSaysSoWithoutLeakingTheAbsolutePath() throws IOException {
        Path root = tempDir.resolve("skills");
        skillIn(root, "tdd", "body");
        Tool tool = SkillLibrary.load(List.of(root)).readSkillFileTool();

        String result = tool.execute(input("tdd", "references/gone.md"), context());

        assertEquals("ERROR: no such file in skill 'tdd': references/gone.md", result);
    }

    @Test
    void aDirectoryIsNotAFile() throws IOException {
        Path root = tempDir.resolve("skills");
        Path skill = skillIn(root, "tdd", "body");
        Files.createDirectories(skill.resolve("references"));
        Tool tool = SkillLibrary.load(List.of(root)).readSkillFileTool();

        assertEquals("ERROR: not a file in skill 'tdd': references",
                tool.execute(input("tdd", "references"), context()));
    }

    @Test
    void aFileOverTheCapIsRefusedRatherThanPouredIntoTheContext() throws IOException {
        // ui-styling ships 97 siblings and the fattest catalogue skill is 5.8 MB;
        // the same 50 kB ceiling read_file uses keeps one of them from eating a turn.
        Path root = tempDir.resolve("skills");
        Path skill = skillIn(root, "ui-styling", "body");
        Files.writeString(skill.resolve("huge.md"), "x".repeat(50_001));
        Tool tool = SkillLibrary.load(List.of(root)).readSkillFileTool();

        String result = tool.execute(input("ui-styling", "huge.md"), context());

        assertTrue(result.startsWith("ERROR: file too large (50001 bytes, limit 50000)"), result);
    }
}
