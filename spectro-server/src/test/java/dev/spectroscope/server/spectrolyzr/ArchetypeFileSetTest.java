package dev.spectroscope.server.spectrolyzr;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The shipped manifest renders exactly the file sets the spec's tables state,
 * in render order, for every archetype and language, and no archetype ships an
 * empty test. The expected lists are written out here on purpose: the spec is
 * the source, this test is the contract it states.
 */
class ArchetypeFileSetTest {

    private static final Manifest MANIFEST = shipped();

    private static Manifest shipped() {
        ManifestReader.Read read = ManifestReader.read("spectrolyzr");
        assertEquals(List.of(), read.problems(), "the shipped manifest must be clean");
        assertNotNull(read.manifest());
        return read.manifest();
    }

    private static List<RenderedFile> render(String archetype, String language) {
        return Spectrolyzr.render(MANIFEST, new Choices(archetype, language, List.of(), "ledger-api"));
    }

    private static List<String> paths(List<RenderedFile> files) {
        return files.stream().map(RenderedFile::path).toList();
    }

    private static final Map<String, List<String>> TYPESCRIPT = Map.of(
            "service", List.of("tsconfig.json", ".gitignore", "CLAUDE.md", "package.json", "README.md",
                    "src/server.ts", "src/main.ts", "test/server.test.ts"),
            "library", List.of("tsconfig.json", ".gitignore", "CLAUDE.md", "package.json", "README.md",
                    "src/index.ts", "test/index.test.ts"),
            "cli", List.of("tsconfig.json", ".gitignore", "CLAUDE.md", "package.json", "README.md",
                    "src/cli.ts", "src/main.ts", "test/cli.test.ts"));

    @Test
    void theShippedCatalogOffersTheThreeArchetypes() {
        assertEquals(List.of("service", "library", "cli"),
                MANIFEST.archetypes().stream().map(Manifest.Archetype::id).toList());
    }

    @Test
    void typescriptRendersExactlyTheSpecTableForEveryArchetype() {
        for (var e : TYPESCRIPT.entrySet()) {
            assertEquals(e.getValue(), paths(render(e.getKey(), "typescript")), e.getKey());
        }
    }

    @Test
    void typescriptRunsItsTestsWithNpmTest() {
        Manifest.Language ts = MANIFEST.languages().stream().filter(l -> l.id().equals("typescript")).findFirst()
                .orElseThrow(() -> new AssertionError("no typescript language in the manifest"));
        assertEquals("npm test", ts.commands().get("test"));
    }

    @Test
    void everyTypescriptTestFileUsesNodeTestAndAsserts() {
        Pattern assertCall = Pattern.compile("\\bassert[.(]");
        for (String archetype : TYPESCRIPT.keySet()) {
            var tests = render(archetype, "typescript").stream().filter(f -> f.path().startsWith("test/")).toList();
            assertFalse(tests.isEmpty(), archetype + " ships a test");
            for (RenderedFile test : tests) {
                assertTrue(test.content().contains("node:test"), archetype + " " + test.path() + " uses node:test");
                assertTrue(assertCall.matcher(test.content()).find(), archetype + " " + test.path() + " asserts");
            }
        }
    }

    @Test
    void theTypescriptPackageFilesCarryTheNameAndTheScripts() throws Exception {
        var mapper = new com.fasterxml.jackson.databind.ObjectMapper();
        for (String archetype : TYPESCRIPT.keySet()) {
            var pkg = mapper.readTree(render(archetype, "typescript").stream()
                    .filter(f -> f.path().equals("package.json")).findFirst().orElseThrow().content());
            assertEquals("ledger-api", pkg.get("name").asText(), archetype);
            assertEquals("module", pkg.get("type").asText(), archetype);
            assertTrue(pkg.get("private").asBoolean(), archetype);
            assertEquals(">=22", pkg.at("/engines/node").asText(), archetype);
            assertEquals("tsc -p .", pkg.at("/scripts/build").asText(), archetype);
            assertEquals("tsc -p . && node --test --test-reporter=tap \"dist/test/**/*.test.js\"",
                    pkg.at("/scripts/test").asText(), archetype);
            assertEquals("5.8.3", pkg.at("/devDependencies/typescript").asText(), archetype);
            assertEquals("22.20.1", pkg.at("/devDependencies/@types~1node").asText(), archetype);
        }
    }

    @Test
    void everyTypescriptFileHasBothWhySentencesAndNoDashAsPunctuation() {
        char emDash = '\u2014';
        char enDash = '\u2013';
        for (String archetype : TYPESCRIPT.keySet()) {
            for (RenderedFile f : render(archetype, "typescript")) {
                assertFalse(f.why().en().isBlank(), f.path());
                assertFalse(f.why().de().isBlank(), f.path());
                assertEquals(-1, f.content().indexOf(emDash), f.path());
                assertEquals(-1, f.content().indexOf(enDash), f.path());
                for (String why : new String[] {f.why().en(), f.why().de()}) {
                    assertEquals(-1, why.indexOf(emDash), f.path() + " why");
                    assertEquals(-1, why.indexOf(enDash), f.path() + " why");
                }
                assertTrue(f.content().endsWith("\n"), f.path() + " ends with a line feed");
            }
        }
    }

