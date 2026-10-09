package dev.spectroscope.server.playbooks;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class PlaybookFoldersTest {

    @TempDir Path tmp;

    private Path playbookFolder(String name) throws IOException {
        Path folder = Files.createDirectories(tmp.resolve(name));
        Files.writeString(folder.resolve("playbook.json"), "{}");
        return folder;
    }

    @Test
    void registersAFolderOnceAndPinsItToAWorkspace() throws IOException {
        PlaybookFolders folders = new PlaybookFolders(tmp.resolve("playbooks.json"));
        Path a = playbookFolder("a");
        folders.register(a);
        folders.register(a);
        assertEquals(List.of(a.toRealPath().toString()), folders.read().folders());
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        assertNull(folders.activeFor(ws));
        folders.pin(ws, a);
        assertEquals(a.toRealPath(), folders.activeFor(ws));
        // survives a fresh reader
        assertEquals(a.toRealPath(), new PlaybookFolders(tmp.resolve("playbooks.json")).activeFor(ws));
    }

    @Test
    void refusesAFolderWithoutAPlaybookAndAPinToAnUnknownFolder() throws IOException {
        PlaybookFolders folders = new PlaybookFolders(tmp.resolve("playbooks.json"));
        Path empty = Files.createDirectories(tmp.resolve("empty"));
        assertThrows(IllegalArgumentException.class, () -> folders.register(empty));
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        assertThrows(IllegalArgumentException.class, () -> folders.pin(ws, empty));
    }

    @Test
    void aMissingFileReadsAsEmpty() {
        PlaybookFolders folders = new PlaybookFolders(tmp.resolve("none.json"));
        assertEquals(List.of(), folders.read().folders());
    }

    @Test
    void theFileHasTheDocumentedShapeAndLeavesNoTempFileBehind() throws IOException {
        Path file = tmp.resolve("playbooks.json");
        PlaybookFolders folders = new PlaybookFolders(file);
        Path a = playbookFolder("a");
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        folders.register(a);
        folders.pin(ws, a);
        var root = new com.fasterxml.jackson.databind.ObjectMapper().readTree(Files.readString(file));
        assertEquals(a.toRealPath().toString(), root.get("folders").get(0).asText());
        assertEquals(a.toRealPath().toString(), root.get("active").get(ws.toRealPath().toString()).asText());
        assertEquals(false, Files.exists(tmp.resolve("playbooks.json.tmp")));
    }

    @Test
    void aPinToAFolderThatWasRegisteredThenRemovedFromDiskReadsAsNone() throws IOException {
        PlaybookFolders folders = new PlaybookFolders(tmp.resolve("playbooks.json"));
        Path a = playbookFolder("a");
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        folders.register(a);
        folders.pin(ws, a);
        Files.delete(a.resolve("playbook.json"));
        assertNull(folders.activeFor(ws));
    }
}
