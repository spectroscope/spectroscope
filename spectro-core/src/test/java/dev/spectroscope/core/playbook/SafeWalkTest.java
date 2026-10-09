package dev.spectroscope.core.playbook;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SafeWalkTest {

    @TempDir Path tmp;

    private Path write(Path file, String text) throws IOException {
        Files.createDirectories(file.getParent());
        return Files.writeString(file, text);
    }

    @Test
    void aLinkToAFileOutsideIsRefusedAndLeftOut() throws IOException {
        Path base = Files.createDirectories(tmp.resolve("pb"));
        Path pack = base.resolve("skills/pack");
        write(pack.resolve("SKILL.md"), "s");
        Path outside = write(tmp.resolve("secret.txt"), "do not read");
        Files.createSymbolicLink(pack.resolve("notes.md"), outside);

        SafeWalk.Walk w = SafeWalk.walk(base, pack);

        assertEquals(List.of("SKILL.md"), w.files());
        assertEquals(List.of("notes.md: a symbolic link"), w.refused());
        assertEquals(1L, w.bytes());
    }

    @Test
    void aLinkToADirectoryIsRefusedAndNotEntered() throws IOException {
        Path base = Files.createDirectories(tmp.resolve("pb"));
        Path pack = base.resolve("skills/pack");
        write(pack.resolve("SKILL.md"), "s");
        Path elsewhere = tmp.resolve("elsewhere");
        write(elsewhere.resolve("inner.md"), "inner");
        Files.createSymbolicLink(pack.resolve("more"), elsewhere);

        SafeWalk.Walk w = SafeWalk.walk(base, pack);

        assertEquals(List.of("SKILL.md"), w.files());
        assertEquals(List.of("more: a symbolic link"), w.refused());
        assertFalse(w.files().stream().anyMatch(f -> f.contains("inner")), w.files().toString());
    }

    @Test
    void aStartReachedThroughALinkedParentIsRefusedAsAWhole() throws IOException {
        Path base = Files.createDirectories(tmp.resolve("pb"));
        Path other = tmp.resolve("other");
        write(other.resolve("pack/SKILL.md"), "s");
        Files.createSymbolicLink(base.resolve("skills"), other);

        SafeWalk.Walk w = SafeWalk.walk(base, base.resolve("skills/pack"));

        assertEquals(List.of(), w.files());
        assertEquals(1, w.refused().size(), w.refused().toString());
        assertTrue(w.refused().get(0).startsWith("skills/pack: "), w.refused().toString());
        assertEquals(0L, w.bytes());
    }

    @Test
    void aStartThatIsItselfALinkIsRefused() throws IOException {
        Path base = Files.createDirectories(tmp.resolve("pb"));
        Path real = base.resolve("skills/real");
        write(real.resolve("SKILL.md"), "s");
        Files.createSymbolicLink(base.resolve("skills/alias"), real);

        SafeWalk.Walk w = SafeWalk.walk(base, base.resolve("skills/alias"));

        assertEquals(List.of(), w.files());
        assertEquals(1, w.refused().size(), w.refused().toString());
    }

    @Test
    void filesAreSortedByTheirUtf8BytesWithSlashSeparators() throws IOException {
        Path base = Files.createDirectories(tmp.resolve("pb"));
        Path pack = base.resolve("skills/pack");
        write(pack.resolve("b/SKILL.md"), "body");
        write(pack.resolve("ä.md"), "umlaut");
        write(pack.resolve("a.md"), "note");
        write(pack.resolve("z.md"), "last ascii");

        SafeWalk.Walk w = SafeWalk.walk(base, pack);

        // Unsigned byte order: every ASCII name sorts before a name whose first byte is 0xC3.
        assertEquals(4, w.files().size(), w.files().toString());
        assertEquals(List.of("a.md", "b/SKILL.md", "z.md"), w.files().subList(0, 3));
        assertTrue(w.files().get(3).endsWith(".md") && !w.files().get(3).startsWith("z"), w.files().toString());
        assertEquals(List.of(), w.refused());
    }

    @Test
    void bytesIsTheSumOfTheRegularFiles() throws IOException {
        Path base = Files.createDirectories(tmp.resolve("pb"));
        Path pack = base.resolve("skills/pack");
        write(pack.resolve("SKILL.md"), "12345");
        write(pack.resolve("ref/notes.md"), "123");
        Files.createSymbolicLink(pack.resolve("link.md"), pack.resolve("SKILL.md"));

        SafeWalk.Walk w = SafeWalk.walk(base, pack);

        assertEquals(8L, w.bytes());
        assertEquals(pack, w.root());
    }
}
