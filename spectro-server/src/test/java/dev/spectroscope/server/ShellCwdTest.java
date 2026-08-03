package dev.spectroscope.server;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Where the shell starts. The card's promise is "the shell shares the agent's
 * world", so this reads the folder the run resolved, which is the record
 * {@link WorkspaceController} serves the Files tree from. Before any run it
 * falls back to the prospective rule: the picked pin first, then the configured
 * workspace, then the per-session auto folder. The session id is the ONLY thing
 * the client gets to influence, and it is shape-checked before it ever reaches
 * a path.
 */
class ShellCwdTest {

    @Test
    void aPickedFolderWinsLikeItDoesForTheFilesTree() {
        SessionWorkspaces.pin("cwd-test-pinned", "/tmp/picked-by-the-operator");
        assertEquals(Path.of("/tmp/picked-by-the-operator"),
                ShellCwd.locate("cwd-test-pinned", () -> "/tmp/configured"));
    }

    @Test
    void otherwiseTheConfiguredWorkspaceWins() {
        assertEquals(Path.of("/tmp/configured-workspace"),
                ShellCwd.locate("cwd-test-configured", () -> "/tmp/configured-workspace"));
    }

    @Test
    void withNothingConfiguredItIsTheSessionsOwnFolder() {
        Path resolved = ShellCwd.locate("cwd-test-auto", () -> null);
        assertEquals(Path.of(System.getProperty("java.io.tmpdir"), "spectroscope-ws", "cwd-test-auto")
                .toAbsolutePath().normalize(), resolved);
    }

    @Test
    void theShellFollowsTheFolderTheRunActuallyResolved() {
        // The Files tree reads the folder the socket recorded; this recomputed
        // the rule from a config read fresh on every shell. Change the
        // configured workspace mid-session and the tree and the terminal in the
        // same pane pointed at different directories, while the product's own
        // copy promises "a running session keeps its own workspace".
        String session = "cwd-test-resolved-" + System.nanoTime();
        SessionWorkspaces.resolved(session, "/tmp/the-folder-the-run-used");

        assertEquals(Path.of("/tmp/the-folder-the-run-used"),
                ShellCwd.locate(session, () -> "/tmp/configured-after-the-run-started"));
    }

    @Test
    void withNothingResolvedYetTheOldRuleStillNamesAFolder() {
        // A shell can be opened before the first run, so the prospective rule
        // has to survive: that is what makes the tab usable at all.
        String session = "cwd-test-unresolved-" + System.nanoTime();
        assertEquals(Path.of("/tmp/configured"), ShellCwd.locate(session, () -> "/tmp/configured"));
    }

    @Test
    void aMissingSessionIsRefusedRatherThanFallingBackToTheServersCwd() {
        // A shell needs a session: no session, no shell. /api/files answers 409
        // to the same request, for the same reason.
        assertThrows(IllegalArgumentException.class, () -> ShellCwd.locate(null, () -> null));
        assertThrows(IllegalArgumentException.class, () -> ShellCwd.locate("  ", () -> null));
    }

    @Test
    void aMalformedSessionIdNeverReachesAPath() {
        assertThrows(IllegalArgumentException.class, () -> ShellCwd.locate("../../etc", () -> null));
        assertThrows(IllegalArgumentException.class, () -> ShellCwd.locate("a/b", () -> null));
        assertThrows(IllegalArgumentException.class, () -> ShellCwd.locate("a b", () -> null));
        assertThrows(IllegalArgumentException.class, () -> ShellCwd.locate("-leading", () -> null));
        assertThrows(IllegalArgumentException.class, () -> ShellCwd.locate("semi;colon", () -> null));
    }
}
