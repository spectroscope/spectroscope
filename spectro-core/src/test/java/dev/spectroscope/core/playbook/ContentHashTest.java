package dev.spectroscope.core.playbook;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ContentHashTest {

    @TempDir Path tmp;

    private Path tree(String name, Map<String, String> files) throws IOException {
        Path root = Files.createDirectories(tmp.resolve(name));
        for (Map.Entry<String, String> e : files.entrySet()) {
            Path f = root.resolve(e.getKey());
            Files.createDirectories(f.getParent());
            Files.writeString(f, e.getValue());
        }
        return root;
    }

    private static String sha256(byte[]... parts) throws Exception {
        MessageDigest d = MessageDigest.getInstance("SHA-256");
        for (byte[] p : parts) {
            d.update(p);
        }
        return HexFormat.of().formatHex(d.digest());
    }

    @Test
    void oneFileHashesAsTheSpecDefinesIt() throws Exception {
        Path root = tree("one", Map.of("a", "x"));
        MessageDigest d = MessageDigest.getInstance("SHA-256");
        d.update("a".getBytes(UTF_8));
        d.update((byte) 0);
        d.update("1".getBytes(UTF_8));
        d.update((byte) 0);
        d.update("x".getBytes(UTF_8));
        assertEquals(HexFormat.of().formatHex(d.digest()), ContentHash.tree(SafeWalk.walk(tmp, root)));
    }

    @Test
    void twoFilesFeedOneDigestInPathOrder() throws Exception {
        Path root = tree("two", Map.of("b/SKILL.md", "body", "a.md", "note"));
        String expected = sha256(
                "a.md".getBytes(UTF_8), new byte[] {0}, "4".getBytes(UTF_8), new byte[] {0}, "note".getBytes(UTF_8),
                "b/SKILL.md".getBytes(UTF_8), new byte[] {0}, "4".getBytes(UTF_8), new byte[] {0}, "body".getBytes(UTF_8));
        assertEquals(expected, ContentHash.tree(SafeWalk.walk(tmp, root)));
    }

    @Test
    void creationOrderDoesNotMatterAndOneByteDoes() throws IOException {
        Map<String, String> forward = new LinkedHashMap<>();
        forward.put("b/SKILL.md", "body");
        forward.put("a.md", "note");
        Map<String, String> backward = new LinkedHashMap<>();
        backward.put("a.md", "note");
        backward.put("b/SKILL.md", "body");
        String one = ContentHash.tree(SafeWalk.walk(tmp, tree("f", forward)));
        assertEquals(one, ContentHash.tree(SafeWalk.walk(tmp, tree("g", backward))));
        backward.put("a.md", "notE");
        assertNotEquals(one, ContentHash.tree(SafeWalk.walk(tmp, tree("h", backward))));
    }

    @Test
    void skippedFilesDoNotCount() throws IOException {
        Path plain = tree("plain", Map.of("SKILL.md", "s"));
        Path installed = tree("installed", Map.of("SKILL.md", "s", "LICENSE", "MIT", "spectro-install.json", "{}"));
        assertEquals(ContentHash.tree(SafeWalk.walk(tmp, plain)),
                ContentHash.tree(SafeWalk.walk(tmp, installed), Set.of("LICENSE", "spectro-install.json")));
        assertNotEquals(ContentHash.tree(SafeWalk.walk(tmp, plain)),
                ContentHash.tree(SafeWalk.walk(tmp, installed)));
    }

    @Test
    void aWalkWithARefusalIsNotHashed() throws IOException {
        Path root = tree("linked", Map.of("SKILL.md", "s"));
        Files.createSymbolicLink(root.resolve("notes.md"), tmp.resolve("linked/SKILL.md"));
        assertThrows(IllegalArgumentException.class, () -> ContentHash.tree(SafeWalk.walk(tmp, root)));
    }

    @Test
    void theHookHashIsTheFourFieldsEachEndedByAZeroByte() throws Exception {
        String expected = sha256(
                "PreToolUse".getBytes(UTF_8), new byte[] {0},
                "Bash".getBytes(UTF_8), new byte[] {0},
                "echo hi".getBytes(UTF_8), new byte[] {0},
                "30".getBytes(UTF_8), new byte[] {0});
        assertEquals(expected, ContentHash.hook("PreToolUse", "Bash", "echo hi", 30));
    }

    @Test
    void aNullHookFieldHashesAsTheEmptyString() throws Exception {
        String expected = sha256(
                "Stop".getBytes(UTF_8), new byte[] {0},
                new byte[] {0},
                "echo hi".getBytes(UTF_8), new byte[] {0},
                new byte[] {0});
        assertEquals(expected, ContentHash.hook("Stop", null, "echo hi", null));
        assertEquals(ContentHash.hook("Stop", "", "echo hi", null), ContentHash.hook("Stop", null, "echo hi", null));
    }

    @Test
    void hookFieldsDoNotRunTogether() {
        assertNotEquals(ContentHash.hook("Stop", "ab", "c", null), ContentHash.hook("Stop", "a", "bc", null));
    }

    @Test
    void theContentsHashIsTheSortedLinesEachEndedByANewline() throws Exception {
        String expected = sha256("hook b 02\nskill a 01\n".getBytes(UTF_8));
        assertEquals(expected, ContentHash.contents(List.of("skill a 01", "hook b 02")));
    }

    @Test
    void theContentsHashIgnoresLineOrder() {
        assertEquals(ContentHash.contents(List.of("skill a 01", "hook b 02")),
                ContentHash.contents(List.of("hook b 02", "skill a 01")));
    }
}
