package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The workspace resolution rules: a configured directory wins and is created;
 * without one, every session gets a deterministic folder under the OS temp
 * dir — the SAME folder again on resume, because it is keyed by the session
 * id. {@code locate} must never create anything (it backs read-only REST
 * lookups).
 */
class WorkspaceResolverTest {

    @Test
    void configuredPathIsCreatedAndNormalized(@TempDir Path tmp) {
        Path configured = tmp.resolve("nested/./agent-work");
        Path resolved = WorkspaceResolver.resolve(configured.toString(), "20260716-abc");
        assertTrue(Files.isDirectory(resolved));
        assertEquals(tmp.resolve("nested/agent-work").toAbsolutePath().normalize(), resolved);
    }

    @Test
    void tildeExpandsToTheUserHome() {
        Path resolved = WorkspaceResolver.locate("~/some-spectroscope-workspace", "id-1");
        assertEquals(Path.of(System.getProperty("user.home"), "some-spectroscope-workspace")
                .toAbsolutePath().normalize(), resolved);
    }

    @Test
    void aConfiguredPathThatIsAFileRefusesLoudly(@TempDir Path tmp) throws IOException {
        Path file = tmp.resolve("occupied.txt");
        Files.writeString(file, "not a directory");
        assertThrows(IllegalStateException.class,
                () -> WorkspaceResolver.resolve(file.toString(), "id-1"));
    }

    @Test
    void unsetFallsBackToTheSessionKeyedTempFolder() {
        Path resolved = WorkspaceResolver.resolve(null, "20260716-170000-cafe1234");
        Path tmpRoot = Path.of(System.getProperty("java.io.tmpdir")).toAbsolutePath().normalize();
        assertTrue(resolved.startsWith(tmpRoot));
        assertEquals("20260716-170000-cafe1234", resolved.getFileName().toString());
        assertEquals("spectroscope-ws", resolved.getParent().getFileName().toString());
        assertTrue(Files.isDirectory(resolved));
    }

    @Test
    void theSameSessionResolvesToTheSameFolder() {
        Path first = WorkspaceResolver.resolve(null, "resume-me");
        Path second = WorkspaceResolver.resolve(null, "resume-me");
        Path other = WorkspaceResolver.resolve(null, "someone-else");
        assertEquals(first, second);
        assertFalse(first.equals(other));
    }

    @Test
    void locateNeverCreatesAnything(@TempDir Path tmp) {
        Path configured = tmp.resolve("never-created");
        Path located = WorkspaceResolver.locate(configured.toString(), "id-1");
        assertEquals(configured.toAbsolutePath().normalize(), located);
        assertFalse(Files.exists(located));
        Path auto = WorkspaceResolver.locate(null, "locate-only-session");
        assertFalse(Files.exists(auto));
    }

    @Test
    void aBlankSessionIdIsRefusedWhenNoWorkspaceIsConfigured() {
        assertThrows(IllegalArgumentException.class, () -> WorkspaceResolver.resolve(null, " "));
        assertThrows(IllegalArgumentException.class, () -> WorkspaceResolver.locate("", null));
    }
}
