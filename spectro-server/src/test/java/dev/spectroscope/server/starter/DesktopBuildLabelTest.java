package dev.spectroscope.server.starter;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 398, the desktop build end of the label: {@code build-desktop-runkit.sh}
 * asks {@code build-label.sh} for the label, hands it to Gradle as
 * {@code -Pspectro.buildLabel}, and {@code verify-build-label.sh} reads it back
 * out of the staged jar before anything is packaged. The jar name, and with it
 * everything named after {@code VERSION}, stays on the plain version.
 *
 * <p>The desktop script runs for real in a throwaway git repository. Gradle is a
 * stub that records its arguments and writes a jar with the stamp entry, and
 * {@code jlink} is a stub that stops the run at step 2, so a case finishes in
 * seconds. {@code build-release-assets.sh} is checked the same way for the
 * release signal it gives the desktop build.
 */
class DesktopBuildLabelTest {

    private static final String ENTRY = "BOOT-INF/classes/starter/spectro-version.properties";
    private static final String STALE = "0.13.0-beta (main, 1234567, 01.01. 00:00)";

    @BeforeAll
    static void tools() {
        assumeTrue(ScriptTree.toolsPresent(), "bash and git are needed to run the build scripts");
        assumeTrue(present("python3", "--version") && present("unzip", "-v"),
                "python3 and unzip are needed by the stubs and the read-back");
    }

