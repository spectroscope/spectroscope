package dev.spectroscope.core.skills;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Skill loading and progressive disclosure: frontmatter, fallbacks, layering, use_skill. */
class SkillLibraryTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path tempDir;

    /** Writes {@code root/<folder>/SKILL.md} with the given content and returns the root. */
    private Path skillIn(Path root, String folder, String content) throws IOException {
        Path dir = root.resolve(folder);
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("SKILL.md"), content);
        return root;
    }

    private static ObjectNode nameInput(String name) {
        return JSON.createObjectNode().put("name", name);
    }

    private ToolContext context() {
        return new ToolContext(tempDir, new CancelSignal());
    }

    // ---- parsing ---------------------------------------------------------------------

    @Test
    void frontmatterYieldsNameDescriptionAndFencelessBody() throws IOException {
        Path root = skillIn(tempDir.resolve("skills"), "review", """
                ---
                name: code-review
                description: Reviews diffs carefully.
                ---

                # Code review

                Read the diff twice.
                """);
        SkillLibrary library = SkillLibrary.load(List.of(root));

        Skill skill = library.find("code-review").orElseThrow();
        assertEquals("Reviews diffs carefully.", skill.description());
        assertTrue(skill.body().startsWith("# Code review"));
        assertTrue(skill.body().contains("Read the diff twice."));
        assertFalse(skill.body().contains("---"), "the fence block must not leak into the body");
        assertFalse(skill.body().contains("name:"));
    }

    @Test
    void nameFallsBackToFolderNameWhenKeyIsMissing() throws IOException {
        Path root = skillIn(tempDir.resolve("skills"), "refactoring", """
                ---
                description: Keeps refactorings safe.
                ---
                Body text.
                """);
        SkillLibrary library = SkillLibrary.load(List.of(root));

        assertTrue(library.find("refactoring").isPresent());
        assertEquals("Keeps refactorings safe.", library.find("refactoring").orElseThrow().description());
    }

    @Test
    void descriptionFallsBackToFirstBodyLineTruncatedTo120Chars() throws IOException {
        String longLine = "x".repeat(200);
        Path root = skillIn(tempDir.resolve("skills"), "wordy", """
                ---
                name: wordy
                ---

                %s
                more body
                """.formatted(longLine));
        SkillLibrary library = SkillLibrary.load(List.of(root));

        Skill skill = library.find("wordy").orElseThrow();
        assertEquals(120, skill.description().length());
        assertEquals(longLine.substring(0, 120), skill.description());
    }

    @Test
    void fileWithoutFrontmatterIsAllBodyWithBothFallbacks() throws IOException {
        Path root = skillIn(tempDir.resolve("skills"), "plain", """
                Just instructions, no fence.

                Second paragraph.
                """);
        SkillLibrary library = SkillLibrary.load(List.of(root));

        Skill skill = library.find("plain").orElseThrow();
        assertEquals("Just instructions, no fence.", skill.description());
        assertTrue(skill.body().startsWith("Just instructions, no fence."));
        assertTrue(skill.body().endsWith("Second paragraph."));
    }

    @Test
    void crlfLineEndingsParseTheSame() throws IOException {
        String crlf = "---\r\nname: windows\r\ndescription: Edited on Windows.\r\n---\r\n\r\nBody line.\r\n";
        Path root = skillIn(tempDir.resolve("skills"), "windows", crlf);
        SkillLibrary library = SkillLibrary.load(List.of(root));

        Skill skill = library.find("windows").orElseThrow();
        assertEquals("Edited on Windows.", skill.description());
        assertEquals("Body line.", skill.body());
    }

    // ---- loading and layering ----------------------------------------------------------

    @Test
    void projectRootOverridesUserRootOnTheSameName() throws IOException {
        Path userRoot = skillIn(tempDir.resolve("user"), "deploy", """
                ---
                name: deploy
                description: User-level deploy notes.
                ---
                user body
                """);
        Path projectRoot = skillIn(tempDir.resolve("project"), "deploy", """
                ---
                name: deploy
                description: Project-level deploy notes.
                ---
                project body
                """);
        SkillLibrary library = SkillLibrary.load(List.of(userRoot, projectRoot));

        assertEquals(1, library.skills().size());
        assertEquals("Project-level deploy notes.", library.find("deploy").orElseThrow().description());
        assertEquals("project body", library.find("deploy").orElseThrow().body());
    }

    @Test
    void missingRootsYieldAnEmptyLibrary() {
        SkillLibrary library = SkillLibrary.load(
                List.of(tempDir.resolve("nowhere"), tempDir.resolve("also-nowhere")));

        assertTrue(library.skills().isEmpty());
        assertEquals("", library.systemPromptSection());
    }

    @Test
    void subdirectoryWithoutSkillMdIsIgnored() throws IOException {
        Path root = skillIn(tempDir.resolve("skills"), "real", "---\nname: real\ndescription: d\n---\nbody");
        Files.createDirectories(root.resolve("not-a-skill"));
        SkillLibrary library = SkillLibrary.load(List.of(root));

        assertEquals(List.of("real"), library.skills().stream().map(Skill::name).toList());
    }

    @Test
    void systemPromptSectionListsAllSkillsSortedByName() throws IOException {
        Path root = tempDir.resolve("skills");
        skillIn(root, "zeta", "---\nname: zeta\ndescription: Last alphabetically.\n---\nbody z");
        skillIn(root, "alpha", "---\nname: alpha\ndescription: First alphabetically.\n---\nbody a");
        SkillLibrary library = SkillLibrary.load(List.of(root));

        String section = library.systemPromptSection();
        assertTrue(section.startsWith("\n\n## Skills\n\n"));
        assertTrue(section.contains("call the use_skill tool with its name BEFORE starting the work"));
        assertTrue(section.contains("- alpha: First alphabetically."));
        assertTrue(section.contains("- zeta: Last alphabetically."));
        assertTrue(section.indexOf("- alpha:") < section.indexOf("- zeta:"), "bullets must be sorted by name");
    }

    // ---- use_skill tool ------------------------------------------------------------------

    @Test
    void useSkillToolReturnsTheFullBody() throws IOException {
        Path root = skillIn(tempDir.resolve("skills"), "tdd", """
                ---
                name: tdd
                description: Red-green-refactor.
                ---

                # TDD

                Write the failing test first.
                """);
        Tool tool = SkillLibrary.load(List.of(root)).useSkillTool();

        assertEquals("use_skill", tool.name());
        assertFalse(tool.needsPermission());
        String result = tool.execute(nameInput("tdd"), context());
        assertTrue(result.startsWith("# TDD"));
        assertTrue(result.contains("Write the failing test first."));
    }

    @Test
    void useSkillToolRejectsUnknownNameAndListsAvailableSkills() throws IOException {
        Path root = tempDir.resolve("skills");
        skillIn(root, "alpha", "---\nname: alpha\ndescription: a\n---\nbody");
        skillIn(root, "zeta", "---\nname: zeta\ndescription: z\n---\nbody");
        Tool tool = SkillLibrary.load(List.of(root)).useSkillTool();

        String result = tool.execute(nameInput("gamma"), context());
        assertEquals("ERROR: unknown skill 'gamma'. Available: alpha, zeta", result);
    }

    @Test
    void useSkillToolRejectsBlankName() throws IOException {
        Path root = skillIn(tempDir.resolve("skills"), "alpha", "---\nname: alpha\ndescription: a\n---\nbody");
        Tool tool = SkillLibrary.load(List.of(root)).useSkillTool();

        String result = tool.execute(nameInput(""), context());
        assertTrue(result.startsWith("ERROR: unknown skill ''."));
    }

    @Test
    void useSkillToolOnEmptyLibraryReportsNoSkillsInstalled() {
        Tool tool = SkillLibrary.load(List.of(tempDir.resolve("nowhere"))).useSkillTool();

        assertEquals("ERROR: no skills are installed.", tool.execute(nameInput("anything"), context()));
    }

    // ---- the two shipped skills ----------------------------------------------------------

    /**
     * The real skills checked into the repo must parse. The Gradle test working
     * directory is the subproject directory (spectro-core), so the shipped root sits
     * one level up; walking a few parents keeps the lookup robust against a
     * different runner working directory.
     */
    @Test
    void shippedSkillsParseWithNonBlankDescriptions() {
        Optional<Path> shipped = shippedSkillsRoot();
        assertTrue(shipped.isPresent(), "shipped .spectro/skills root not found from "
                + System.getProperty("user.dir"));

        SkillLibrary library = SkillLibrary.load(List.of(shipped.orElseThrow()));
        for (String name : List.of("brainstorming", "test-driven-development")) {
            Skill skill = library.find(name).orElseThrow(
                    () -> new AssertionError("shipped skill missing: " + name));
            assertFalse(skill.description().isBlank());
            assertFalse(skill.body().isBlank());
        }
    }

    private static Optional<Path> shippedSkillsRoot() {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        for (int levels = 0; levels < 4 && dir != null; levels++, dir = dir.getParent()) {
            Path candidate = dir.resolve(".spectro").resolve("skills");
            if (Files.isDirectory(candidate)) {
                return Optional.of(candidate);
            }
        }
        return Optional.empty();
    }
}
