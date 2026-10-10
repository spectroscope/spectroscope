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

    private static final Map<String, List<String>> JAVA = Map.of(
            "service", List.of("settings.gradle.kts", ".gitignore", "CLAUDE.md", "build.gradle.kts", "README.md",
                    "src/main/java/ledgerapi/App.java", "src/main/java/ledgerapi/HealthHandler.java",
                    "src/test/java/ledgerapi/AppTest.java"),
            "library", List.of("settings.gradle.kts", ".gitignore", "CLAUDE.md", "build.gradle.kts", "README.md",
                    "src/main/java/ledgerapi/Greeting.java", "src/test/java/ledgerapi/GreetingTest.java"),
            "cli", List.of("settings.gradle.kts", ".gitignore", "CLAUDE.md", "build.gradle.kts", "README.md",
                    "src/main/java/ledgerapi/Cli.java", "src/main/java/ledgerapi/Main.java",
                    "src/test/java/ledgerapi/CliTest.java"));

    private static String content(String archetype, String path) {
        return render(archetype, "java").stream().filter(f -> f.path().equals(path)).findFirst()
                .orElseThrow(() -> new AssertionError(archetype + " renders no " + path)).content();
    }

    @Test
    void javaRendersExactlyTheSpecTableForEveryArchetype() {
        for (var e : JAVA.entrySet()) {
            assertEquals(e.getValue(), paths(render(e.getKey(), "java")), e.getKey());
        }
    }

    @Test
    void javaRunsItsTestsWithGradleTest() {
        Manifest.Language java = MANIFEST.languages().stream().filter(l -> l.id().equals("java")).findFirst()
                .orElseThrow(() -> new AssertionError("no java language in the manifest"));
        assertEquals("gradle test", java.commands().get("test"));
        assertEquals("gradle gate", java.commands().get("gate"));
    }

    @Test
    void everyJavaSourceDeclaresTheDerivedPackageAndLivesInItsFolder() {
        for (String archetype : JAVA.keySet()) {
            int seen = 0;
            for (RenderedFile f : render(archetype, "java")) {
                if (!f.path().endsWith(".java")) {
                    continue;
                }
                assertTrue(f.path().contains("/ledgerapi/"), archetype + " " + f.path() + " sits in the package folder");
                assertTrue(f.content().startsWith("package ledgerapi;\n"),
                        archetype + " " + f.path() + " declares package ledgerapi");
                assertFalse(f.content().contains("@@"), archetype + " " + f.path() + " has no placeholder left");
                seen++;
            }
            assertTrue(seen > 0, archetype + " renders Java sources, so the scan looked at something");
        }
    }

    @Test
    void everyJavaTestUsesJunitJupiterAndAsserts() {
        Pattern assertCall = Pattern.compile("\\bassert\\w+\\(");
        for (String archetype : JAVA.keySet()) {
            var tests = render(archetype, "java").stream().filter(f -> f.path().startsWith("src/test/")).toList();
            assertEquals(1, tests.size(), archetype + " ships exactly one test class");
            for (RenderedFile test : tests) {
                assertTrue(test.content().contains("import org.junit.jupiter.api.Test;"),
                        archetype + " " + test.path() + " uses JUnit Jupiter");
                assertTrue(test.content().contains("@Test"), archetype + " " + test.path() + " has a test");
                assertTrue(assertCall.matcher(test.content()).find(), archetype + " " + test.path() + " asserts");
            }
        }
    }

    @Test
    void theJavaSourcesUseTheJdkOnly() {
        Pattern importLine = Pattern.compile("^import\\s+(?:static\\s+)?(\\S+);", Pattern.MULTILINE);
        for (String archetype : JAVA.keySet()) {
            int seen = 0;
            for (RenderedFile f : render(archetype, "java")) {
                if (!f.path().endsWith(".java")) {
                    continue;
                }
                Matcher m = importLine.matcher(f.content());
                while (m.find()) {
                    String imported = m.group(1);
                    assertTrue(imported.startsWith("java.") || imported.startsWith("com.sun.net.httpserver.")
                                    || imported.startsWith("org.junit.jupiter.api."),
                            archetype + " " + f.path() + " imports " + imported);
                    seen++;
                }
            }
            assertTrue(seen > 0, archetype + " has imports at all, so the scan looked at something");
        }
    }

    @Test
    void theGradleFilesCarryTheNameTheToolchainAndTheJunitLine() {
        for (String archetype : JAVA.keySet()) {
            assertEquals("rootProject.name = \"ledger-api\"\n", content(archetype, "settings.gradle.kts"), archetype);
            String build = content(archetype, "build.gradle.kts");
            assertTrue(build.contains("repositories {\n    mavenCentral()\n}"), archetype);
            assertTrue(build.contains("JavaLanguageVersion.of(21)"), archetype);
            assertTrue(build.contains("testImplementation(platform(\"org.junit:junit-bom:5.10.2\"))"), archetype);
            assertTrue(build.contains("testImplementation(\"org.junit.jupiter:junit-jupiter\")"), archetype);
            assertTrue(build.contains("testRuntimeOnly(\"org.junit.platform:junit-platform-launcher\")"), archetype);
            assertTrue(build.contains("tasks.test {\n    useJUnitPlatform()\n}"), archetype);
            assertEquals(archetype.equals("library"), build.contains("`java-library`"), archetype);
            assertEquals(!archetype.equals("library"), build.contains("application"), archetype);
        }
        assertTrue(content("service", "build.gradle.kts").contains("mainClass.set(\"ledgerapi.App\")"));
        assertTrue(content("cli", "build.gradle.kts").contains("mainClass.set(\"ledgerapi.Main\")"));
    }

    @Test
    void noJavaArchetypeShipsAGradleWrapper() {
        for (String archetype : JAVA.keySet()) {
            for (String path : paths(render(archetype, "java"))) {
                assertFalse(path.startsWith("gradle/") || path.startsWith("gradlew"), archetype + " ships " + path);
            }
            assertTrue(content(archetype, "README.md").contains("gradle wrapper"),
                    archetype + " README tells the reader to generate the wrapper once");
        }
    }

    @Test
    void everyJavaFileHasBothWhySentencesAndNoDashAsPunctuation() {
        char emDash = '\u2014';
        char enDash = '\u2013';
        for (String archetype : JAVA.keySet()) {
            for (RenderedFile f : render(archetype, "java")) {
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
}