    private static boolean present(String... command) {
        try {
            Process p = new ProcessBuilder(command).redirectErrorStream(true).start();
            p.getInputStream().readAllBytes();
            return p.waitFor(20, TimeUnit.SECONDS) && p.exitValue() == 0;
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /**
     * A stub gradlew: records every argument on its own line in gradlew-args.txt
     * and writes spectro-server/build/libs/spectro-server-0.12.0.jar with the
     * stamp entry. {@code mode} decides the label line it writes: "honest" takes
     * the -Pspectro.buildLabel it was given, "stale" writes an old label,
     * "unlabelled" writes none.
     */
    private static String gradlew(String mode) {
        return """
                #!/usr/bin/env bash
                : > gradlew-args.txt
                GIVEN=""
                for a in "$@"; do
                  printf '%s\\n' "$a" >> gradlew-args.txt
                  case "$a" in -Pspectro.buildLabel=*) GIVEN="${a#-Pspectro.buildLabel=}" ;; esac
                done
                case "MODE" in
                  honest)     LABEL="$GIVEN" ;;
                  stale)      LABEL="STALE" ;;
                  unlabelled) LABEL="" ;;
                esac
                mkdir -p spectro-server/build/libs
                LABEL="$LABEL" python3 - <<'PY'
                import os, zipfile
                label = os.environ["LABEL"]
                body = "version=0.12.0\\n" + (("label=" + label) if label else "") + "\\n"
                with zipfile.ZipFile("spectro-server/build/libs/spectro-server-0.12.0.jar", "w") as z:
                    z.writestr("ENTRY", body.encode("utf-8"))
                PY
                """.replace("MODE", mode).replace("STALE", STALE).replace("ENTRY", ENTRY);
    }

    private static ScriptTree desktopTree(Path dir, String mode) throws Exception {
        return ScriptTree.of(dir, "0.12.0",
                        "build-desktop-runkit.sh", "build-label.sh", "verify-build-label.sh")
                .executable("gradlew", gradlew(mode))
                .executable("scripts/verify-staged-server-jar.sh", "#!/usr/bin/env bash\nexit 0\n")
                .executable("stub/jlink", "#!/usr/bin/env bash\necho 'stub jlink: stop'\nexit 42\n");
    }

    private static ScriptTree.Run desktop(ScriptTree tree) throws Exception {
        String path = tree.dir.resolve("stub") + ":" + System.getenv("PATH");
        return tree.script("build-desktop-runkit.sh", Map.of(
                "PATH", path,
                // skips the keychain lookup, which a CI runner does not have
                "SIGN_IDENTITY", "Developer ID Application: test (TESTTEAM)"));
    }

    private static List<String> gradleArgs(ScriptTree tree) throws IOException {
        return Files.readAllLines(tree.dir.resolve("gradlew-args.txt"), StandardCharsets.UTF_8);
    }

    private static String labelArg(ScriptTree tree) throws IOException {
        List<String> label = gradleArgs(tree).stream()
                .filter(a -> a.startsWith("-Pspectro.buildLabel=")).toList();
        assertEquals(1, label.size(), "exactly one label argument: " + gradleArgs(tree));
        return label.get(0).substring("-Pspectro.buildLabel=".length());
    }

    @Test
    void aTestBuildHandsTheLabelToGradleAndReadsItBackOutOfTheStagedJar(@TempDir Path dir)
            throws Exception {
        ScriptTree tree = desktopTree(dir, "honest").commitOn("merge-2026-09-24");
        ScriptTree.Run run = desktop(tree);
        String out = run.both();

        String label = labelArg(tree);
        assertTrue(label.startsWith("0.13.0-beta (merge-2026-09-24, "
                + tree.git("rev-parse", "--short", "HEAD") + ", "), "the label Gradle got: " + label);
        assertTrue(gradleArgs(tree).contains(":spectro-server:bootJar"), gradleArgs(tree).toString());
        assertTrue(out.contains("==> test build: " + label), out);
        assertTrue(out.contains("the staged jar carries the label " + label), out);
        assertTrue(out.contains("[2/7] jlink JRE"), "the run must get past the read-back:\n" + out);
    }

    @Test
    void theLabelNeverBecomesTheVersionTheJarAndTheDmgAreNamedAfter(@TempDir Path dir) throws Exception {
        ScriptTree tree = desktopTree(dir, "honest").commitOn("main");
        ScriptTree.Run run = desktop(tree);
        String out = run.both();
        assertTrue(out.contains("==> desktop run kit for spectro-server 0.12.0 "), out);
        // The stub writes only spectro-server-0.12.0.jar; the script found it and staged it.
        assertTrue(Files.isRegularFile(tree.dir.resolve("spectro-desktop/build/spectro-server.jar")), out);
        assertFalse(out.contains("server jar not found"), out);

        String script = Files.readString(tree.dir.resolve("scripts/build-desktop-runkit.sh"));
        assertEquals(1, script.lines().filter(l -> l.matches("^\\s*VERSION=.*")).count(),
                "VERSION is assigned once, from the build file");
        assertTrue(script.contains("DMG=\"$D/release/spectroscope-${VERSION}-${ARCH}.dmg\""),
                "the DMG is named after the plain version");
        assertTrue(script.contains("JAR=\"spectro-server/build/libs/spectro-server-${VERSION}.jar\""),
                "the jar is looked up by the plain version");
    }

    @Test
    void aReleaseBuildTellsGradleExplicitlyThatThereIsNoLabel(@TempDir Path dir) throws Exception {
        ScriptTree tree = desktopTree(dir, "honest").commitOn("main");
        tree.git("tag", "-a", "v0.12.0", "-m", "spectroscope v0.12.0");
        tree.git("checkout", "-q", "v0.12.0");
        ScriptTree.Run run = desktop(tree);
        String out = run.both();

        assertEquals("", labelArg(tree), "an empty property overrides one set in a gradle.properties");
        assertTrue(out.contains("==> no build label (reason above)"), out);
        assertTrue(out.contains("HEAD is tag v0.12.0"), "build-label.sh gives the reason:\n" + out);
        assertTrue(out.contains("the staged jar carries no label, as expected"), out);
        assertTrue(out.contains("[2/7] jlink JRE"), out);
    }

    @Test
    void aBuildWithoutACheckoutHasNoLabelAndIsNeverCalledARelease(@TempDir Path dir) throws Exception {
        // No git init: build-label.sh finds no checkout, and the build log must
        // not read like a release build.
        ScriptTree tree = desktopTree(dir, "honest");
        ScriptTree.Run run = desktop(tree);
        String out = run.both();

        assertEquals("", labelArg(tree));
        assertTrue(out.contains("==> no build label (reason above)"), out);
        assertTrue(out.contains("git cannot read a checkout here"), out);
        assertTrue(out.contains("the staged jar carries no label, as expected"), out);
        assertTrue(out.contains("[2/7] jlink JRE"), out);
        assertFalse(out.toLowerCase(java.util.Locale.ROOT).contains("release build"), out);
    }

    @Test
    void aStaleJarIsRefusedBeforeAnythingIsPackaged(@TempDir Path dir) throws Exception {
        ScriptTree tree = desktopTree(dir, "stale").commitOn("main");
        ScriptTree.Run run = desktop(tree);
        String out = run.both();
        assertNotEquals(0, run.exit(), out);
        assertTrue(out.contains(STALE), "the refusal names what the jar carries:\n" + out);
        assertFalse(out.contains("[2/7]"), "nothing after the read-back may run:\n" + out);
    }

    @Test
    void aJarWithoutTheLabelIsRefusedOnATestBuild(@TempDir Path dir) throws Exception {
        ScriptTree tree = desktopTree(dir, "unlabelled").commitOn("main");
        ScriptTree.Run run = desktop(tree);
        assertNotEquals(0, run.exit(), run.both());
        assertFalse(run.both().contains("[2/7]"), run.both());
    }

    @Test
    void aLabelledJarIsRefusedOnAReleaseBuild(@TempDir Path dir) throws Exception {
        ScriptTree tree = desktopTree(dir, "stale").commitOn("main");
        tree.git("tag", "v0.12.0");
        ScriptTree.Run run = desktop(tree);
        String out = run.both();
        assertNotEquals(0, run.exit(), out);
        assertTrue(out.contains("this build computed no label, but the staged jar carries the label '"
                + STALE + "'"), out);
        assertFalse(out.contains("[2/7]"), out);
    }

    // ---- verify-build-label.sh against jars written by java.util.jar ----------

    private static Path jar(Path dir, String stamp) throws IOException {
        Path jar = dir.resolve("server.jar");
        try (OutputStream file = Files.newOutputStream(jar); JarOutputStream out = new JarOutputStream(file)) {
            out.putNextEntry(new JarEntry("BOOT-INF/classes/static/index.html"));
            out.write("<html></html>".getBytes(StandardCharsets.UTF_8));
            out.closeEntry();
            if (stamp != null) {
                out.putNextEntry(new JarEntry(ENTRY));
                out.write(stamp.getBytes(StandardCharsets.UTF_8));
                out.closeEntry();
            }
        }
        return jar;
    }

    private static ScriptTree.Run verify(Path dir, Path jar, String expected) throws Exception {
        ScriptTree tree = ScriptTree.of(dir.resolve("tree"), "0.12.0", "verify-build-label.sh");
        return tree.run(List.of("bash", "scripts/verify-build-label.sh", jar.toString(), expected), Map.of());
    }

    @Test
    void theReadBackFindsTheLabelInsideAJar(@TempDir Path dir) throws Exception {
        String label = "0.13.0-beta (karte-398-überblick, a1b2c3d, 24.09. 14:05)";
        Path jar = jar(dir, "# stamped\nversion=0.12.0\nlabel=" + label + "\n");
        ScriptTree.Run run = verify(dir, jar, label);
        assertEquals(0, run.exit(), run.both());
        assertTrue(run.both().contains(label), run.both());
    }

    @Test
    void theReadBackRefusesAnotherLabel(@TempDir Path dir) throws Exception {
        Path jar = jar(dir, "version=0.12.0\nlabel=" + STALE + "\n");
        ScriptTree.Run run = verify(dir, jar, "0.13.0-beta (main, 7654321, 24.09. 14:05)");
        assertNotEquals(0, run.exit(), run.both());
        assertTrue(run.both().contains(STALE) && run.both().contains("7654321"), run.both());
    }

    @Test
    void theReadBackAcceptsAJarWithoutALabelWhenNoneIsExpected(@TempDir Path dir) throws Exception {
        ScriptTree.Run run = verify(dir, jar(dir, "version=0.12.0\n\n"), "");
        assertEquals(0, run.exit(), run.both());
        assertTrue(run.both().contains("the staged jar carries no label, as expected"), run.both());
        assertFalse(run.both().contains("release"), "the read-back cannot know why there is no label:\n"
                + run.both());
    }

    @Test
    void theReadBackRefusesAJarWithoutAStamp(@TempDir Path dir) throws Exception {
        ScriptTree.Run run = verify(dir, jar(dir, null), "");
        assertNotEquals(0, run.exit(), run.both());
        assertTrue(run.both().contains("spectro-version.properties"), run.both());
    }

    // ---- build-release-assets.sh gives its desktop build the release signal ---

    @Test
    void theReleaseAssetsScriptMarksItsDesktopBuildAsARelease(@TempDir Path dir) throws Exception {
        ScriptTree tree = ScriptTree.of(dir, "0.12.0", "build-release-assets.sh")
                .executable("stub/npm", "#!/usr/bin/env bash\nexit 0\n")
                .executable("gradlew", """
                        #!/usr/bin/env bash
                        printf '%s\\n' "$@" > gradlew-args.txt
                        mkdir -p spectro-cli/build/distributions spectro-server/build/libs spectro-mcp-notes/build/distributions
                        echo cli    > spectro-cli/build/distributions/spectro-0.12.0.zip
                        echo server > spectro-server/build/libs/spectro-server-0.12.0.jar
                        echo notes  > spectro-mcp-notes/build/distributions/spectro-mcp-notes-0.12.0.zip
                        """)
                .executable("scripts/build-desktop-runkit.sh", """
                        #!/usr/bin/env bash
                        printf '%s' "${SPECTRO_RELEASE:-unset}" > desktop-release-signal.txt
                        mkdir -p spectro-desktop/release
                        echo dmg > "spectro-desktop/release/spectroscope-0.12.0-$(uname -m | sed 's/x86_64/x64/').dmg"
                        """);
        Files.createDirectories(tree.dir.resolve("spectro-web"));
        String path = tree.dir.resolve("stub") + ":" + System.getenv("PATH");
        ScriptTree.Run run = tree.script("build-release-assets.sh", Map.of("PATH", path));

        assertEquals(0, run.exit(), run.both());
        assertEquals("1", Files.readString(tree.dir.resolve("desktop-release-signal.txt")),
                "the desktop build of a release must know it is one");
        assertTrue(Files.readAllLines(tree.dir.resolve("gradlew-args.txt")).contains("-Pspectro.buildLabel="),
                "the standalone server jar of a release is stamped without a label, explicitly");
    }
}
