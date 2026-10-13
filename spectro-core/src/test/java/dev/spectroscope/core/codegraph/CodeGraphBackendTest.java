package dev.spectroscope.core.codegraph;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 587, criterion 6: the program behind the code graph is a backend the
 * {@code codeGraphBackend} setting names, so another graph tool can take
 * graphify's place. graphify is the only backend today.
 */
class CodeGraphBackendTest {

    @Test
    void graphifyIsTheOnlyBackendAndTheDefault() {
        assertEquals(List.of(CodeGraphBackend.GRAPHIFY), CodeGraphBackend.ALL);
        assertEquals(Set.of("graphify"), CodeGraphBackend.names());
        assertEquals("graphify", CodeGraphBackend.DEFAULT);
        assertEquals(Optional.of(CodeGraphBackend.GRAPHIFY), CodeGraphBackend.named("graphify"));
        assertEquals(Optional.empty(), CodeGraphBackend.named("other"));
        assertEquals(Optional.empty(), CodeGraphBackend.named(null));
    }

    @Test
    void graphifyNamesItsProgramItsInstallLineAndItsTwoFiles() {
        CodeGraphBackend graphify = CodeGraphBackend.GRAPHIFY;
        assertEquals("graphify", graphify.name());
        assertEquals("graphify", graphify.binary());
        assertEquals("uv tool install graphifyy", graphify.install());
        assertEquals(Path.of("graphify-out", "graph.json"), graphify.graphFile());
        assertEquals(Path.of("graphify-out", "graph.html"), graphify.pageFile());
    }

    @Test
    void aSettingValueResolvesToItsBackendAndAnUnknownOneIsRefusedByName() {
        assertSame(CodeGraphBackend.GRAPHIFY, CodeGraphBackend.require("graphify"));
        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> CodeGraphBackend.require("othergraph"));
        assertTrue(refused.getMessage().contains("othergraph"), refused.getMessage());
        assertTrue(refused.getMessage().contains("graphify"), refused.getMessage());
    }

    /** Fix round, M8: a backend's files are relative and never climb out of the folder. */
    @Test
    void aBackendsFilesCannotClimbOutOfTheFolder() {
        assertThrows(IllegalArgumentException.class, () -> new CodeGraphBackend("x", "x", "i",
                Path.of("..", "a.json"), Path.of("a.html")));
        assertThrows(IllegalArgumentException.class, () -> new CodeGraphBackend("x", "x", "i",
                Path.of("a.json"), Path.of("out", "..", "..", "a.html")));
        assertEquals("x", new CodeGraphBackend("x", "x", "i", Path.of("out", "a.json"), Path.of("out", "a.html"))
                .name(), "premise: two plain relative files make a backend");
    }

    private static Path folder(Path base, String name, Path... files) throws IOException {
        Path folder = Files.createDirectories(base.resolve(name));
        for (Path file : files) {
            Files.createDirectories(folder.resolve(file).getParent());
            Files.writeString(folder.resolve(file), "{}");
        }
        return folder;
    }

    /**
     * Fix round, M9: one rule says whether a folder has a code graph, for every
     * reader: the graph and its page are files inside the folder, and the page
     * is no larger than the page the browser panel serves.
     */
    @Test
    void aFolderHasACodeGraphOnlyWithBothFilesInsideIt(@TempDir Path base) throws IOException {
        CodeGraphBackend g = CodeGraphBackend.GRAPHIFY;
        Path both = folder(base, "both", g.graphFile(), g.pageFile());
        CodeGraphBackend.Found found = assertInstanceOf(CodeGraphBackend.Found.class, g.lookup(both));
        assertEquals(both.toRealPath().resolve(g.graphFile()), found.graph());
        assertEquals(both.toRealPath().resolve(g.pageFile()), found.page());
        assertTrue(g.hasGraph(both));
        assertInstanceOf(CodeGraphBackend.Missing.class, g.lookup(folder(base, "bare")));
        assertInstanceOf(CodeGraphBackend.Missing.class, g.lookup(folder(base, "graph-only", g.graphFile())),
                "a graph without its page, as an extract leaves it when clustering fails");
        assertInstanceOf(CodeGraphBackend.Missing.class, g.lookup(folder(base, "page-only", g.pageFile())));
        assertInstanceOf(CodeGraphBackend.Missing.class, g.lookup(null));
        assertFalse(g.hasGraph(folder(base, "graph-only-again", g.graphFile())));
        Path pageFolder = folder(base, "page-is-a-folder", g.graphFile());
        Files.createDirectories(pageFolder.resolve(g.pageFile()));
        assertInstanceOf(CodeGraphBackend.Missing.class, g.lookup(pageFolder), "a page that is a folder is no page");
    }

    @Test
    void aFileThatLinksOutOfTheFolderIsOutsideAndAPageAboveTheCapIsNoGraph(@TempDir Path base) throws IOException {
        CodeGraphBackend g = CodeGraphBackend.GRAPHIFY;
        Path elsewhere = folder(base, "elsewhere", g.graphFile(), g.pageFile());
        Path linked = folder(base, "linked", g.pageFile());
        Files.createSymbolicLink(linked.resolve(g.graphFile()), elsewhere.resolve(g.graphFile()));
        assertInstanceOf(CodeGraphBackend.Outside.class, g.lookup(linked));
        Path large = folder(base, "large", g.graphFile(), g.pageFile());
        try (RandomAccessFile page = new RandomAccessFile(large.resolve(g.pageFile()).toFile(), "rw")) {
            page.setLength(CodeGraphBackend.MAX_PAGE_BYTES + 1);
        }
        assertInstanceOf(CodeGraphBackend.Missing.class, g.lookup(large));
        try (RandomAccessFile page = new RandomAccessFile(large.resolve(g.pageFile()).toFile(), "rw")) {
            page.setLength(CodeGraphBackend.MAX_PAGE_BYTES);
        }
        assertInstanceOf(CodeGraphBackend.Found.class, g.lookup(large), "a page exactly at the cap counts");
    }

    @Test
    void aBackendNeedsEveryPartAndRelativeFiles() {
        assertThrows(IllegalArgumentException.class, () -> new CodeGraphBackend("x", "", "i",
                Path.of("a.json"), Path.of("a.html")));
        assertThrows(IllegalArgumentException.class, () -> new CodeGraphBackend("x", "x", "i",
                Path.of("/abs/a.json"), Path.of("a.html")));
    }
}
