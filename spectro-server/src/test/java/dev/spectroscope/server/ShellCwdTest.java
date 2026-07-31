package dev.spectroscope.server;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Where the shell starts. The card's promise is "the shell shares the agent's
 * world", so this resolves by exactly the rules {@link WorkspaceController} uses
 * for the Files tree — the picked pin first, then the configured workspace, then
 * the per-session auto folder. The session id is the ONLY thing the client gets
 * to influence, and it is shape-checked before it ever reaches a path.
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
    void aMissingSessionIsRefusedRatherThanFallingBackToTheServersCwd() {
        // /api/files answers the boot directory when no session is given. A shell
        // does not: no session, no shell.
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
