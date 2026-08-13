package dev.spectroscope.core.launch;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The reader of Claude Code's {@code .claude/launch.json} (card 202,
 * criterion 1). The shapes driven here are the ones the corpus walk found on
 * 2026-08-13, plus the one it did not find and the format still allows.
 */
class LaunchFileTest {

    /** The measured shape: a top-level version, and the four entry keys. */
    @Test
    void readsTheShapeRealFilesCarry() {
        LaunchFile file = LaunchFile.parse("""
                {
                  "version": "0.0.1",
                  "configurations": [
                    { "name": "web", "runtimeExecutable": "npm",
                      "runtimeArgs": ["run", "dev"], "port": 5173 }
                  ]
                }
                """);
        assertEquals("0.0.1", file.version());
        assertEquals(List.of("web"), file.names());
        LaunchEntry web = file.find("web").orElseThrow();
        assertEquals("npm", web.runtimeExecutable());
        assertEquals(List.of("run", "dev"), web.runtimeArgs());
        assertEquals(5173, web.port());
        assertFalse(web.attaches(), "an entry with a command is one we start");
        assertEquals("http://localhost:5173/", web.address());
        assertEquals("npm run dev", web.commandLine());
    }

    /**
     * Criterion 1, the compatibility half: a version this build never heard of
     * and an entry key it does not use must not cost the file its load.
     */
    @Test
    void aVersionAndKeysTheReaderDoesNotKnowAreIgnoredNotRefused() {
        LaunchFile file = LaunchFile.parse("""
                {
                  "version": "9.9.9-from-the-future",
                  "somethingElseEntirely": { "nested": true },
                  "configurations": [
                    { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"],
                      "port": 5173, "autoPort": true, "envFile": ".env.local" }
                  ]
                }
                """);
        assertEquals("9.9.9-from-the-future", file.version());
        assertEquals(List.of("web"), file.names());
        LaunchEntry web = file.find("web").orElseThrow();
        assertEquals(5173, web.port());
        assertEquals(List.of("autoPort", "envFile"), web.unknownKeys(),
                "the keys are recorded so a listing can say what it ignored");
    }

    /**
     * The command line is printed for a human and a model, so one argument reads
     * as one argument.
     *
     * <p>Space-joining printed a real entry as
     * {@code /bin/sh -c python3 -m http.server 51824 & sleep 2}, which looks like
     * eight arguments where there are two, and cannot be pasted anywhere. Nothing
     * here is ever executed — the process is built from the argument list — so
     * this is purely about a sentence that does not mislead.
     */
    @Test
    void anArgumentThatCarriesSpacesIsQuotedSoItReadsAsOneArgument() {
        LaunchFile file = LaunchFile.parse("""
                {
                  "version": "0.0.1",
                  "configurations": [
                    { "name": "web", "runtimeExecutable": "/bin/sh",
                      "runtimeArgs": ["-c", "python3 -m http.server 51824 & sleep 2"],
                      "port": 51824 }
                  ]
                }
                """);
        assertEquals("/bin/sh -c 'python3 -m http.server 51824 & sleep 2'",
                file.find("web").orElseThrow().commandLine());
    }

    /** And an argument with nothing special in it is left exactly as written. */
    @Test
    void aPlainArgumentIsNotDressedUp() {
        assertEquals("npm run dev",
                new LaunchEntry("web", 5173, "npm", List.of("run", "dev"), null, List.of())
                        .commandLine());
        assertEquals("npm run dev -- --port '5173 5174'",
                new LaunchEntry("web", 5173, "npm",
                        List.of("run", "dev", "--", "--port", "5173 5174"), null, List.of())
                        .commandLine());
    }

    /** Criterion 2: a url and no command is an entry spectroscope cannot run. */
    @Test
    void aUrlWithNoCommandIsAnAttachEntry() {
        LaunchFile file = LaunchFile.parse("""
                {
                  "version": "0.0.1",
                  "configurations": [
                    { "name": "already-up", "url": "http://localhost:4321/", "port": 4321 }
                  ]
                }
                """);
        LaunchEntry entry = file.find("already-up").orElseThrow();
        assertTrue(entry.attaches(), "no runtimeExecutable means nothing to spawn");
        assertEquals("http://localhost:4321/", entry.address());
        assertEquals("", entry.commandLine());
    }

    /** A url beats the port when the entry carries both. */
    @Test
    void theUrlWinsOverThePortWhenBothAreThere() {
        LaunchEntry entry = LaunchFile.parse("""
                { "configurations": [
                  { "name": "app", "runtimeExecutable": "npm", "runtimeArgs": [],
                    "port": 5173, "url": "http://app.localhost:5173/panel" } ] }
                """).find("app").orElseThrow();
        assertEquals("http://app.localhost:5173/panel", entry.address());
    }

    /** An entry with neither a url nor a port has no address to open. */
    @Test
    void anEntryWithNoPortAndNoUrlHasNoAddress() {
        LaunchEntry entry = LaunchFile.parse("""
                { "configurations": [ { "name": "worker", "runtimeExecutable": "node",
                  "runtimeArgs": ["worker.js"] } ] }
                """).find("worker").orElseThrow();
        assertNull(entry.address());
    }

    /** A nameless entry cannot be addressed, so it is dropped and counted. */
    @Test
    void anEntryWithoutANameIsDroppedAndCounted() {
        LaunchFile file = LaunchFile.parse("""
                { "configurations": [
                  { "runtimeExecutable": "npm", "port": 1 },
                  { "name": "web", "runtimeExecutable": "npm", "port": 2 } ] }
                """);
        assertEquals(List.of("web"), file.names());
        assertEquals(1, file.skipped());
    }

    /** What is NOT this format is refused, with the reason in the sentence. */
    @Test
    void aFileThatIsNotThisFormatIsRefusedByWhatIsWrongWithIt() {
        assertTrue(assertThrows(IllegalArgumentException.class,
                () -> LaunchFile.parse("not json at all")).getMessage().contains("not JSON"));
        assertTrue(assertThrows(IllegalArgumentException.class,
                () -> LaunchFile.parse("[1,2,3]")).getMessage().contains("not a JSON object"));
        assertTrue(assertThrows(IllegalArgumentException.class,
                () -> LaunchFile.parse("{\"version\":\"0.0.1\"}"))
                .getMessage().contains("configurations"));
    }

    /** A project with no launch file is empty, not an error. */
    @Test
    void aProjectWithoutALaunchFileReadsEmpty(@TempDir Path project) {
        assertEquals(Optional.empty(), LaunchFile.readFrom(project));
    }

    /** The file is read from Claude Code's own location, not one of ours. */
    @Test
    void readsFromTheClaudeCodeLocation(@TempDir Path project) throws Exception {
        assertEquals(".claude/launch.json", LaunchFile.LOCATION);
        Files.createDirectories(project.resolve(".claude"));
        Files.writeString(project.resolve(LaunchFile.LOCATION), """
                { "version": "0.0.1", "configurations": [
                  { "name": "docs", "runtimeExecutable": "python3",
                    "runtimeArgs": ["-m", "http.server", "8000"], "port": 8000 } ] }
                """);
        assertEquals(List.of("docs"), LaunchFile.readFrom(project).orElseThrow().names());
    }
}
