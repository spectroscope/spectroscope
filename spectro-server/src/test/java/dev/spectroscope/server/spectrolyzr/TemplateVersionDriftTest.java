package dev.spectroscope.server.spectrolyzr;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The versions the generated projects pin follow the versions the product
 * builds with, so one upgrade card moves both. Every value is read from the
 * product's own files on disk and compared with what the templates render:
 * TypeScript and the Node typings from {@code spectro-web/package.json}, JUnit
 * from {@code gradle/libs.versions.toml}, Gradle from the wrapper, and the Node
 * major and the action majors from {@code .github/workflows/gate.yml}. The
 * Python action has no product counterpart and is pinned by {@link AddonTest}.
 */
class TemplateVersionDriftTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern USES = Pattern.compile("uses:\\s*([\\w./-]+)@(v\\d+)");

    private static Manifest manifest() {
        ManifestReader.Read read = ManifestReader.read("spectrolyzr");
        assertEquals(List.of(), read.problems(), "the shipped manifest must be clean");
        assertNotNull(read.manifest());
        return read.manifest();
    }

    private static String rendered(String language, String path, String... addons) {
        List<RenderedFile> files = Spectrolyzr.render(manifest(), new Choices("service", language, List.of(addons), "ledger-api"));
        return files.stream().filter(f -> f.path().equals(path)).findFirst()
                .orElseThrow(() -> new AssertionError("no " + path + " rendered for " + language)).content();
    }

    private static Path root() {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        return root;
    }

    private static String read(Path root, String relative) throws IOException {
        Path file = root.resolve(relative);
        assertTrue(Files.isRegularFile(file), "product file vanished: " + relative);
        return Files.readString(file);
    }

    private static String first(String text, String regex, String what) {
        Matcher m = Pattern.compile(regex, Pattern.MULTILINE).matcher(text);
        assertTrue(m.find(), "no " + what + " found with " + regex);
        return m.group(1);
    }

    private static String stripRange(String version) {
        return version.replaceFirst("^[~^<>=\\s]+", "");
    }

    /** The product's action majors keyed by action name, from every {@code uses:} line of gate.yml. */
    private static Map<String, String> actionMajors(String gate) {
        Map<String, String> majors = new LinkedHashMap<>();
        Matcher m = USES.matcher(gate);
        while (m.find()) {
            String earlier = majors.putIfAbsent(m.group(1), m.group(2));
            assertTrue(earlier == null || earlier.equals(m.group(2)), "gate.yml pins " + m.group(1) + " twice differently");
        }
        return majors;
    }

    @Test
    void typescriptAndItsNodeTypingsFollowTheWebModule() throws Exception {
        Path root = root();
        JsonNode web = JSON.readTree(read(root, "spectro-web/package.json"));
        String typescript = stripRange(web.at("/devDependencies/typescript").asText());
        String typings = stripRange(web.at("/devDependencies/@types~1node").asText());
        assertFalse(typescript.isEmpty(), "spectro-web declares typescript");
        assertFalse(typings.isEmpty(), "spectro-web declares @types/node");
        for (String archetype : List.of("service", "library", "cli")) {
            List<RenderedFile> files = Spectrolyzr.render(manifest(), new Choices(archetype, "typescript", List.of(), "ledger-api"));
            JsonNode pkg = JSON.readTree(files.stream().filter(f -> f.path().equals("package.json")).findFirst().orElseThrow().content());
            assertEquals(typescript, pkg.at("/devDependencies/typescript").asText(), archetype + " typescript");
            assertEquals(typings, pkg.at("/devDependencies/@types~1node").asText(), archetype + " @types/node");
        }
    }

    @Test
    void junitFollowsTheProductVersionCatalog() throws Exception {
        Path root = root();
        String junit = first(read(root, "gradle/libs.versions.toml"), "^junit\\s*=\\s*\"([^\"]+)\"", "junit version");
        for (String archetype : List.of("service", "library", "cli")) {
            List<RenderedFile> files = Spectrolyzr.render(manifest(), new Choices(archetype, "java", List.of(), "ledger-api"));
            String build = files.stream().filter(f -> f.path().equals("build.gradle.kts")).findFirst().orElseThrow().content();
            assertEquals(junit, first(build, "junit-bom:([^\"]+)\"", "junit-bom"), archetype);
        }
    }

    @Test
    void theCiGradleVersionIsTheWrapperVersion() throws Exception {
        Path root = root();
        String wrapper = first(read(root, "gradle/wrapper/gradle-wrapper.properties"),
                "distributionUrl=.*gradle-([0-9][0-9.]*)-bin\\.zip", "wrapper version");
        String ci = rendered("java", ".github/workflows/ci.yml", "ci");
        assertEquals(wrapper, first(ci, "gradle-version:\\s*\"([^\"]+)\"", "gradle-version"));
    }

    @Test
    void theCiNodeMajorIsTheProductsAndTheEnginesFloorMatches() throws Exception {
        Path root = root();
        String node = first(read(root, ".github/workflows/gate.yml"), "node-version:\\s*\"([^\"]+)\"", "node-version");
        String ci = rendered("typescript", ".github/workflows/ci.yml", "ci");
        assertEquals(node, first(ci, "node-version:\\s*\"([^\"]+)\"", "ci node-version"));
        JsonNode pkg = JSON.readTree(rendered("typescript", "package.json"));
        assertEquals(">=" + node, pkg.at("/engines/node").asText());
    }

    @Test
    void everyActionMajorTheProductPinsIsTheOneTheCiTemplatesPin() throws Exception {
        Path root = root();
        Map<String, String> product = actionMajors(read(root, ".github/workflows/gate.yml"));
        assertTrue(product.containsKey("actions/checkout"), "gate.yml uses actions/checkout");
        Map<String, List<String>> expectedShared = Map.of(
                "typescript", List.of("actions/checkout", "actions/setup-node"),
                "python", List.of("actions/checkout"),
                "java", List.of("actions/checkout", "actions/setup-java", "gradle/actions/setup-gradle"));
        for (var e : expectedShared.entrySet()) {
            Map<String, String> templates = actionMajors(rendered(e.getKey(), ".github/workflows/ci.yml", "ci"));
            for (String action : e.getValue()) {
                assertNotNull(templates.get(action), e.getKey() + " ci uses " + action);
                assertNotNull(product.get(action), "gate.yml uses " + action);
                assertEquals(product.get(action), templates.get(action), e.getKey() + " " + action);
            }
        }
    }

    /**
     * Walks up from the module directory to the directory holding
     * {@code settings.gradle.kts}.
     *
     * @return the checkout root, or null when this runs outside one
     */
    private static Path repoRoot() {
        Path here = Path.of("").toAbsolutePath();
        for (Path candidate = here; candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return null;
    }
}
