package dev.spectroscope.server.spectrolyzr;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The quality gate and CI add-ons of the shipped manifest, for every language
 * and archetype. The expected gate commands are written out here on purpose:
 * the spec states them, this test is the contract.
 */
class AddonTest {

    private static final Manifest MANIFEST = shipped();

    private static final String CI_PATH = ".github/workflows/ci.yml";
    private static final String GATE_SECTION = "## Quality gate";

    private static final Map<String, String> GATE_COMMAND = Map.of(
            "typescript", "node scripts/gate.mjs",
            "python", "python3 scripts/gate.py",
            "java", "gradle gate");

    private static final Map<String, String> TEST_COMMAND = Map.of(
            "typescript", "npm test",
            "python", "python3 -m unittest discover -s tests -t . -v",
            "java", "gradle test");

    private static final Map<String, String> GATE_FILE = Map.of(
            "typescript", "scripts/gate.mjs",
            "python", "scripts/gate.py");

    private static final List<String> LANGUAGES = List.of("typescript", "python", "java");
    private static final List<String> ARCHETYPES = List.of("service", "library", "cli");

    private static Manifest shipped() {
        ManifestReader.Read read = ManifestReader.read("spectrolyzr");
        assertEquals(List.of(), read.problems(), "the shipped manifest must be clean");
        assertNotNull(read.manifest());
        return read.manifest();
    }

    private static List<RenderedFile> render(String archetype, String language, String... addons) {
        return Spectrolyzr.render(MANIFEST, new Choices(archetype, language, List.of(addons), "ledger-api"));
    }

    private static RenderedFile file(List<RenderedFile> files, String path) {
        return files.stream().filter(f -> f.path().equals(path)).findFirst()
                .orElseThrow(() -> new AssertionError("no " + path + " in " + files.stream().map(RenderedFile::path).toList()));
    }

    private static String lastRunLine(String yaml) {
        String last = null;
        for (String line : yaml.split("\n")) {
            String trimmed = line.strip();
            if (trimmed.startsWith("run:")) {
                last = trimmed.substring("run:".length()).strip();
            }
        }
        assertNotNull(last, "the workflow has a run: line");
        return last;
    }

    @Test
    void theShippedManifestStaysCleanOverEveryCombinationWithTheAddons() {
        assertEquals(List.of(), Spectrolyzr.validateAll(MANIFEST));
    }

    @Test
    void theGateCommandsAreTheOnesTheSpecNames() {
        for (String language : LANGUAGES) {
            Manifest.Language l = MANIFEST.languages().stream().filter(x -> x.id().equals(language)).findFirst().orElseThrow();
            assertEquals(GATE_COMMAND.get(language), l.commands().get("gate"), language);
            assertEquals(TEST_COMMAND.get(language), l.commands().get("test"), language);
        }
    }

    @Test
    void withoutAddonsThereIsNoGateNoWorkflowAndNoGateSection() {
        for (String language : LANGUAGES) {
            for (String archetype : ARCHETYPES) {
                List<RenderedFile> files = render(archetype, language);
                String where = archetype + " " + language;
                assertFalse(files.stream().anyMatch(f -> f.path().startsWith("scripts/")), where + " has no scripts");
                assertFalse(files.stream().anyMatch(f -> f.path().startsWith(".github/")), where + " has no workflow");
                assertFalse(file(files, "README.md").content().contains(GATE_SECTION), where + " README");
                assertFalse(file(files, "CLAUDE.md").content().contains(GATE_SECTION), where + " CLAUDE.md");
                assertFalse(file(files, language.equals("java") ? "build.gradle.kts" : "README.md").content()
                        .contains("gate"), where + " mentions no gate");
            }
        }
    }

    @Test
    void theQualityGatePutsItsFileAndEndsReadmeAndClaudeMdWithTheGateSection() {
        for (String language : LANGUAGES) {
            for (String archetype : ARCHETYPES) {
                List<RenderedFile> files = render(archetype, language, "quality-gate");
                String where = archetype + " " + language;
                if (GATE_FILE.containsKey(language)) {
                    RenderedFile gate = file(files, GATE_FILE.get(language));
                    assertFalse(gate.why().en().isBlank(), where);
                    assertFalse(gate.why().de().isBlank(), where);
                    assertTrue(gate.content().endsWith("\n"), where);
                } else {
                    assertFalse(files.stream().anyMatch(f -> f.path().startsWith("scripts/")), where);
                }
                for (String doc : List.of("README.md", "CLAUDE.md")) {
                    String text = file(files, doc).content();
                    int at = text.lastIndexOf(GATE_SECTION);
                    assertTrue(at > 0, where + " " + doc + " has the gate section");
                    assertEquals(-1, text.indexOf("\n## ", at + 1), where + " " + doc + " ends with the gate section");
                    assertTrue(text.substring(at).contains(GATE_COMMAND.get(language)),
                            where + " " + doc + " names the gate command");
                    assertTrue(text.endsWith("\n"), where + " " + doc);
                }
            }
        }
    }

