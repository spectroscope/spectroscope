package dev.spectroscope.server.starter;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;

class FolderWriterTest {

    @TempDir Path tmp;

    private static Map<String, String> files(String... kv) {
        Map<String, String> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    private FolderWriter.Result run(Path dir, Map<String, String> files, boolean create) {
        FolderWriter.Planned p = FolderWriter.plan(dir, files, create);
        return p instanceof FolderWriter.Ready r ? FolderWriter.write(r) : ((FolderWriter.Refused) p).result();
    }

    @Test
    void writesEveryFileInOrder() throws Exception {
        var r = assertInstanceOf(FolderWriter.Written.class, run(tmp, files("a.txt", "A", "d/b.txt", "B"), false));
        assertEquals(List.of("a.txt", "d/b.txt"), r.written());
        assertEquals("B", Files.readString(tmp.resolve("d/b.txt")));
    }

    @Test
    void refusesALexicalEscapeAndWritesNothing() {
        var r = assertInstanceOf(FolderWriter.Escape.class, run(tmp, files("a.txt", "A", "../x.txt", "X"), false));
        assertEquals("../x.txt", r.key());
        assertFalse(Files.exists(tmp.resolve("a.txt")));
    }

    @Test
    void refusesAnEscapeThroughASymlinkedFolder() throws Exception {
        Path root = Files.createDirectories(tmp.resolve("root"));
        Path outside = Files.createDirectories(tmp.resolve("outside"));
        Files.createSymbolicLink(root.resolve("src"), outside);
        var r = assertInstanceOf(FolderWriter.Escape.class, run(root, files("src/a.txt", "A"), false));
        assertEquals("src/a.txt", r.key());
        assertFalse(Files.exists(outside.resolve("a.txt")));
    }

    @Test
    void refusesAnExistingTargetAndWritesNothing() throws Exception {
        Files.writeString(tmp.resolve("b.txt"), "mine");
        var r = assertInstanceOf(FolderWriter.Conflicts.class, run(tmp, files("a.txt", "A", "b.txt", "B"), false));
        assertEquals(List.of("b.txt"), r.conflicts());
        assertEquals(List.of(), r.written());
        assertFalse(Files.exists(tmp.resolve("a.txt")));
        assertEquals("mine", Files.readString(tmp.resolve("b.txt")));
    }

    @Test
    void aFileThatAppearsBetweenThePassesIsNotOverwritten() throws Exception {
        var ready = assertInstanceOf(FolderWriter.Ready.class, FolderWriter.plan(tmp, files("a.txt", "A", "b.txt", "B"), false));
        Files.writeString(tmp.resolve("b.txt"), "mine");
        var r = assertInstanceOf(FolderWriter.Conflicts.class, FolderWriter.write(ready));
        assertEquals(List.of("b.txt"), r.conflicts());
        assertEquals(List.of("a.txt"), r.written());
        assertEquals("mine", Files.readString(tmp.resolve("b.txt")));
    }

    @Test
    void anIoFailureReportsWhatWasWritten() throws Exception {
        var ready = assertInstanceOf(FolderWriter.Ready.class, FolderWriter.plan(tmp, files("a.txt", "A", "sub/b.txt", "B"), false));
        Files.writeString(tmp.resolve("sub"), "a file where a folder must go");
        var r = assertInstanceOf(FolderWriter.Failed.class, FolderWriter.write(ready));
        assertEquals(List.of("a.txt"), r.written());
    }

    @Test
    void createsAMissingRootOneLevelOnlyWhenAsked() throws Exception {
        assertInstanceOf(FolderWriter.NotAFolder.class, run(tmp.resolve("new"), files("a.txt", "A"), false));
        assertInstanceOf(FolderWriter.Written.class, run(tmp.resolve("new"), files("a.txt", "A"), true));
        assertEquals("A", Files.readString(tmp.resolve("new/a.txt")));
        assertInstanceOf(FolderWriter.NotAFolder.class, run(tmp.resolve("x/y"), files("a.txt", "A"), true));
    }
}
