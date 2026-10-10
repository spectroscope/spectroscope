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
import static org.junit.jupiter.api.Assertions.assertThrows;
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
        Path brew = caskInstall(tmp.resolve("brew"));
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
    void aTildePrefixInNpmrcIsExpandedAgainstTheHomeFolder() throws IOException {
        // prefix=~/.npm-global is the form npm's own docs suggest for a user prefix
        Path home = Files.createDirectories(tmp.resolve("home"));
        Path npm = executable(home.resolve(".npm-global/bin"));
        Path npmrc = home.resolve(".npmrc");
        Files.writeString(npmrc, "prefix=~/.npm-global\n");

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env().npmrc(npmrc).build(), null);

        assertEquals(npm, lookup.path(), lookup.toString());
        assertEquals(CopilotRuntime.Source.NPM_GLOBAL, lookup.source());
    }

    @Test
    void aPlainFileInAHomebrewFolderIsNotCalledHomebrew() throws IOException {
        // the install script run as root also writes /usr/local/bin/copilot
        Path plain = executable(tmp.resolve("usrlocal/bin"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env().homebrew(plain.getParent()).build(), null);

        assertEquals(plain, lookup.path(), lookup.toString());
        assertEquals(CopilotRuntime.Source.STANDALONE, lookup.source());
        assertTrue(lookup.detail().endsWith("(standalone file)"), lookup.detail());
    }

    @Test
    void aLinkIntoTheHomebrewCaskroomIsCalledHomebrew() throws IOException {
        Path brew = caskInstall(tmp.resolve("brew"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env().homebrew(brew.getParent()).build(), null);

        assertEquals(brew, lookup.path(), lookup.toString());
        assertEquals(CopilotRuntime.Source.HOMEBREW, lookup.source());
        assertTrue(lookup.detail().endsWith("(Homebrew)"), lookup.detail());
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
    void aRuntimeFoundOnlyInsideTheWorkspaceIsRejectedAndNamed() throws IOException {
        Path workspace = Files.createDirectories(tmp.resolve("workspace"));
        Path planted = executable(workspace.resolve("node_modules/.bin"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .path(planted.getParent().toString()).build(), workspace);

        assertEquals(CopilotRuntime.Status.REJECTED, lookup.status(), lookup.toString());
        assertNull(lookup.path(), "the planted runtime is never handed out");
        assertTrue(lookup.detail().contains(planted.toString()), "the skip is named: " + lookup.detail());
        assertTrue(lookup.detail().contains("inside the workspace folder"), lookup.detail());
    }

    @Test
    void aWorkspaceThatIsTheHomeFolderStillFencesAPerUserInstall() throws IOException {
        // Final round, decision 4: the home folder is fenced like any other
        // workspace. ~/.local/bin is not an install root, so a runtime there
        // is named and refused, and COPILOT_CLI_PATH is the way to take it.
        Path home = Files.createDirectories(tmp.resolve("home"));
        Path script = executable(home.resolve(".local/bin"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env().build(), home);

        assertEquals(CopilotRuntime.Status.REJECTED, lookup.status(), lookup.toString());
        assertNull(lookup.path());
        assertTrue(lookup.detail().contains(script.toString()), lookup.detail());
    }

    @Test
    void aWorkspaceAboveTheHomeFolderFencesAnNpmPrefixThatIsNotAnInstallRoot() throws IOException {
        Path home = Files.createDirectories(tmp.resolve("home"));
        executable(home.resolve(".npm-global/bin"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .npmConfigPrefix(home.resolve(".npm-global").toString()).build(), tmp);

        assertEquals(CopilotRuntime.Status.REJECTED, lookup.status(), lookup.toString());
    }

    @Test
    void theNpmGlobalPrefixIsAnInstallRootTheFenceLetsThrough() throws IOException {
        Path home = Files.createDirectories(tmp.resolve("home"));
        Path npm = executable(home.resolve(".npm-global/bin"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .npmConfigPrefix(home.resolve(".npm-global").toString())
                .installRoot(home.resolve(".npm-global")).build(), home);

        assertEquals(CopilotRuntime.Status.FOUND, lookup.status(), lookup.toString());
        assertEquals(npm, lookup.path());
        assertEquals(CopilotRuntime.Source.NPM_GLOBAL, lookup.source());
    }

    @Test
    void theHomebrewPrefixIsAnInstallRootTheFenceLetsThrough() throws IOException {
        Path brew = caskInstall(tmp.resolve("brew"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .homebrew(brew.getParent()).installRoot(tmp.resolve("brew")).build(), tmp);

        assertEquals(CopilotRuntime.Status.FOUND, lookup.status(), lookup.toString());
        assertEquals(brew, lookup.path());
        assertEquals(CopilotRuntime.Source.HOMEBREW, lookup.source());
    }

    @Test
    void anInstallRootCoversItsOwnFolderAndNotASiblingThatSharesItsName() throws IOException {
        // The root exists, so it resolves like the planted file does; a root that
        // does not resolve could not match anything and would make this test blind.
        Files.createDirectories(tmp.resolve("brew"));
        Path planted = executable(tmp.resolve("brewx/bin"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .path(planted.getParent().toString()).installRoot(tmp.resolve("brew")).build(), tmp);

        assertEquals(CopilotRuntime.Status.REJECTED, lookup.status(), lookup.toString());
    }

    @Test
    void aLinkInAnInstallRootThatPointsOutOfItIntoTheWorkspaceIsStillFenced() throws IOException {
        Path workspace = Files.createDirectories(tmp.resolve("workspace"));
        Path planted = executable(workspace.resolve("tools"));
        Path root = Files.createDirectories(workspace.resolve("brew"));
        Path bin = Files.createDirectories(root.resolve("bin"));
        Files.createSymbolicLink(bin.resolve("copilot"), planted);

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .homebrew(bin).installRoot(root).build(), workspace);

        assertEquals(CopilotRuntime.Status.REJECTED, lookup.status(), lookup.toString());
    }

    @Test
    void theInstallRootsAreTheFixedHomebrewPrefixesAndWhatBrewAndNpmName() {
        Map<String, Optional<String>> answers = Map.of(
                "brew --prefix", Optional.of("/opt/homebrew\n"),
                "npm prefix -g", Optional.of("  /Users/someone/.npm-global  \n"));

        List<String> roots = CopilotRuntime.installRoots(command -> answers.get(String.join(" ", command)));

        assertEquals(List.of("/opt/homebrew", "/usr/local", "/Users/someone/.npm-global"), roots);
    }

    @Test
    void theLookupOfThisProcessCarriesTheInstallRoots() {
        assertTrue(CopilotRuntime.Environment.current().installRoots().containsAll(CopilotRuntime.HOMEBREW_PREFIXES),
                CopilotRuntime.Environment.current().installRoots().toString());
    }

    @Test
    void anInstallRootCommandThatFailsOrPrintsNoAbsolutePathAddsNothing() {
        List<String> roots = CopilotRuntime.installRoots(command ->
                command.get(0).endsWith("brew") ? Optional.empty() : Optional.of("prefix not set"));

        assertEquals(List.of("/opt/homebrew", "/usr/local"), roots);
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
    void copilotCliPathIsAnInstallRootEvenInsideTheWorkspace() throws IOException {
        // Final round, decision 4: the variable is the user's own choice and is on the allowlist.
        Path workspace = Files.createDirectories(tmp.resolve("workspace"));
        Path chosen = executable(workspace.resolve("bin"));

        CopilotRuntime.Lookup lookup = CopilotRuntime.find(env()
                .copilotCliPath(chosen.toString()).build(), workspace);

        assertEquals(CopilotRuntime.Status.FOUND, lookup.status(), lookup.toString());
        assertEquals(chosen, lookup.path());
        assertEquals(CopilotRuntime.Source.COPILOT_CLI_PATH, lookup.source());
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

    // what the provider is handed

    @Test
    void theProviderGetsThePathOrAnErrorThatCarriesTheInstallLine() throws IOException {
        Path onPath = executable(tmp.resolve("onpath"));
        CopilotRuntime.Lookup found = CopilotRuntime.find(env().path(onPath.getParent().toString()).build(), null);
        assertEquals(onPath.toString(), found.requirePath());

        CopilotRuntime.Lookup missing = CopilotRuntime.find(env().build(), null);
        IllegalStateException notInstalled = assertThrows(IllegalStateException.class, missing::requirePath);
        assertEquals("copilot runtime: not installed. Install it with: " + CopilotRuntime.INSTALL_LINE,
                notInstalled.getMessage());

        CopilotRuntime.Lookup linux = CopilotRuntime.find(env().os("Linux").build(), null);
        IllegalStateException unsupported = assertThrows(IllegalStateException.class, linux::requirePath);
        assertEquals("copilot runtime: not supported on this platform (macOS only)", unsupported.getMessage());
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

    /** A Homebrew cask install: {@code <prefix>/bin/copilot} links into the Caskroom. */
    private static Path caskInstall(Path prefix) throws IOException {
        Path binary = script(prefix.resolve("Caskroom/copilot-cli/1.0.94/copilot"), "exit 0\n");
        Path bin = Files.createDirectories(prefix.resolve("bin"));
        return Files.createSymbolicLink(bin.resolve(CopilotRuntime.EXECUTABLE), binary);
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