    private static final Map<String, List<String>> PYTHON = Map.of(
            "service", List.of(".gitignore", "CLAUDE.md", "pyproject.toml", "README.md",
                    "ledger_api/__init__.py", "ledger_api/server.py", "ledger_api/__main__.py",
                    "tests/__init__.py", "tests/test_server.py"),
            "library", List.of(".gitignore", "CLAUDE.md", "pyproject.toml", "README.md",
                    "ledger_api/__init__.py", "ledger_api/core.py",
                    "tests/__init__.py", "tests/test_core.py"),
            "cli", List.of(".gitignore", "CLAUDE.md", "pyproject.toml", "README.md",
                    "ledger_api/__init__.py", "ledger_api/cli.py", "ledger_api/__main__.py",
                    "tests/__init__.py", "tests/test_cli.py"));

    /** Top level modules a generated Python file may import besides its own package. */
    private static final Set<String> STDLIB = Set.of("http", "json", "threading", "unittest", "urllib", "sys", "os",
            "argparse");

    private static final Pattern IMPORT_LINE = Pattern.compile("^(?:from\\s+(\\S+)\\s+import\\b|import\\s+(\\S+))",
            Pattern.MULTILINE);

    @Test
    void pythonRendersExactlyTheSpecTableForEveryArchetype() {
        for (var e : PYTHON.entrySet()) {
            assertEquals(e.getValue(), paths(render(e.getKey(), "python")), e.getKey());
        }
    }

    @Test
    void pythonRunsItsTestsWithUnittestDiscover() {
        Manifest.Language py = MANIFEST.languages().stream().filter(l -> l.id().equals("python")).findFirst()
                .orElseThrow(() -> new AssertionError("no python language in the manifest"));
        assertEquals("python3 -m unittest discover -s tests -t . -v", py.commands().get("test"));
        assertEquals("python3 scripts/gate.py", py.commands().get("gate"));
    }

    @Test
    void everyPythonTestFileUsesUnittestAndAsserts() {
        Pattern assertCall = Pattern.compile("self\\.assert\\w+\\(");
        for (String archetype : PYTHON.keySet()) {
            var tests = render(archetype, "python").stream()
                    .filter(f -> f.path().startsWith("tests/test_")).toList();
            assertEquals(1, tests.size(), archetype + " ships exactly one test module");
            for (RenderedFile test : tests) {
                assertTrue(test.content().contains("unittest.TestCase"), archetype + " " + test.path() + " is a TestCase");
                assertTrue(assertCall.matcher(test.content()).find(), archetype + " " + test.path() + " asserts");
            }
        }
    }

    @Test
    void noPythonFileImportsAnythingOutsideTheStandardLibrary() {
        for (String archetype : PYTHON.keySet()) {
            int seen = 0;
            for (RenderedFile f : render(archetype, "python")) {
                if (!f.path().endsWith(".py")) {
                    continue;
                }
                Matcher m = IMPORT_LINE.matcher(f.content());
                while (m.find()) {
                    String module = m.group(1) != null ? m.group(1) : m.group(2);
                    if (module.startsWith(".")) {
                        seen++;
                        continue;
                    }
                    String top = module.split("\\.")[0];
                    assertTrue(STDLIB.contains(top) || top.equals("ledger_api"),
                            archetype + " " + f.path() + " imports " + module);
                    seen++;
                }
            }
            assertTrue(seen > 0, archetype + " has imports at all, so the scan looked at something");
        }
    }

    @Test
    void thePythonProjectFilesCarryTheNameTheVersionAndNoDependency() {
        for (String archetype : PYTHON.keySet()) {
            String pyproject = render(archetype, "python").stream()
                    .filter(f -> f.path().equals("pyproject.toml")).findFirst().orElseThrow().content();
            assertTrue(pyproject.contains("name = \"ledger-api\"\n"), archetype);
            assertTrue(pyproject.contains("version = \"0.1.0\"\n"), archetype);
            assertTrue(pyproject.contains("requires-python = \">=3.11\"\n"), archetype);
            assertFalse(pyproject.contains("dependencies"), archetype + " declares no dependency");
            assertEquals(archetype.equals("cli"), pyproject.contains("[project.scripts]\nledger-api = \"ledger_api.cli:main\"\n"),
                    archetype + " declares its entry point exactly when it is a command line tool");
        }
    }

    @Test
    void everyPythonFileHasBothWhySentencesAndNoDashAsPunctuation() {
        char emDash = '\u2014';
        char enDash = '\u2013';
        for (String archetype : PYTHON.keySet()) {
            for (RenderedFile f : render(archetype, "python")) {
                assertFalse(f.why().en().isBlank(), f.path());
                assertFalse(f.why().de().isBlank(), f.path());
                assertEquals(-1, f.content().indexOf(emDash), f.path());
                assertEquals(-1, f.content().indexOf(enDash), f.path());
                assertTrue(f.content().endsWith("\n"), f.path() + " ends with a line feed");
            }
        }
    }
}
