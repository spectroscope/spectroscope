package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The three folders a recorded session leaves on disk.
 *
 * <p>Every path here is DERIVED from a transcript the caller already proved it
 * may read. Nothing a caller sends is ever opened, and these tests exist mostly
 * to keep that true: a change that let a caller steer the path would have to
 * break one of them.</p>
 */
class SessionFoldersTest {

    @Test
    void theProjectFolderIsTheOneTheTranscriptSitsIn(@TempDir Path store) throws Exception {
        Path project = Files.createDirectories(store.resolve("-Users-me-Repo"));
        Path file = Files.writeString(project.resolve("abc-123.jsonl"), "{}");

        assertEquals(project, SessionFolders.locate(file, SessionFolders.Kind.TRANSCRIPT));
    }

    @Test
    void theWorkflowsFolderIsUnderTheSessionsOwnName(@TempDir Path store) throws Exception {
        Path project = Files.createDirectories(store.resolve("-Users-me-Repo"));
        Path file = Files.writeString(project.resolve("abc-123.jsonl"), "{}");

        assertEquals(
                project.resolve("abc-123").resolve("subagents").resolve("workflows"),
                SessionFolders.locate(file, SessionFolders.Kind.WORKFLOWS));
    }

    @Test
    void theSessionIdIsTheFilename(@TempDir Path dir) {
        assertEquals("abc-123", SessionFolders.sessionIdOf(dir.resolve("abc-123.jsonl")));
        assertNull(SessionFolders.sessionIdOf(dir.resolve("notes.txt")));
    }

    @Test
    void aFolderThatIsNotThereIsNotOffered(@TempDir Path store) throws Exception {
        Path project = Files.createDirectories(store.resolve("-Users-me-Repo"));
        Path file = Files.writeString(project.resolve("abc-123.jsonl"), "{}");

        // The project directory exists because the transcript is in it; the
        // workflows folder does not, and a button for it would open nothing.
        assertTrue(SessionFolders.isThere(SessionFolders.locate(file, SessionFolders.Kind.TRANSCRIPT)));
        assertFalse(SessionFolders.isThere(SessionFolders.locate(file, SessionFolders.Kind.WORKFLOWS)));
    }

    @Test
    void aFileIsNotAFolder(@TempDir Path store) throws Exception {
        Path file = Files.writeString(store.resolve("abc-123.jsonl"), "{}");

        assertFalse(SessionFolders.isThere(file));
        assertFalse(SessionFolders.isThere(null));
    }

    @Test
    void theWorkflowsFolderIsOfferedOnceItExists(@TempDir Path store) throws Exception {
        Path project = Files.createDirectories(store.resolve("-Users-me-Repo"));
        Path file = Files.writeString(project.resolve("abc-123.jsonl"), "{}");
        Files.createDirectories(project.resolve("abc-123").resolve("subagents").resolve("workflows"));

        assertTrue(SessionFolders.isThere(SessionFolders.locate(file, SessionFolders.Kind.WORKFLOWS)));
    }

    /**
     * The scratchpad root is the literal {@code /tmp}, not {@code java.io.tmpdir}.
     *
     * <p>On macOS that property is a per-process folder under
     * {@code /var/folders} and the scratchpad is not in it. Measured on the
     * machine this was written on: the harness writes {@code /tmp/claude-501/…}
     * while the property read {@code /var/folders/88/…/T/}. This pins the
     * distinction rather than the existence of any particular folder, so it
     * holds on a machine that has never run the harness.</p>
     */
    @Test
    void theScratchpadIsUnderTmpAndNotUnderTheProcessTempDir(@TempDir Path store) throws Exception {
        Path project = Files.createDirectories(store.resolve("-Users-me-Repo"));
        Path file = Files.writeString(project.resolve("abc-123.jsonl"), "{}");

        Path pad = SessionFolders.locate(file, SessionFolders.Kind.SCRATCHPAD);
        if (pad == null) {
            return; // a filesystem that cannot answer unix:uid says so, and that is allowed
        }
        assertTrue(pad.startsWith("/tmp"), pad.toString());
        assertTrue(pad.toString().endsWith("/-Users-me-Repo/abc-123/scratchpad"), pad.toString());
        assertFalse(pad.startsWith(System.getProperty("java.io.tmpdir")), pad.toString());
    }

    @Test
    void openingSomethingThatIsNotThereSaysSoRatherThanThrowing(@TempDir Path dir) {
        assertEquals(FolderOpener.Result.MISSING, FolderOpener.open(null));
        assertEquals(FolderOpener.Result.MISSING, FolderOpener.open(dir.resolve("no-such-folder")));
    }

    @Test
    void openingAFileRatherThanAFolderIsRefused(@TempDir Path dir) throws Exception {
        Path file = Files.writeString(dir.resolve("a.jsonl"), "{}");

        assertEquals(FolderOpener.Result.MISSING, FolderOpener.open(file));
    }
}
