package dev.spectroscope.core.copilot;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 497: where the Copilot runtime comes from on macOS, what the app says
 * when it is missing, and what the child process is started with.
 */
class CopilotRuntimeTest {

    private static final String MAC = "Mac OS X";

    @TempDir
    Path tmp;

    // the search order

    @Test
    void homebrewComesBeforeAnNpmPrefixAndBeforeThePath() throws IOException {
        Path brew = executable(tmp.resolve("brew/bin"));
        Path npm = executable(tmp.resolve("npm/bin"));
        Path onPath = executable(tmp.resolve("onpath"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .homebrew(brew.getParent())
                .npmConfigPrefix(tmp.resolve("npm").toString())
                .path(onPath.getParent().toString())
                .build(), null);

        assertEquals(CopilotRuntime.Status.FOUND, lookup.status(), lookup.toString());
        assertEquals(brew, lookup.path());
        assertEquals(CopilotRuntime.Source.HOMEBREW, lookup.source());
    }

    @Test
    void anNpmPrefixComesBeforeThePath() throws IOException {
        Path npm = executable(tmp.resolve("npm/bin"));
        Path onPath = executable(tmp.resolve("onpath"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .npmConfigPrefix(tmp.resolve("npm").toString())
                .path(onPath.getParent().toString())
                .build(), null);

        assertEquals(npm, lookup.path());
        assertEquals(CopilotRuntime.Source.NPM_GLOBAL, lookup.source());
    }

    @Test
    void thePrefixInNpmrcIsReadWhenTheVariableIsUnset() throws IOException {
        Path npm = executable(tmp.resolve("npmrc-prefix/bin"));
        Path npmrc = tmp.resolve("home/.npmrc");
        Files.createDirectories(npmrc.getParent());
        Files.writeString(npmrc, "fund=false\nprefix = " + tmp.resolve("npmrc-prefix") + "\n");

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env().npmrc(npmrc).build(), null);

        assertEquals(npm, lookup.path(), lookup.toString());
        assertEquals(CopilotRuntime.Source.NPM_GLOBAL, lookup.source());
    }

    @Test
    void thePathIsSearchedLast() throws IOException {
        Path onPath = executable(tmp.resolve("onpath"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .path("/nonexistent-entry:" + onPath.getParent()).build(), null);

        assertEquals(onPath, lookup.path());
        assertEquals(CopilotRuntime.Source.PATH, lookup.source());
    }

    @Test
    void anNpmInstallIntoTheHomebrewPrefixIsNamedAsNpm() throws IOException {
        // npm with Homebrew's node installs into /opt/homebrew/bin as a link to
        // lib/node_modules; the line should say npm, not Homebrew.
        Path loader = tmp.resolve("brew/lib/node_modules/@github/copilot/npm-loader.js");
        Files.createDirectories(loader.getParent());
        Files.writeString(loader, "#!/bin/sh\nexit 0\n");
        makeExecutable(loader);
        Path bin = Files.createDirectories(tmp.resolve("brew/bin"));
        Files.createSymbolicLink(bin.resolve("copilot"), loader);

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env().homebrew(bin).build(), null);

        assertEquals(bin.resolve("copilot"), lookup.path());
        assertEquals(CopilotRuntime.Source.NPM_GLOBAL, lookup.source());
    }

    // an explicit choice

    @Test
    void copilotCliPathWinsOverEveryFolder() throws IOException {
        executable(tmp.resolve("brew/bin"));
        Path chosen = executable(tmp.resolve("chosen"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .homebrew(tmp.resolve("brew/bin"))
                .copilotCliPath(chosen.toString())
                .build(), null);

        assertEquals(chosen, lookup.path());
        assertEquals(CopilotRuntime.Source.COPILOT_CLI_PATH, lookup.source());
    }

    @Test
    void aBrokenCopilotCliPathIsReportedAndNeverReplacedByAnotherRuntime() throws IOException {
        executable(tmp.resolve("brew/bin"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .homebrew(tmp.resolve("brew/bin"))
                .copilotCliPath(tmp.resolve("missing/copilot").toString())
                .build(), null);

        assertEquals(CopilotRuntime.Status.REJECTED, lookup.status(), lookup.toString());
        assertNull(lookup.path(), "a rejected choice must not hand out the Homebrew runtime");
        assertTrue(lookup.detail().contains("COPILOT_CLI_PATH"), lookup.detail());
    }

    // the security criterion: nothing from inside the workspace

    @Test
    void aRuntimeInsideTheWorkspaceIsSkippedOnThePath() throws IOException {
        Path workspace = Files.createDirectories(tmp.resolve("workspace"));
        Path planted = executable(workspace.resolve("node_modules/.bin"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .path(planted.getParent().toString()).build(), workspace);

        assertEquals(CopilotRuntime.Status.NOT_INSTALLED, lookup.status(), lookup.toString());
    }

    @Test
    void aLinkInAHomebrewFolderThatPointsIntoTheWorkspaceIsSkipped() throws IOException {
        Path workspace = Files.createDirectories(tmp.resolve("workspace"));
        Path planted = executable(workspace.resolve("tools"));
        Path bin = Files.createDirectories(tmp.resolve("brew/bin"));
        Files.createSymbolicLink(bin.resolve("copilot"), planted);
        Path onPath = executable(tmp.resolve("onpath"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .homebrew(bin).path(onPath.getParent().toString()).build(), workspace);

        assertEquals(onPath, lookup.path(), "the planted link is skipped, the next place answers");
    }

    @Test
    void copilotCliPathInsideTheWorkspaceIsRejected() throws IOException {
        Path workspace = Files.createDirectories(tmp.resolve("workspace"));
        Path planted = executable(workspace.resolve("bin"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .copilotCliPath(planted.toString()).build(), workspace);

        assertEquals(CopilotRuntime.Status.REJECTED, lookup.status(), lookup.toString());
        assertTrue(lookup.detail().contains("workspace"), lookup.detail());
    }

    // not installed, and not supported

    @Test
    void notInstalledNamesTheInstallLineAndEveryFolderSearchedInOrder() {
        Path brew = tmp.resolve("brew/bin");
        Path npm = tmp.resolve("npm");
        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .homebrew(brew).npmConfigPrefix(npm.toString()).path(tmp.resolve("p").toString())
                .build(), null);

        assertEquals(CopilotRuntime.Status.NOT_INSTALLED, lookup.status());
        assertEquals(List.of(brew.toString(), npm.resolve("bin").toString(), tmp.resolve("p").toString()),
                lookup.searched().subList(0, 3));
        assertTrue(lookup.detail().contains("brew install --cask copilot-cli"), lookup.detail());
    }

    @Test
    void theInstallLineIsTheOneFromGitHubsDocumentation() {
        assertEquals("brew install --cask copilot-cli", CopilotRuntime.INSTALL_LINE);
        assertTrue(CopilotRuntime.INSTALL_SOURCE.startsWith("https://docs.github.com/"),
                CopilotRuntime.INSTALL_SOURCE);
    }

    @Test
    void linuxAndWindowsAreNotSupportedEvenWithARuntimeOnThePath() throws IOException {
        Path onPath = executable(tmp.resolve("onpath"));
        for (String os : List.of("Linux", "Windows 11")) {
            CopilotRuntime.Lookup lookup = CopilotRuntime.find(env().os(os)
                    .path(onPath.getParent().toString()).build(), null);
            assertEquals(CopilotRuntime.Status.UNSUPPORTED, lookup.status(), os);
            assertNull(lookup.path(), os);
            assertFalse(CopilotRuntime.isSupportedPlatform(os), os);
        }
        assertTrue(CopilotRuntime.isSupportedPlatform(MAC));
    }

    // what the child gets

    @Test
    void theLaunchDropsTheTokenVariablesAndPutsTheRuntimeFolderFirst() throws IOException {
        Path brew = executable(tmp.resolve("brew/bin"));
        Map<String, String> parent = new HashMap<>();
        parent.put("COPILOT_GITHUB_TOKEN", "x");
        parent.put("GH_TOKEN", "y");
        parent.put("GITHUB_TOKEN", "z");
        parent.put("PATH", "/usr/bin:/bin");
        parent.put("LANG", "C");

        CopilotRuntime.Launch launch = CopilotRuntime.launch(brew, parent, tmp.resolve("home"));

        assertEquals(brew, launch.cliPath());
        for (String variable : CopilotRuntime.TOKEN_VARIABLES) {
            assertFalse(launch.environment().containsKey(variable), variable);
        }
        assertEquals("C", launch.environment().get("LANG"), "the rest of the environment stays");
        String path = launch.environment().get("PATH");
        assertTrue(path.startsWith(brew.getParent() + ":"), path);
        assertTrue(path.contains("/usr/bin"), path);
    }

    @Test
    void theVersionIsReadFromTheRuntime() throws IOException {
        Path runtime = script(tmp.resolve("v"), "echo 'GitHub Copilot CLI 9.8.7.'\necho \"Run 'copilot update'\"\n");

        Optional<String> version = CopilotRuntime.version(
                CopilotRuntime.launch(runtime, Map.of("PATH", "/usr/bin:/bin"), tmp), Duration.ofSeconds(5));

        assertEquals(Optional.of("9.8.7"), version);
    }

    @Test
    void aRuntimeThatHangsGivesNoVersionWithinTheTimeout() throws IOException {
        Path runtime = script(tmp.resolve("hang"), "sleep 30\n");

        long started = System.nanoTime();
        Optional<String> version = CopilotRuntime.version(
                CopilotRuntime.launch(runtime, Map.of("PATH", "/usr/bin:/bin"), tmp), Duration.ofSeconds(1));
        long ms = (System.nanoTime() - started) / 1_000_000;

        assertEquals(Optional.empty(), version);
        assertTrue(ms < 5_000, "took " + ms + " ms");
    }

    @Test
    void aRuntimeThatFailsGivesNoVersion() throws IOException {
        Path runtime = script(tmp.resolve("fail"), "echo 'GitHub Copilot CLI 1.2.3.'\nexit 3\n");

        assertEquals(Optional.empty(), CopilotRuntime.version(
                CopilotRuntime.launch(runtime, Map.of("PATH", "/usr/bin:/bin"), tmp), Duration.ofSeconds(5)));
    }

    // helpers

    private CopilotRuntime.Environment.Builder env() {
        return CopilotRuntime.Environment.builder()
                .os(MAC)
                .home(tmp.resolve("home"))
                .homebrewDirs(List.of())
                .path("");
    }

    private static Path executable(Path folder) throws IOException {
        return script(folder.resolve(CopilotRuntime.EXECUTABLE), "exit 0\n");
    }

    private static Path script(Path file, String body) throws IOException {
        Files.createDirectories(file.getParent());
        Files.writeString(file, "#!/bin/sh\n" + body);
        makeExecutable(file);
        return file;
    }

    private static void makeExecutable(Path file) throws IOException {
        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rwxr-xr-x"));
    }
}
