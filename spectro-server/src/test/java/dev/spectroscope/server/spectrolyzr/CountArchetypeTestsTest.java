package dev.spectroscope.server.spectrolyzr;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * {@code scripts/count_archetype_tests.py} is the CI step that refuses a build
 * which ran no test. Each language reads its count where that language leaves
 * it: Java in the JUnit XML, Python in the {@code Ran N tests} line, TypeScript
 * in the TAP {@code # tests N} line recorded in the card for task 3.
 */
class CountArchetypeTestsTest {

    private record Outcome(int exit, String text) {}

    private static Path script;

    @BeforeAll
    static void findTheScript() throws IOException {
        Path root = Path.of("").toAbsolutePath();
        while (root != null && !Files.isRegularFile(root.resolve("settings.gradle.kts"))) {
            root = root.getParent();
        }
        assumeTrue(root != null, "not running from a source checkout");
        script = root.resolve("scripts/count_archetype_tests.py");
        assertTrue(Files.isRegularFile(script), "scripts/count_archetype_tests.py is missing");
        try {
            Process p = new ProcessBuilder("python3", "--version").redirectErrorStream(true)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
            assumeTrue(p.waitFor(30, TimeUnit.SECONDS) && p.exitValue() == 0, "python3 did not answer");
        } catch (IOException | InterruptedException missing) {
            assumeTrue(false, "python3 is not on this machine");
        }
    }

    private static Outcome count(Path tmp, Path summary, String... args) throws Exception {
        java.util.List<String> command = new java.util.ArrayList<>(java.util.List.of("python3", script.toString()));
        command.addAll(java.util.List.of(args));
        Path log = Files.createTempFile(tmp, "count", ".log");
        ProcessBuilder pb = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(log.toFile());
        pb.environment().remove("GITHUB_STEP_SUMMARY");
        if (summary != null) {
            pb.environment().put("GITHUB_STEP_SUMMARY", summary.toString());
        }
        Process p = pb.start();
        assertTrue(p.waitFor(60, TimeUnit.SECONDS), "the counter did not finish");
        return new Outcome(p.exitValue(), Files.readString(log));
    }

    private static Path project(Path root, String variant) throws IOException {
        Path project = root.resolve(variant).resolve("project");
        Files.createDirectories(project);
        return project;
    }

    private static void junitXml(Path project, String name, int tests) throws IOException {
        Path dir = project.resolve("build/test-results/test");
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("TEST-" + name + ".xml"),
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuite name=\"" + name + "\" tests=\"" + tests
                        + "\" skipped=\"0\" failures=\"0\" errors=\"0\"></testsuite>\n");
    }

    @Test
    void aPythonOutputWithThreeTestsPassesAndAZeroOutputFails(@TempDir Path tmp) throws Exception {
        Path ok = project(tmp, "service-bare");
        Files.writeString(ok.resolve("check.log"), "test_a ... ok\n\nRan 3 tests in 0.002s\n\nOK\n");
        Outcome pass = count(tmp, null, "python", tmp.toString());
        assertEquals(0, pass.exit(), pass.text());
        assertTrue(pass.text().contains(ok + ": 3 tests"), pass.text());

        Files.writeString(ok.resolve("check.log"), "Ran 0 tests in 0.000s\n\nNO TESTS RAN\n");
        Outcome zero = count(tmp, null, "python", tmp.toString());
        assertEquals(1, zero.exit(), zero.text());
        assertTrue(zero.text().contains(ok + ": 0 tests"), zero.text());
    }

    @Test
    void aSingularRanOneTestLineCountsAsOne(@TempDir Path tmp) throws Exception {
        Path ok = project(tmp, "cli-bare");
        Files.writeString(ok.resolve("check.log"), "Ran 1 test in 0.001s\n\nOK\n");
        Outcome pass = count(tmp, null, "python", tmp.toString());
        assertEquals(0, pass.exit(), pass.text());
        assertTrue(pass.text().contains(": 1 tests"), pass.text());
    }

    @Test
    void aJavaFolderSumsTheTestsOfEveryXmlAndNoXmlFails(@TempDir Path tmp) throws Exception {
        Path ok = project(tmp, "library-bare");
        junitXml(ok, "a.AlphaTest", 2);
        junitXml(ok, "a.BetaTest", 1);
        Outcome pass = count(tmp, null, "java", tmp.toString());
        assertEquals(0, pass.exit(), pass.text());
        assertTrue(pass.text().contains(ok + ": 3 tests"), pass.text());

        Path none = project(tmp, "library-full");
        Outcome fail = count(tmp, null, "java", tmp.toString());
        assertEquals(1, fail.exit(), fail.text());
        assertTrue(fail.text().contains(none + ": 0 tests"), fail.text());
    }

    @Test
    void aJavaFolderWhoseXmlReportsZeroTestsFails(@TempDir Path tmp) throws Exception {
        Path zero = project(tmp, "cli-bare");
        junitXml(zero, "a.EmptyTest", 0);
        Outcome fail = count(tmp, null, "java", tmp.toString());
        assertEquals(1, fail.exit(), fail.text());
    }

    @Test
    void aTypeScriptOutputWithTheTapSummaryLinePassesAndZeroFails(@TempDir Path tmp) throws Exception {
        Path ok = project(tmp, "service-full");
        Files.writeString(ok.resolve("check.log"),
                "ok 1 - health\n1..2\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"
                        + "# duration_ms 134.493333\n");
        Outcome pass = count(tmp, null, "typescript", tmp.toString());
        assertEquals(0, pass.exit(), pass.text());
        assertTrue(pass.text().contains(ok + ": 2 tests"), pass.text());

        Files.writeString(ok.resolve("check.log"), "1..0\n# tests 0\n# suites 0\n# pass 0\n# fail 0\n");
        Outcome zero = count(tmp, null, "typescript", tmp.toString());
        assertEquals(1, zero.exit(), zero.text());
    }

    @Test
    void aMissingSummaryLineIsAnUnknownCountAndFails(@TempDir Path tmp) throws Exception {
        Path ok = project(tmp, "service-bare");
        Files.writeString(ok.resolve("check.log"), "something else entirely\n");
        assertEquals(1, count(tmp, null, "typescript", tmp.toString()).exit());
        assertEquals(1, count(tmp, null, "python", tmp.toString()).exit());
        Files.delete(ok.resolve("check.log"));
        assertEquals(1, count(tmp, null, "python", tmp.toString()).exit(), "no log at all");
    }

    @Test
    void oneZeroFolderFailsTheRunButEveryFolderIsStillPrinted(@TempDir Path tmp) throws Exception {
        Path good = project(tmp, "cli-bare");
        Files.writeString(good.resolve("check.log"), "Ran 4 tests in 0.1s\n");
        Path bad = project(tmp, "cli-full");
        Files.writeString(bad.resolve("check.log"), "Ran 0 tests in 0.0s\n");
        Outcome o = count(tmp, null, "python", tmp.toString());
        assertEquals(1, o.exit(), o.text());
        assertTrue(o.text().contains(good + ": 4 tests"), o.text());
        assertTrue(o.text().contains(bad + ": 0 tests"), o.text());
    }

    @Test
    void anOutputRootWithoutAnyProjectFolderFails(@TempDir Path tmp) throws Exception {
        Outcome o = count(tmp, null, "python", tmp.toString());
        assertEquals(1, o.exit(), o.text());
        assertFalse(o.text().isBlank(), "the failure says why");
    }

    @Test
    void theSingleFolderFormReadsTheNamedOutputFile(@TempDir Path tmp) throws Exception {
        Path folder = tmp.resolve("one");
        Files.createDirectories(folder);
        Path output = tmp.resolve("out.txt");
        Files.writeString(output, "Ran 5 tests in 0.1s\n");
        Outcome pass = count(tmp, null, "python", folder.toString(), output.toString());
        assertEquals(0, pass.exit(), pass.text());
        assertTrue(pass.text().contains(folder + ": 5 tests"), pass.text());
        Files.writeString(output, "Ran 0 tests in 0.1s\n");
        assertEquals(1, count(tmp, null, "python", folder.toString(), output.toString()).exit());
    }

    @Test
    void theCountsAreAppendedToTheStepSummaryWhenGithubGivesOne(@TempDir Path tmp) throws Exception {
        Path ok = project(tmp, "service-bare");
        Files.writeString(ok.resolve("check.log"), "Ran 3 tests in 0.1s\n");
        Path summary = tmp.resolve("summary.md");
        Outcome o = count(tmp, summary, "python", tmp.toString());
        assertEquals(0, o.exit(), o.text());
        String written = Files.readString(summary);
        assertTrue(written.contains("service-bare") && written.contains("3 tests"), written);
    }

    @Test
    void anUnknownLanguageFails(@TempDir Path tmp) throws Exception {
        project(tmp, "cli-bare");
        Outcome o = count(tmp, null, "cobol", tmp.toString());
        assertEquals(2, o.exit(), o.text());
    }
}
