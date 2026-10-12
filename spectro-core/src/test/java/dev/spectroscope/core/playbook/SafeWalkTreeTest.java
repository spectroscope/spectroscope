package dev.spectroscope.core.playbook;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** Card 522: the bounded listing of a whole playbook folder, files and folders, without following a link. */
class SafeWalkTreeTest {

    @TempDir Path tmp;

    private Path write(Path file, String text) throws IOException {
        Files.createDirectories(file.getParent());
        return Files.writeString(file, text);
    }

    private static List<String> rels(SafeWalk.Tree tree) {
        return tree.entries().stream().map(e -> (e.dir() ? "d " : "f ") + e.rel()).toList();
    }

    @Test
    void treeListsFilesAndFoldersToTheDepthAndSaysWhenAFolderGoesDeeper() throws IOException {
        Path base = Files.createDirectories(tmp.resolve("pb"));
        write(base.resolve("playbook.json"), "{}");
        write(base.resolve("skills/pack/one/SKILL.md"), "s");
        write(base.resolve("skills/pack/one/scripts/run.sh"), "echo");

        SafeWalk.Tree tree = SafeWalk.tree(base, 4, 200);

        List<String> rels = rels(tree);
        assertTrue(rels.contains("f playbook.json"), rels.toString());
        assertTrue(rels.contains("d skills"), rels.toString());
        assertTrue(rels.contains("d skills/pack/one"), rels.toString());
        assertTrue(rels.contains("f skills/pack/one/SKILL.md"), rels.toString());
        assertTrue(rels.contains("d skills/pack/one/scripts"), "the folder at the depth is listed: " + rels);
        assertFalse(rels.stream().anyMatch(r -> r.endsWith("run.sh")), "nothing below the depth: " + rels);
        assertTrue(tree.truncated(), "a folder at the depth with something in it truncates the listing");
        assertEquals(List.of("skills/pack/one/scripts"), tree.deeper(), "the folder at the depth is named");
        assertFalse(tree.capped());
        assertEquals(2, tree.files());
    }

    @Test
    void treeOfAFolderThatFitsIsNotTruncated() throws IOException {
        Path base = Files.createDirectories(tmp.resolve("pb"));
        write(base.resolve("playbook.json"), "{}");
        Files.createDirectories(base.resolve("skills/pack/one/empty"));

        SafeWalk.Tree tree = SafeWalk.tree(base, 4, 200);

        assertFalse(tree.truncated(), rels(tree).toString());
        assertEquals(List.of(), tree.deeper());
        assertTrue(rels(tree).contains("d skills/pack/one/empty"), rels(tree).toString());
    }

    @Test
    void treeRefusesALinkAndDoesNotEnterALinkedFolder() throws IOException {
        Path base = Files.createDirectories(tmp.resolve("pb"));
        write(base.resolve("playbook.json"), "{}");
        Path outside = write(tmp.resolve("secret/key.txt"), "do not list");
        Files.createSymbolicLink(base.resolve("notes.md"), outside);
        Files.createSymbolicLink(base.resolve("more"), outside.getParent());

        SafeWalk.Tree tree = SafeWalk.tree(base, 4, 200);

        assertEquals(List.of("f playbook.json"), rels(tree));
        assertEquals(List.of("more: a symbolic link", "notes.md: a symbolic link"), tree.refused());
    }

    @Test
    void treeRefusesAFileThatIsNotRegular() throws Exception {
        Path base = Files.createDirectories(tmp.resolve("pb"));
        write(base.resolve("playbook.json"), "{}");
        Path fifo = base.resolve("pipe");
        int exit;
        try {
            exit = new ProcessBuilder("mkfifo", fifo.toString()).start().waitFor();
        } catch (IOException noMkfifo) {
            exit = -1;
        }
        assumeTrue(exit == 0 && Files.exists(fifo), "mkfifo is not available");

        SafeWalk.Tree tree = SafeWalk.tree(base, 4, 200);

        assertEquals(List.of("f playbook.json"), rels(tree));
        assertEquals(List.of("pipe: not a regular file"), tree.refused());
    }

    @Test
    void treeStopsAtTheFileCapAndSaysSo() throws IOException {
        Path base = Files.createDirectories(tmp.resolve("pb"));
        for (int i = 0; i < 7; i++) {
            write(base.resolve("f" + i + ".md"), "x");
        }

        SafeWalk.Tree tree = SafeWalk.tree(base, 4, 5);

        assertEquals(5, tree.entries().stream().filter(e -> !e.dir()).count(), rels(tree).toString());
        assertTrue(tree.capped());
        assertTrue(tree.truncated());
        assertTrue(tree.files() > 5, "the count says the cap was passed: " + tree.files());
    }

    @Test
    void treeAtExactlyTheCapIsWhole() throws IOException {
        Path base = Files.createDirectories(tmp.resolve("pb"));
        for (int i = 0; i < 5; i++) {
            write(base.resolve("f" + i + ".md"), "x");
        }

        SafeWalk.Tree tree = SafeWalk.tree(base, 4, 5);

        assertFalse(tree.capped());
        assertEquals(5, tree.files());
    }

    @Test
    void treeCountsTheBytesAndSizesOfTheListedFiles() throws IOException {
        Path base = Files.createDirectories(tmp.resolve("pb"));
        write(base.resolve("a.md"), "12345");
        write(base.resolve("docs/b.md"), "123");
        try (RandomAccessFile big = new RandomAccessFile(base.resolve("docs/big.bin").toFile(), "rw")) {
            big.setLength(3_000_000L);
        }

        SafeWalk.Tree tree = SafeWalk.tree(base, 4, 200);

        assertEquals(3_000_008L, tree.bytes());
        assertEquals(5L, tree.entries().stream().filter(e -> e.rel().equals("a.md")).findFirst().orElseThrow().size());
    }
}
