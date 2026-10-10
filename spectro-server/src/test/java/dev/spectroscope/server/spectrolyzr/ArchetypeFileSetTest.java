package dev.spectroscope.server.spectrolyzr;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
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
        }
    }

    @Test
    void everyTypescriptFileHasBothWhySentencesAndNoDashAsPunctuation() {
        char emDash = '—';
        char enDash = '–';
        for (String archetype : TYPESCRIPT.keySet()) {
            for (RenderedFile f : render(archetype, "typescript")) {
                assertFalse(f.why().en().isBlank(), f.path());
                assertFalse(f.why().de().isBlank(), f.path());
                assertEquals(-1, f.content().indexOf(emDash), f.path());
                assertEquals(-1, f.content().indexOf(enDash), f.path());
                assertTrue(f.content().endsWith("\n"), f.path() + " ends with a line feed");
            }
        }
    }
}
