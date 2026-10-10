package dev.spectroscope.server.settings;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 485: the stage, promote and discard steps the catalogue install used
 * inline, as one class the playbook installer can share.
 */
class StagedInstallTest {

    @TempDir
    Path dir;

    private Path stagingRoot() {
        return dir.resolve(".skill-install");
    }

    private static StagedInstall.FileCopy file(String rel, String text) {
        return new StagedInstall.FileCopy(rel,
                () -> new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)));
    }

    private static List<Path> children(Path folder) throws IOException {
        try (Stream<Path> list = Files.list(folder)) {
            return list.toList();
        }
    }

    // ---- build ---------------------------------------------------------------------------

    @Test
    void buildWritesEveryFileUnderItsRelativePathInAFolderUnderTheStagingRoot() throws IOException {
        Path staged = StagedInstall.build(stagingRoot(), "brainstorming",
                List.of(file("SKILL.md", "skill body"), file("scripts/run.sh", "echo hi")));

        assertEquals(stagingRoot(), staged.getParent());
        assertTrue(staged.getFileName().toString().startsWith("brainstorming-"), staged.toString());
        assertEquals("skill body", Files.readString(staged.resolve("SKILL.md")));
        assertEquals("echo hi", Files.readString(staged.resolve("scripts/run.sh")));
    }

    @Test
    void aRelThatLeavesTheFolderThrowsAndLeavesNoFileOutside() throws IOException {
        StagedInstall.OutsideFolder thrown = assertThrows(StagedInstall.OutsideFolder.class,
                () -> StagedInstall.build(stagingRoot(), "brainstorming",
                        List.of(file("SKILL.md", "skill body"), file("../x", "escaped"))));

        assertEquals("../x", thrown.rel());
        assertFalse(Files.exists(stagingRoot().resolve("x")), "the escaping file was never written");
        assertFalse(Files.exists(dir.resolve("x")));
        assertFalse(Files.exists(stagingRoot()), "the half built folder and the emptied root are gone");
    }

    @Test
    void aSourceThatFailsLeavesNothingBehind() {
        StagedInstall.FileCopy broken = new StagedInstall.FileCopy("LICENSE", () -> {
            throw new IOException("disk gave up");
        });

        IOException thrown = assertThrows(IOException.class,
                () -> StagedInstall.build(stagingRoot(), "brainstorming",
                        List.of(file("SKILL.md", "skill body"), broken)));

        assertEquals("disk gave up", thrown.getMessage());
        assertFalse(Files.exists(stagingRoot()), "no staging leftovers");
    }

    @Test
    void aCopierReceivesEveryFileWithItsDestinationInOrder() throws IOException {
        List<String> seen = new ArrayList<>();
        Path staged = StagedInstall.build(stagingRoot(), "brainstorming",
                List.of(file("SKILL.md", "a"), file("refs/notes.md", "b")),
                (copy, destination) -> {
                    seen.add(copy.rel() + " -> " + dir.relativize(destination));
                    StagedInstall.STREAM.copy(copy, destination);
                });

        String folder = dir.relativize(staged).toString();
        assertEquals(List.of("SKILL.md -> " + folder + "/SKILL.md",
                "refs/notes.md -> " + folder + "/refs/notes.md"), seen);
        assertEquals("b", Files.readString(staged.resolve("refs/notes.md")));
    }

    // ---- promote -------------------------------------------------------------------------

    @Test
    void promoteOntoAnAbsentTargetMovesAndTheStagedFolderIsGone() throws IOException {
        Path staged = StagedInstall.build(stagingRoot(), "brainstorming", List.of(file("SKILL.md", "skill body")));
        Path target = dir.resolve("skills/superpowers/brainstorming");

        assertEquals(StagedInstall.Outcome.MOVED, StagedInstall.promote(staged, target));

        assertEquals("skill body", Files.readString(target.resolve("SKILL.md")));
        assertFalse(Files.exists(staged));
    }

    @Test
    void promoteOntoAnExistingNonEmptyTargetIsTakenAndLeavesTheTargetAsItWas() throws IOException {
        Path target = dir.resolve("skills/superpowers/brainstorming");
        Files.createDirectories(target);
        Files.writeString(target.resolve("SKILL.md"), "the one already there");
        Path staged = StagedInstall.build(stagingRoot(), "brainstorming",
                List.of(file("SKILL.md", "skill body"), file("extra.md", "new")));

        assertEquals(StagedInstall.Outcome.TAKEN, StagedInstall.promote(staged, target));

        assertEquals(List.of(target.resolve("SKILL.md")), children(target));
        assertEquals("the one already there", Files.readString(target.resolve("SKILL.md")));
        assertTrue(Files.exists(staged.resolve("SKILL.md")), "the staged copy waits for discard");
    }

    @Test
    void promoteOntoAnExistingEmptyFolderIsTakenRatherThanReplaced() throws IOException {
        Path target = Files.createDirectories(dir.resolve("skills/superpowers/brainstorming"));
        Path staged = StagedInstall.build(stagingRoot(), "brainstorming", List.of(file("SKILL.md", "skill body")));

        assertEquals(StagedInstall.Outcome.TAKEN, StagedInstall.promote(staged, target));

        assertEquals(List.of(), children(target));
        assertTrue(Files.exists(staged.resolve("SKILL.md")));
    }

    // ---- discard -------------------------------------------------------------------------

    @Test
    void discardRemovesTheStagedTreeAndAnEmptiedStagingRoot() throws IOException {
        Path staged = StagedInstall.build(stagingRoot(), "brainstorming",
                List.of(file("SKILL.md", "a"), file("scripts/run.sh", "b")));

        StagedInstall.discard(staged, stagingRoot());

        assertFalse(Files.exists(staged));
        assertFalse(Files.exists(stagingRoot()));
    }

    @Test
    void discardKeepsAStagingRootThatHoldsAnotherFolder() throws IOException {
        Path other = StagedInstall.build(stagingRoot(), "other", List.of(file("SKILL.md", "a")));
        Path staged = StagedInstall.build(stagingRoot(), "brainstorming", List.of(file("SKILL.md", "b")));

        StagedInstall.discard(staged, stagingRoot());

        assertFalse(Files.exists(staged));
        assertEquals(List.of(other), children(stagingRoot()));
    }

    @Test
    void discardNeverThrows() {
        assertDoesNotThrow(() -> StagedInstall.discard(dir.resolve("absent/x"), dir.resolve("absent")));
        assertDoesNotThrow(() -> StagedInstall.discard(null, dir.resolve("absent")));
    }
}
