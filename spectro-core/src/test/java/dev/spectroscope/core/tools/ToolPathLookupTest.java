package dev.spectroscope.core.tools;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 449: one lookup for a program, over the same PATH the agent's tool shells
 * get. Voice input searched the inherited PATH alone, so a Finder-launched app
 * reported {@code whisper-cli} missing while it sat in {@code /opt/homebrew/bin}.
 *
 * <p>A temporary folder stands in for the Homebrew prefix, because the seam
 * takes the toolchain folders as a list. The search always ends in the system
 * folders ({@code /usr/bin} and three more), so a test that expects a program
 * to be found puts it in a folder that comes first, and a test that expects it
 * missing asks for a name no host has. The last test runs the production
 * lookup on this JVM's own PATH and needs {@code sh} on the host.
 */
class ToolPathLookupTest {

    /** launchd's PATH for a GUI app, measured 2026-08-17 (see ToolPath). */
    private static final String LAUNCHD = "/usr/bin:/bin:/usr/sbin:/sbin";

    /** A home that is not absolute contributes no per-user folder. */
    private static final Path NO_HOME = Path.of("");

    /** A name no machine has, so a search for it always runs to the end. */
    private static final String NOBODY = "spectro-card-449-no-such-program";

    private static Path program(Path dir, String name) throws IOException {
        Files.createDirectories(dir);
        Path file = dir.resolve(name);
        Files.writeString(file, "#!/bin/sh\necho " + dir.getFileName() + "\n");
        assertTrue(file.toFile().setExecutable(true), "could not mark " + file + " executable");
        return file;
    }

    @Test
    void aFinderLaunchedAppFindsAProgramInTheHomebrewPrefix(@TempDir Path dir) throws IOException {
        Path prefix = dir.resolve("homebrew").resolve("bin");
        Path whisper = program(prefix, "whisper-cli");

        ToolPath.Lookup lookup = ToolPath.locate("whisper-cli", LAUNCHD, NO_HOME,
                List.of(prefix.toString()));

        assertTrue(lookup.isFound(), "the prefix holds it: " + lookup);
        assertEquals(whisper.toString(), lookup.found());
        assertEquals("whisper-cli", lookup.name());
        assertEquals(prefix.toString(), lookup.searched().getFirst(),
                "the toolchain folder is searched before launchd's four: " + lookup.searched());
    }

    @Test
    void theSearchIsTheToolPathsAbsoluteFoldersInOrderEachOnce(@TempDir Path dir) throws IOException {
        Path prefix = Files.createDirectories(dir.resolve("prefix"));
        Path a = Files.createDirectories(dir.resolve("a"));
        String inherited = a + ":" + LAUNCHD + ":" + a + "/";

        ToolPath.Lookup lookup = ToolPath.locate(NOBODY, inherited, NO_HOME, List.of(prefix.toString()));

        // The same resolution a tool shell gets, not a second list.
        String toolPath = ToolPath.resolve(inherited, NO_HOME, List.of(prefix.toString()),
                Files::isDirectory).path();
        LinkedHashSet<String> expected = new LinkedHashSet<>();
        for (String entry : toolPath.split(":")) {
            String trimmed = entry.endsWith("/") && entry.length() > 1
                    ? entry.substring(0, entry.length() - 1) : entry;
            if (trimmed.startsWith("/")) {
                expected.add(trimmed);
            }
        }
        assertEquals(new ArrayList<>(expected), lookup.searched());
        assertEquals(prefix.toString(), lookup.searched().getFirst());
        assertEquals(1, lookup.searched().stream().filter(a.toString()::equals).count(),
                "a folder named twice on the PATH is listed once: " + lookup.searched());
    }

    @Test
    void aMissingProgramNamesEveryFolderItLookedIn(@TempDir Path dir) throws IOException {
        Path prefix = Files.createDirectories(dir.resolve("prefix"));

        ToolPath.Lookup lookup = ToolPath.locate(NOBODY, LAUNCHD, NO_HOME, List.of(prefix.toString()));

        assertFalse(lookup.isFound());
        assertNull(lookup.found());
        assertTrue(lookup.searched().contains(prefix.toString()), lookup.searched().toString());
        assertTrue(lookup.searched().contains("/usr/bin"), lookup.searched().toString());
    }

    @Test
    void theFirstFolderOnTheToolPathWins(@TempDir Path dir) throws IOException {
        Path prefix = dir.resolve("prefix");
        Path system = dir.resolve("system");
        Path fromPrefix = program(prefix, "tool");
        program(system, "tool");

        ToolPath.Lookup lookup = ToolPath.locate("tool", system.toString(), NO_HOME,
                List.of(prefix.toString()));

        assertEquals(fromPrefix.toString(), lookup.found(),
                "the toolchain folder is prepended, so its copy wins, as in a login shell");
    }

    @Test
    void aFileThatCannotBeExecutedIsNotAProgram(@TempDir Path dir) throws IOException {
        Path bin = Files.createDirectories(dir.resolve("bin"));
        Files.writeString(bin.resolve(NOBODY), "text");

        assertNull(ToolPath.locate(NOBODY, bin.toString(), NO_HOME, List.of()).found(),
                "a plain file is not a binary you can run");
    }

    @Test
    void aDirectoryNamedLikeTheProgramIsNotAProgram(@TempDir Path dir) throws IOException {
        Path bin = Files.createDirectories(dir.resolve("bin"));
        Files.createDirectories(bin.resolve(NOBODY));

        assertNull(ToolPath.locate(NOBODY, bin.toString(), NO_HOME, List.of()).found());
    }

    @Test
    void emptyAndRelativeEntriesAreNeverSearched() {
        ToolPath.Lookup lookup = ToolPath.locate(NOBODY, "::relative/bin:.:" + LAUNCHD, NO_HOME,
                List.of());

        for (String folder : lookup.searched()) {
            assertTrue(folder.startsWith("/"),
                    "a folder that moves with the working directory was searched: " + folder);
        }
        // Skipped, not the end of the search: the absolute entries after them count.
        assertEquals(List.of("/usr/bin", "/bin", "/usr/sbin", "/sbin"), lookup.searched());
    }

    @Test
    void aNameThatIsAlreadyAPathIsRefused() {
        assertThrows(IllegalArgumentException.class,
                () -> ToolPath.locate("bin/whisper-cli", LAUNCHD, NO_HOME, List.of()));
        assertThrows(IllegalArgumentException.class,
                () -> ToolPath.locate(" ", LAUNCHD, NO_HOME, List.of()));
    }

    @Test
    void thisJvmsLookupSearchesThisJvmsToolPath() {
        ToolPath.Lookup lookup = ToolPath.locate("sh");

        assertNotNull(lookup.found(), "sh is on every host this runs on: " + lookup);
        List<String> absolute = new ArrayList<>(new LinkedHashSet<>(
                List.of(ToolPath.resolve().path().split(":")).stream()
                        .map(e -> e.length() > 1 && e.endsWith("/") ? e.substring(0, e.length() - 1) : e)
                        .filter(e -> e.startsWith("/"))
                        .toList()));
        assertEquals(absolute, lookup.searched(),
                "the production lookup searches exactly the PATH a tool shell gets");
    }
}