    @Test
    void theGateAppendKeepsTheFilePositionsOfReadmeAndClaudeMd() {
        for (String language : LANGUAGES) {
            List<String> bare = render("service", language).stream().map(RenderedFile::path).toList();
            List<String> gated = render("service", language, "quality-gate").stream().map(RenderedFile::path).toList();
            assertEquals(bare, gated.subList(0, bare.size()), language + " the bare files keep their order");
            assertEquals(bare.size() + (GATE_FILE.containsKey(language) ? 1 : 0), gated.size(), language);
        }
    }

    @Test
    void theTypescriptGateTypeChecksRunsNpmTestAndFailsOnZeroTests() {
        String gate = file(render("library", "typescript", "quality-gate"), "scripts/gate.mjs").content();
        assertTrue(gate.contains("--noEmit"), "type check without emitting");
        assertTrue(gate.contains("\"test\""), "runs the npm test script");
        assertTrue(gate.contains("# tests"), "reads the TAP summary line");
        assertTrue(gate.contains("rmSync(\"dist\""), "starts from an empty dist so a deleted test cannot linger");
        assertTrue(gate.contains("process.exit(1)") || gate.contains("process.exitCode = 1"), "exits 1 on failure");
    }

    @Test
    void thePythonGateCompilesRunsUnittestAndFailsOnZeroTests() {
        String gate = file(render("library", "python", "quality-gate"), "scripts/gate.py").content();
        assertTrue(gate.contains("compileall"), "compiles every module");
        assertTrue(gate.contains("ledger_api"), "compiles the generated package");
        assertTrue(gate.contains("unittest"), "runs the tests");
        assertTrue(gate.contains("Ran "), "reads the unittest summary line");
        assertTrue(gate.contains("return 1") && gate.contains("sys.exit(main())"), "exits 1 on failure");
    }

    @Test
    void theJavaGateTaskDependsOnCheckAndCompilesWithLintAsErrors() {
        for (String archetype : ARCHETYPES) {
            String build = file(render(archetype, "java", "quality-gate"), "build.gradle.kts").content();
            assertTrue(build.contains("-Xlint:all"), archetype);
            assertTrue(build.contains("-Werror"), archetype);
            assertTrue(build.contains("tasks.register(\"gate\")"), archetype);
            assertTrue(build.contains("dependsOn(\"check\")"), archetype);
            assertTrue(build.indexOf("tasks.register(\"gate\")") > build.indexOf("tasks.test"),
                    archetype + " the gate comes after the project's own build");
        }
    }

    @Test
    void ciPutsOneWorkflowWhoseLastRunLineIsTheCheckCommandWithAndWithoutTheGate() {
        for (String language : LANGUAGES) {
            for (String archetype : ARCHETYPES) {
                String where = archetype + " " + language;
                String bare = file(render(archetype, language, "ci"), CI_PATH).content();
                assertEquals(TEST_COMMAND.get(language), lastRunLine(bare), where + " without the gate");
                List<RenderedFile> both = render(archetype, language, "quality-gate", "ci");
                assertEquals(GATE_COMMAND.get(language), lastRunLine(file(both, CI_PATH).content()), where + " with the gate");
            }
        }
    }

    @Test
    void theWorkflowRunsOnPushAndPullRequestOnUbuntuWithCheckoutAndTheToolchain() {
        Map<String, List<String>> toolchain = Map.of(
                "typescript", List.of("actions/setup-node@v4", "node-version: \"22\"", "npm install"),
                "python", List.of("actions/setup-python@v7", "python-version: \"3.12\""),
                "java", List.of("actions/setup-java@v4", "distribution: temurin", "java-version: \"21\"",
                        "gradle/actions/setup-gradle@v4", "gradle-version: \"9.6.1\""));
        for (String language : LANGUAGES) {
            RenderedFile ci = file(render("service", language, "ci"), CI_PATH);
            String text = ci.content();
            assertFalse(ci.why().en().isBlank(), language);
            assertFalse(ci.why().de().isBlank(), language);
            assertTrue(text.contains("on: [push, pull_request]"), language);
            assertTrue(text.contains("runs-on: ubuntu-latest"), language);
            assertTrue(text.contains("actions/checkout@v4"), language);
            for (String needle : toolchain.get(language)) {
                assertTrue(text.contains(needle), language + " has " + needle);
            }
            assertEquals(1, text.split("runs-on:", -1).length - 1, language + " one job");
        }
    }

    @Test
    void ciComesAfterTheGateAndBothAfterTheProject() {
        for (String language : LANGUAGES) {
            List<String> paths = new ArrayList<>(render("cli", language, "ci", "quality-gate").stream()
                    .map(RenderedFile::path).toList());
            assertEquals(CI_PATH, paths.get(paths.size() - 1), language + " ci is last");
            if (GATE_FILE.containsKey(language)) {
                assertTrue(paths.indexOf(GATE_FILE.get(language)) < paths.indexOf(CI_PATH), language);
            }
        }
    }

    @Test
    void noGateOrWorkflowTextCarriesADashAsPunctuation() {
        char emDash = '—';
        char enDash = '–';
        for (String language : LANGUAGES) {
            for (RenderedFile f : render("service", language, "quality-gate", "ci")) {
                assertEquals(-1, f.content().indexOf(emDash), language + " " + f.path());
                assertEquals(-1, f.content().indexOf(enDash), language + " " + f.path());
                assertEquals(-1, f.content().indexOf('\r'), language + " " + f.path());
            }
        }
    }
}
