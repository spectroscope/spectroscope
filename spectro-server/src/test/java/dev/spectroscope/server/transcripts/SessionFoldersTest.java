package dev.spectroscope.server.transcripts;

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
     * The scratchpad root is the literal {@code /tmp}.
     *
     * <p>The first version of this test also asserted the root is NOT
     * {@code java.io.tmpdir}, and that assertion was wrong — not about the code,
     * about the world. On macOS the property is a per-process folder under
     * {@code /var/folders} and the two genuinely differ, which is the reason the
     * literal is here at all; on Linux the property IS {@code /tmp}, so the
     * negative could never hold and the CI runner said so within a minute of a
     * merge. A macOS-only fact was pinned as a universal one, and a gate that
     * runs only on macOS can never catch that.</p>
     *
     * <p>So the positive claim is asserted always, and the distinction only
     * where a distinction exists.</p>
     */
    @Test
    void theScratchpadIsUnderTmp(@TempDir Path store) throws Exception {
        Path project = Files.createDirectories(store.resolve("-Users-me-Repo"));
        Path file = Files.writeString(project.resolve("abc-123.jsonl"), "{}");

        Path pad = SessionFolders.locate(file, SessionFolders.Kind.SCRATCHPAD);
        if (pad == null) {
            return; // a filesystem that cannot answer unix:uid says so, and that is allowed
        }
        assertTrue(pad.startsWith("/tmp"), pad.toString());
        assertTrue(pad.toString().endsWith("/-Users-me-Repo/abc-123/scratchpad"), pad.toString());

        // Only where the two really are different places — which is the whole
        // reason the literal is not the property.
        String processTemp = System.getProperty("java.io.tmpdir");
        if (!Path.of(processTemp).normalize().equals(Path.of("/tmp"))) {
            assertFalse(pad.startsWith(processTemp), pad.toString());
        }
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
