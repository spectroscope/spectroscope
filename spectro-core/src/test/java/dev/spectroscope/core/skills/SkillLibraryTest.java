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
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
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

    @Test
    void aDisabledMarkerHidesTheSkill() throws IOException {
        // Card 90: the settings skill manager disables per skill via a
        // `.disabled` marker file — the loader must respect it everywhere
        // (system prompt catalog, use_skill) without deleting anything.
        Path root = tempDir.resolve("roots").resolve("user");
        skillIn(root, "loud", "# loud\nbody");
        skillIn(root, "quiet", "# quiet\nbody");
        Files.writeString(root.resolve("quiet").resolve(".disabled"), "");
        SkillLibrary lib = SkillLibrary.load(List.of(root));
        assertEquals(1, lib.skills().size());
        assertEquals("loud", lib.skills().get(0).name());
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

    @Test
    void aBlockScalarDescriptionIsFoldedIntoOneLine() throws IOException {
        // Card 182: the marketplace catalogue carries skills written by other
        // people, and a YAML block scalar is how several of them spell a long
        // description. Splitting at the first colon turned that into the literal
        // one-character string "|", which would ride into the agent's system
        // prompt as "- humanizer: |" — a skill the model can never choose. The
        // shape below is humanizer's own frontmatter, colon-bearing line included.
        Path root = skillIn(tempDir.resolve("skills"), "humanizer", """
                ---
                name: humanizer
                description: |
                  Remove signs of AI-generated writing from text. Use when editing or reviewing
                  text to make it sound more natural and human-written. Based on Wikipedia's
                  comprehensive "Signs of AI writing" guide. Detects and fixes patterns including:
                  inflated symbolism, promotional language, superficial -ing analyses, vague
                  attributions, em dash overuse, rule of three, AI vocabulary words, passive
                  voice, negative parallelisms, and filler phrases.
                license: MIT
                ---

                # Humanizer
                """);
        SkillLibrary library = SkillLibrary.load(List.of(root));

        Skill skill = library.find("humanizer").orElseThrow();
        assertNotEquals("|", skill.description(), "the block marker is not the description");
        assertTrue(skill.description().startsWith("Remove signs of AI-generated writing"));
        assertTrue(skill.description().length() > 100, "the whole block travels, not its first line");
        assertFalse(skill.description().contains("\n"), "one bullet, one line");
        assertTrue(skill.description().endsWith("filler phrases."));
        // The continuation line ending in "including:" must not be read as a key:
        // that is how the old split-at-the-first-colon loop mangled the map.
        assertEquals("humanizer", skill.name());
        assertTrue(skill.body().startsWith("# Humanizer"));
    }

    @Test
    void aQuotedDescriptionLosesItsQuotes() throws IOException {
        Path root = tempDir.resolve("skills");
        skillIn(root, "double", """
                ---
                name: double
                description: "UI/UX design intelligence for web and mobile."
                ---
                body
                """);
        skillIn(root, "single", """
                ---
                name: single
                description: 'Quoted the other way.'
                ---
                body
                """);
        SkillLibrary library = SkillLibrary.load(List.of(root));

        assertEquals("UI/UX design intelligence for web and mobile.",
                library.find("double").orElseThrow().description());
        assertEquals("Quoted the other way.", library.find("single").orElseThrow().description());
    }

    @Test
    void aPlainScalarIsUnchanged() throws IOException {
        // The regression pin for the four skills this repo seeds: none of them
        // uses a block scalar or quotes, so the parser change must be invisible
        // to them, quotation marks inside a plain value included.
        Path root = tempDir.resolve("skills");
        skillIn(root, "brainstorming", """
                ---
                name: brainstorming
                description: Turn a vague idea into an agreed design before any code is written - one question at a time, real alternatives on the table, decisions recorded.
                ---
                # Brainstorming
                """);
        skillIn(root, "test-driven-development", """
                ---
                name: test-driven-development
                description: Red-green-refactor discipline for every change - write the failing test first, watch it fail for the right reason, make it pass minimally, then clean up.
                ---
                # Test-driven development
                """);
        skillIn(root, "verification", """
                ---
                name: verification
                description: Evidence before claims - run it, read the output, and only then say whether it works. A tester changes nothing and reports what actually happened.
                ---
                # Verification
                """);
        skillIn(root, "writing-plans", """
                ---
                name: writing-plans
                description: Turn an agreed design into a step-by-step implementation plan a fresh engineer could execute - exact files, verifiable steps, no open questions.
                ---
                # Writing plans
                """);
        skillIn(root, "quoting", """
                ---
                name: quoting
                description: Says "hello" in the middle, and that pair must survive.
                ---
                body
                """);
        SkillLibrary library = SkillLibrary.load(List.of(root));

        assertEquals("Turn a vague idea into an agreed design before any code is written - one question"
                + " at a time, real alternatives on the table, decisions recorded.",
                library.find("brainstorming").orElseThrow().description());
        assertEquals("Red-green-refactor discipline for every change - write the failing test first,"
                + " watch it fail for the right reason, make it pass minimally, then clean up.",
                library.find("test-driven-development").orElseThrow().description());
        assertEquals("Evidence before claims - run it, read the output, and only then say whether it"
                + " works. A tester changes nothing and reports what actually happened.",
                library.find("verification").orElseThrow().description());
        assertEquals("Turn an agreed design into a step-by-step implementation plan a fresh engineer"
                + " could execute - exact files, verifiable steps, no open questions.",
                library.find("writing-plans").orElseThrow().description());
        assertEquals("Says \"hello\" in the middle, and that pair must survive.",
                library.find("quoting").orElseThrow().description());
    }

    @Test
    void parsingARawStringNeedsNoFileOnDisk() throws IOException {
        // The catalogue reads SKILL.md out of the jar, where there is no Path to
        // hand the file-taking overload.
        Skill skill = SkillLibrary.parse("---\nname: shelf\ndescription: From a stream.\n---\nbody",
                "shelf", tempDir.resolve("shelf/SKILL.md"));

        assertEquals("shelf", skill.name());
        assertEquals("From a stream.", skill.description());
        assertEquals("body", skill.body());
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

    // ---- packs and namespaces (card 182) -------------------------------------------------

    @Test
    void aPackAdvertisesItsSkillsUnderPackColonName() throws IOException {
        // The marketplace installs into <root>/<pack>/<skill>/, so a folder that
        // holds no SKILL.md of its own but does hold skills is a pack, and its
        // skills carry its name. That is the convention Claude Code already uses
        // for plugin skills, and the one the vendored superpowers texts spell in
        // their own cross-references.
        Path root = tempDir.resolve("skills");
        skillIn(root.resolve("superpowers"), "writing-plans", """
                ---
                name: writing-plans
                description: Turn a spec into steps.
                ---
                pack body
                """);
        SkillLibrary library = SkillLibrary.load(List.of(root));

        assertEquals(List.of("superpowers:writing-plans"),
                library.skills().stream().map(Skill::name).toList());
        assertEquals("pack body", library.find("superpowers:writing-plans").orElseThrow().body());
    }

    @Test
    void thePackWinsOverTheFrontmatterNameAsTheKey() throws IOException {
        // The blocker the namespace design had to clear: loading keyed on the
        // FRONTMATTER name with the folder only as a fallback, so a namespaced
        // folder still went into the map — and into the prompt, and into
        // use_skill — under its bare name, and collided exactly as before.
        Path root = tempDir.resolve("skills");
        skillIn(root.resolve("superpowers"), "brainstorming", """
                ---
                name: brainstorming
                description: Explore before building.
                ---
                pack body
                """);
        SkillLibrary library = SkillLibrary.load(List.of(root));

        assertTrue(library.find("brainstorming").isEmpty(), "the bare name must not resolve");
        assertEquals("Explore before building.",
                library.find("superpowers:brainstorming").orElseThrow().description());
    }

    @Test
    void aTopLevelSkillKeepsItsBareNameAndItsFrontmatterRule() throws IOException {
        // The regression pin. Every skill installed before this change sits at
        // level 1, and none of them may move or be renamed by the pack rule.
        Path root = tempDir.resolve("skills");
        skillIn(root, "review", """
                ---
                name: code-review
                description: Reviews diffs.
                ---
                top body
                """);
        skillIn(root, "plain", "# plain\nno frontmatter here");
        SkillLibrary library = SkillLibrary.load(List.of(root));

        assertEquals(List.of("code-review", "plain"),
                library.skills().stream().map(Skill::name).toList());
    }

    @Test
    void aPackSkillAndATopLevelSkillOfTheSameNameCoexist() throws IOException {
        // The whole point of the namespace: the richer vendored version installs
        // beside a seeded one of the same name instead of being refused, and the
        // model can tell the two apart because they are spelled differently.
        Path root = tempDir.resolve("skills");
        skillIn(root, "brainstorming", """
                ---
                name: brainstorming
                description: Ours.
                ---
                ours
                """);
        skillIn(root.resolve("superpowers"), "brainstorming", """
                ---
                name: brainstorming
                description: Theirs.
                ---
                theirs
                """);
        SkillLibrary library = SkillLibrary.load(List.of(root));

        assertEquals(List.of("brainstorming", "superpowers:brainstorming"),
                library.skills().stream().map(Skill::name).toList());
        assertEquals("ours", library.find("brainstorming").orElseThrow().body());
        assertEquals("theirs", library.find("superpowers:brainstorming").orElseThrow().body());
    }

    @Test
    void aDisabledMarkerInsideAPackHidesOnlyThatSkill() throws IOException {
        Path pack = tempDir.resolve("skills").resolve("superpowers");
        skillIn(pack, "loud", "---\nname: loud\ndescription: d\n---\nbody");
        skillIn(pack, "quiet", "---\nname: quiet\ndescription: d\n---\nbody");
        Files.writeString(pack.resolve("quiet").resolve(".disabled"), "");
        SkillLibrary library = SkillLibrary.load(List.of(tempDir.resolve("skills")));

        assertEquals(List.of("superpowers:loud"), library.skills().stream().map(Skill::name).toList());
    }

    @Test
    void aDisabledMarkerOnThePackHidesAllOfIt() throws IOException {
        // The same marker one level up. Without this rule a `.disabled` on a pack
        // folder would read as "off" and quietly do nothing, which is the worse
        // surprise of the two.
        Path root = tempDir.resolve("skills");
        Path pack = root.resolve("superpowers");
        skillIn(pack, "one", "---\nname: one\ndescription: d\n---\nbody");
        skillIn(pack, "two", "---\nname: two\ndescription: d\n---\nbody");
        skillIn(root, "kept", "---\nname: kept\ndescription: d\n---\nbody");
        Files.writeString(pack.resolve(".disabled"), "");
        SkillLibrary library = SkillLibrary.load(List.of(root));

        assertEquals(List.of("kept"), library.skills().stream().map(Skill::name).toList());
    }

    @Test
    void theRuleAddsExactlyOneLevelAndNoMore() throws IOException {
        // The loader's contract was one level, no recursion; this adds packs and
        // stops. A category folder inside a pack is not searched — the installer
        // flattens the catalogue's two nesting depths on the way in, so nothing
        // that lands here is ever deeper than <pack>/<skill>.
        Path root = tempDir.resolve("skills");
        skillIn(root.resolve("pack").resolve("category"), "buried", "---\nname: buried\ndescription: d\n---\nb");
        Files.createDirectories(root.resolve("empty"));
        SkillLibrary library = SkillLibrary.load(List.of(root));

        assertTrue(library.skills().isEmpty(), "nothing three levels down, and an empty folder is not a pack");
    }

    @Test
    void packsLayerLikeEverythingElse() throws IOException {
        Path userRoot = tempDir.resolve("user");
        Path projectRoot = tempDir.resolve("project");
        skillIn(userRoot.resolve("superpowers"), "deploy", "---\nname: deploy\ndescription: d\n---\nuser body");
        skillIn(projectRoot.resolve("superpowers"), "deploy", "---\nname: deploy\ndescription: d\n---\nproject body");
        SkillLibrary library = SkillLibrary.load(List.of(userRoot, projectRoot));

        assertEquals(1, library.skills().size());
        assertEquals("project body", library.find("superpowers:deploy").orElseThrow().body());
    }

    @Test
    void useSkillAndThePromptSpellTheNamespace() throws IOException {
        Path root = tempDir.resolve("skills");
        skillIn(root.resolve("superpowers"), "tdd", """
                ---
                name: tdd
                description: Red then green.
                ---
                Write the failing test first.
                """);
        SkillLibrary library = SkillLibrary.load(List.of(root));

        assertTrue(library.systemPromptSection().contains("- superpowers:tdd: Red then green."));
        Tool tool = library.useSkillTool();
        // Card 358 put an address in front of the body, so the body is now the
        // TAIL of the result rather than the whole of it. Still exact on the body.
        assertTrue(tool.execute(nameInput("superpowers:tdd"), context())
                .endsWith("Write the failing test first."));
        assertEquals("ERROR: unknown skill 'tdd'. Available: superpowers:tdd",
                tool.execute(nameInput("tdd"), context()));
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
        // The body arrives WHOLE and verbatim, and it is the tail of the result —
        // a stronger pin than the old startsWith, which the card-358 address broke.
        assertTrue(result.endsWith("# TDD\n\nWrite the failing test first."),
                "the full body, byte for byte, at the end of the result: " + result);
    }

    // ---- card 358: the address travels with the body, never with the catalogue ----------

    @Test
    void useSkillNamesTheDirectoryTheSkillWasLoadedFrom() throws IOException {
        // Criterion 1. The measured failure: the model announced a skill and then
        // ran `find ~ -maxdepth 8 -type d -name "<skill>"`, which timed out. It had
        // the body and no address — Skill.source() was loaded and never handed over.
        Path root = tempDir.resolve("skills");
        skillIn(root, "systematic-debugging", """
                ---
                name: systematic-debugging
                description: Find the cause.
                ---
                Read references/root-cause-tracing.md.
                """);
        Path skillDir = root.resolve("systematic-debugging");
        Tool tool = SkillLibrary.load(List.of(root)).useSkillTool();

        String result = tool.execute(nameInput("systematic-debugging"), context());

        assertTrue(result.contains(skillDir.toString()),
                "the RESULT must carry the directory itself, not a description of one: " + result);
        assertTrue(result.contains("read_skill_file"),
                "and name the tool that can open what lives there: " + result);
    }

    @Test
    void theAddressDoesNotClaimReadFileIsBlockedWhenTheSkillRootIsUnderTheWorkspace()
            throws IOException {
        // ⚠️ REVIEW FINDING, card 358. The address line ended, unconditionally,
        // "read_file cannot: the directory is outside the working directory" —
        // false whenever the skill root sits UNDER the sandbox root, which is
        // what an operator who points the workspace at a project gets. This very
        // repo ships a tracked .spectro/skills/spectroscope/research, the skill
        // the RoleCatalog half of this card exists for. Reproduced before the
        // fix with cwd = the project dir: the sentence said "read_file cannot"
        // while read_file returned the sibling by BOTH absolute and relative
        // path. Telling the model a false thing about its own sandbox is the
        // class of error that produced the `find ~` sweep this card removes.
        //
        // The assertion does not restate my own predicate: it takes the path OUT
        // of the sentence and hands it to read_file. If the claim is wrong, the
        // tool says so.
        Path project = Files.createDirectories(tempDir.resolve("repo"));
        Path root = project.resolve(".spectro").resolve("skills");
        skillIn(root, "research", "---\nname: research\ndescription: r\n---\nsee references/x.md");
        Files.createDirectories(root.resolve("research").resolve("references"));
        Files.writeString(root.resolve("research").resolve("references").resolve("x.md"),
                "SIBLING CONTENT");
        ToolContext inProject = new ToolContext(project, new CancelSignal());
        Tool tool = SkillLibrary.load(List.of(root)).useSkillTool();

        String result = tool.execute(nameInput("research"), inProject);

        assertFalse(result.contains("read_file cannot"),
                "the skill root is under the working directory here: " + result);
        String clue = "read_file reaches it too, at ";
        assertTrue(result.contains(clue), "and the address must say where: " + result);
        String tail = result.substring(result.indexOf(clue) + clue.length());
        String relativeDir = tail.substring(0, tail.indexOf("/."));

        assertEquals("SIBLING CONTENT", readFile().execute(
                        JSON.createObjectNode().put("path", relativeDir + "/references/x.md"),
                        inProject),
                "the address named a read_file path that read_file does not honour");
    }

    @Test
    void theAddressStillSaysReadFileCannotWhenTheSkillRootIsOutsideTheWorkspace()
            throws IOException {
        // The other direction of the same sentence — the unconfigured session,
        // whose workspace is a per-session temp dir with no skills under it.
        // Checked against read_file too, so neither half is a restatement.
        Path workspace = Files.createDirectories(tempDir.resolve("workspace"));
        Path root = tempDir.resolve("elsewhere");
        skillIn(root, "research", "---\nname: research\ndescription: r\n---\nsee references/x.md");
        Files.createDirectories(root.resolve("research").resolve("references"));
        Path sibling = root.resolve("research").resolve("references").resolve("x.md");
        Files.writeString(sibling, "SIBLING CONTENT");
        ToolContext outside = new ToolContext(workspace, new CancelSignal());
        Tool tool = SkillLibrary.load(List.of(root)).useSkillTool();

        String result = tool.execute(nameInput("research"), outside);

        assertTrue(result.contains("read_file cannot: the directory is outside the working directory"),
                "the skill root is outside the working directory here: " + result);
        assertTrue(readFile().execute(
                        JSON.createObjectNode().put("path", sibling.toString()), outside)
                        .startsWith("ERROR: path is outside the working directory"),
                "and read_file must actually refuse it, or the sentence is the wrong one");
    }

    @Test
    void theAddressSentenceFollowsReadFileThroughASymlinkedWorkspace() throws IOException {
        // Card 367. This sentence is a claim about read_file, so it has to move
        // when read_file's rule moves — and it just did: the containment check is
        // canonical now, both sides resolved, because a lexical one let a link
        // planted inside cwd read and WRITE outside it.
        //
        // readFileReach's javadoc argued for the lexical mirror in exactly this
        // case: "a canonical comparison here would say reaches for a workspace
        // whose cwd is a symlink to the skill root's parent, where the lexical
        // tool refuses". The lexical tool no longer refuses, so from card 367 on
        // it is the LEXICAL answer that lies — this test is the case that
        // sentence named, run against the tool instead of argued about.
        //
        // Same design as the two tests above: the path is taken OUT of the
        // sentence and handed to read_file, so neither half restates the other.
        Path project = Files.createDirectories(tempDir.resolve("real-project"));
        Path root = project.resolve(".spectro").resolve("skills");
        skillIn(root, "research", "---\nname: research\ndescription: r\n---\nsee references/x.md");
        Files.createDirectories(root.resolve("research").resolve("references"));
        Files.writeString(root.resolve("research").resolve("references").resolve("x.md"),
                "SIBLING CONTENT");
        Path linked = tempDir.resolve("linked-project");
        Files.createSymbolicLink(linked, project);
        ToolContext throughTheLink = new ToolContext(linked, new CancelSignal());
        Tool tool = SkillLibrary.load(List.of(root)).useSkillTool();

        String result = tool.execute(nameInput("research"), throughTheLink);

        assertFalse(result.contains("read_file cannot"),
                "cwd is a link to the directory the skill root lives under, and read_file"
                        + " follows it: " + result);
        String clue = "read_file reaches it too, at ";
        assertTrue(result.contains(clue), "and the address must say where: " + result);
        String tail = result.substring(result.indexOf(clue) + clue.length());
        String relativeDir = tail.substring(0, tail.indexOf("/."));

        assertEquals("SIBLING CONTENT", readFile().execute(
                        JSON.createObjectNode().put("path", relativeDir + "/references/x.md"),
                        throughTheLink),
                "the address named a read_file path that read_file does not honour");
    }

    /** The shipped read_file, so the address line is checked against the tool it names. */
    private static Tool readFile() {
        return StandardTools.all().stream().filter(t -> t.name().equals("read_file"))
                .findFirst().orElseThrow();
    }

    @Test
    void theCatalogueInTheSystemPromptCarriesNoSkillPaths() throws IOException {
        // Criterion 2, the other half, pinned so a later reader cannot "helpfully"
        // move the address up into the always-on list. Progressive disclosure is
        // the whole design: 40 skills times a path is context spent before anyone asks.
        Path root = tempDir.resolve("skills");
        skillIn(root, "alpha", "---\nname: alpha\ndescription: a\n---\nbody");
        skillIn(root, "zeta", "---\nname: zeta\ndescription: z\n---\nbody");
        SkillLibrary library = SkillLibrary.load(List.of(root));

        String section = library.systemPromptSection();

        assertFalse(section.contains(root.toString()),
                "no skill root belongs in the always-on catalogue: " + section);
        assertFalse(section.contains("read_skill_file"),
                "nor the on-demand reader's name: " + section);
        assertEquals(List.of("- alpha: a", "- zeta: z"),
                section.lines().filter(line -> line.startsWith("- ")).toList(),
                "one cheap bullet per skill, name and description and nothing else");
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

    // ---- the shipped skills ---------------------------------------------------------------

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
        assertFalse(library.skills().isEmpty(), "the repo ships at least one skill");
        for (Skill skill : library.skills()) {
            assertFalse(skill.description().isBlank(), skill.name() + " has no description");
            assertFalse(skill.body().isBlank(), skill.name() + " has no body");
        }
        assertTrue(library.find("verification").isPresent(), "shipped skill missing: verification");
    }

    /**
     * Card 182 dropped brainstorming, test-driven-development and writing-plans
     * from the seed set: the vendored superpowers versions are three to five
     * times richer, they cross-reference each other as {@code superpowers:…},
     * and a description costs the same in the prompt whatever the body weighs.
     * Seeding a thin twin of an installable skill only gives the model two
     * entries to choose between. They are one press away in the catalogue.
     */
    @Test
    void theSeedSetCarriesNoTwinOfACatalogueSkill() {
        SkillLibrary library = SkillLibrary.load(List.of(shippedSkillsRoot().orElseThrow()));

        for (String dropped : List.of("brainstorming", "test-driven-development", "writing-plans")) {
            assertTrue(library.find(dropped).isEmpty(),
                    dropped + " is seeded again — the catalogue's version is the richer one");
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
