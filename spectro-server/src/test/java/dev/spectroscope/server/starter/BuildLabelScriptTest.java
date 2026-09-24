package dev.spectroscope.server.starter;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The rule that decides what a desktop build says it is (card 398), run as the
 * shell script the build calls: {@code scripts/build-label.sh}.
 *
 * <p>A test build prints {@code <next minor>.0-beta (<branch or detached>,
 * <short commit>, <dd.MM. HH:mm>)}. A release build prints nothing: HEAD
 * carries the tag {@code v<tree version>}, or {@code SPECTRO_RELEASE=1} is set.
 * Each case copies the real script into a fresh folder, most of them a git
 * repository. Without a label for another reason (no git, no checkout git can
 * read) the script says so and never calls the build a release.
 */
class BuildLabelScriptTest {

    private static final Pattern LABEL = Pattern.compile(
            "^(\\d+\\.\\d+\\.\\d+)-beta \\((.+), ([0-9a-f]{7,}), (\\d{2}\\.\\d{2}\\. \\d{2}:\\d{2})\\)$");
    private static final DateTimeFormatter WHEN = DateTimeFormatter.ofPattern("dd.MM. HH:mm");

    @BeforeAll
    static void tools() {
        assumeTrue(ScriptTree.toolsPresent(), "bash and git are needed to run the build scripts");
    }

    private static ScriptTree tree(Path dir, String version) throws Exception {
        return ScriptTree.of(dir, version, "build-label.sh");
    }

    /** Runs the script, checks it exited 0, and returns its stdout without the newline. */
    private static String label(ScriptTree tree, Map<String, String> env) throws Exception {
        ScriptTree.Run run = tree.script("build-label.sh", env);
        assertEquals(0, run.exit(), run.both());
        return run.stdout().strip();
    }

    @Test
    void aBranchBuildIsLabelledWithTheNextMinorTheBranchTheCommitAndTheTime(@TempDir Path dir)
            throws Exception {
        ScriptTree tree = tree(dir, "0.12.0").commitOn("merge-2026-09-24");
        String before = LocalDateTime.now().format(WHEN);
        String label = label(tree, Map.of());
        String after = LocalDateTime.now().format(WHEN);

        Matcher m = LABEL.matcher(label);
        assertTrue(m.matches(), "not the label format: '" + label + "'");
        assertEquals("0.13.0", m.group(1));
        assertEquals("merge-2026-09-24", m.group(2));
        assertEquals(tree.git("rev-parse", "--short", "HEAD"), m.group(3));
        assertTrue(m.group(4).equals(before) || m.group(4).equals(after),
                "the build time must be the local time of the build, got " + m.group(4)
                        + " between " + before + " and " + after);
    }

    @Test
    void theNextMinorIsDerivedFromTheTreeVersion(@TempDir Path dir) throws Exception {
        for (String[] pair : new String[][] {
                {"0.12.0", "0.13.0"}, {"0.12.3", "0.13.0"}, {"1.9.0", "1.10.0"}, {"0.9.12", "0.10.0"}}) {
            Path one = dir.resolve(pair[0]);
            ScriptTree tree = tree(one, pair[0]).commitOn("main");
            Matcher m = LABEL.matcher(label(tree, Map.of()));
            assertTrue(m.matches(), pair[0]);
            assertEquals(pair[1], m.group(1), "the beta after " + pair[0]);
        }
    }

    @Test
    void aDetachedHeadSaysDetached(@TempDir Path dir) throws Exception {
        ScriptTree tree = tree(dir, "0.12.0").commitOn("main").commit("second");
        tree.git("checkout", "-q", "--detach", "HEAD~1");
        Matcher m = LABEL.matcher(label(tree, Map.of()));
        assertTrue(m.matches());
        assertEquals("detached", m.group(2));
        assertEquals(tree.git("rev-parse", "--short", "HEAD"), m.group(3));
    }

    @Test
    void aBuildFromTheReleaseTagCarriesNoLabel(@TempDir Path dir) throws Exception {
        ScriptTree tree = tree(dir, "0.12.0").commitOn("release/v0.12.0");
        tree.git("tag", "-a", "v0.12.0", "-m", "spectroscope v0.12.0");
        tree.git("checkout", "-q", "v0.12.0");
        ScriptTree.Run run = tree.script("build-label.sh", Map.of());
        assertEquals(0, run.exit(), run.both());
        assertEquals("", run.stdout(), "a release build prints no label");
        assertTrue(run.stderr().contains("v0.12.0"), "and says why:\n" + run.stderr());
    }

    @Test
    void aLightweightReleaseTagCountsAsWell(@TempDir Path dir) throws Exception {
        ScriptTree tree = tree(dir, "0.12.0").commitOn("main");
        tree.git("tag", "v0.12.0");
        assertEquals("", label(tree, Map.of()));
    }

    @Test
    void aReleaseTagOnAnEarlierCommitDoesNotMakeALaterBuildARelease(@TempDir Path dir) throws Exception {
        ScriptTree tree = tree(dir, "0.12.0").commitOn("main");
        tree.git("tag", "-a", "v0.12.0", "-m", "spectroscope v0.12.0");
        tree.commit("after the cut");
        assertTrue(LABEL.matcher(label(tree, Map.of())).matches());
    }

    @Test
    void onlyTheTagOfTheTreeVersionIsARelease(@TempDir Path dir) throws Exception {
        // A tag that is not v<tree version> on HEAD: a pre-release name, another
        // version, a merge marker. None of them is the release the tree declares.
        for (String tag : new String[] {"v0.12.0-rc1", "v0.11.0", "merge-2026-09-24", "0.12.0"}) {
            ScriptTree tree = tree(dir.resolve(tag), "0.12.0").commitOn("main");
            tree.git("tag", tag);
            assertTrue(LABEL.matcher(label(tree, Map.of())).matches(), "tag " + tag + " made a release");
        }
    }

    @Test
    void theReleaseEnvironmentCarriesNoLabel(@TempDir Path dir) throws Exception {
        ScriptTree tree = tree(dir, "0.12.0").commitOn("main");
        ScriptTree.Run run = tree.script("build-label.sh", Map.of("SPECTRO_RELEASE", "1"));
        assertEquals(0, run.exit(), run.both());
        assertEquals("", run.stdout());
        assertTrue(run.stderr().contains("SPECTRO_RELEASE"), run.stderr());
    }

    @Test
    void onlySpectroReleaseOneMarksARelease(@TempDir Path dir) throws Exception {
        ScriptTree tree = tree(dir, "0.12.0").commitOn("main");
        for (String value : new String[] {"0", "", "yes", "true"}) {
            assertTrue(LABEL.matcher(label(tree, Map.of("SPECTRO_RELEASE", value))).matches(),
                    "SPECTRO_RELEASE=" + value + " made a release");
        }
    }

    @Test
    void aTreeVersionThatIsNotPlainIsRefused(@TempDir Path dir) throws Exception {
        ScriptTree tree = tree(dir, "0.13.0-beta").commitOn("main");
        ScriptTree.Run run = tree.script("build-label.sh", Map.of());
        assertNotEquals(0, run.exit(), run.both());
        assertEquals("", run.stdout());
        assertTrue(run.stderr().contains("0.13.0-beta"), run.stderr());
    }

    @Test
    void outsideAGitCheckoutTheBuildCarriesNoLabelAndSaysWhy(@TempDir Path dir) throws Exception {
        ScriptTree tree = tree(dir, "0.12.0");
        ScriptTree.Run run = tree.script("build-label.sh", Map.of());
        assertEquals(0, run.exit(), run.both());
        assertEquals("", run.stdout());
        assertTrue(run.stderr().contains("git cannot read a checkout here"), run.stderr());
        assertFalse(run.stderr().contains("release"), "no label is not a release:\n" + run.stderr());
    }

    @Test
    void whereGitCannotReadTheCheckoutItPassesOnGitsOwnReason(@TempDir Path dir) throws Exception {
        // A .git file that is not a gitfile: git refuses the folder and says why.
        // A safe.directory refusal takes the same path; it needs a folder owned
        // by another user, which a test cannot make.
        ScriptTree tree = tree(dir, "0.12.0");
        Files.writeString(tree.dir.resolve(".git"), "not a gitfile\n");
        ScriptTree.Run run = tree.script("build-label.sh", Map.of("LC_ALL", "C"));
        assertEquals(0, run.exit(), run.both());
        assertEquals("", run.stdout());
        assertTrue(run.stderr().contains("git cannot read a checkout here"), run.stderr());
        assertTrue(run.stderr().contains("invalid gitfile format"), "git's own reason:\n" + run.stderr());
        assertFalse(run.stderr().contains("release"), run.stderr());
    }

    @Test
    void withoutGitOnThePathTheBuildCarriesNoLabelAndSaysGitIsMissing(@TempDir Path dir) throws Exception {
        ScriptTree tree = tree(dir.resolve("tree"), "0.12.0").commitOn("main");
        Path bin = pathWithout("git", dir.resolve("bin"), "bash", "sed", "head", "grep", "date", "dirname");
        String bash = bin.resolve("bash").toString();
        ScriptTree.Run probe = tree.run(List.of(bash, "-c", "command -v git"), Map.of("PATH", bin.toString()));
        assertNotEquals(0, probe.exit(), "git must be out of reach for this case:\n" + probe.both());

        ScriptTree.Run run = tree.run(List.of(bash, "scripts/build-label.sh"), Map.of("PATH", bin.toString()));
        assertEquals(0, run.exit(), run.both());
        assertEquals("", run.stdout());
        assertTrue(run.stderr().contains("git not found on the PATH"), run.stderr());
        assertFalse(run.stderr().contains("checkout"), "the checkout is fine, git is missing:\n" + run.stderr());
        assertFalse(run.stderr().contains("release"), run.stderr());
    }

    /**
     * A folder of symlinks to the named tools, found on this JVM's PATH, and
     * nothing else, so {@code missing} is not on a PATH made of it.
     */
    private static Path pathWithout(String missing, Path bin, String... tools) throws Exception {
        Files.createDirectories(bin);
        for (String tool : tools) {
            assertNotEquals(missing, tool);
            Path found = null;
            for (String entry : System.getenv("PATH").split(java.io.File.pathSeparator)) {
                Path candidate = Path.of(entry, tool);
                if (!entry.isEmpty() && Files.isRegularFile(candidate) && Files.isExecutable(candidate)) {
                    found = candidate;
                    break;
                }
            }
            assumeTrue(found != null, tool + " is not on the PATH");
            Files.createSymbolicLink(bin.resolve(tool), found);
        }
        return bin;
    }
}
