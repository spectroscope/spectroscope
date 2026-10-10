package dev.spectroscope.server.spectrolyzr;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.server.playbooks.PlaybookFolders;
import dev.spectroscope.server.playbooks.PlaybookLoader;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The three Spectrolyzr routes, driven directly with a mock request the way
 * {@code BundleControllerTest} drives the scaffold: the catalog, the preview
 * and the fenced generate route with its two folders, its refusals and the
 * pin of the playbook folder to the new project.
 */
class SpectrolyzrControllerTest {

    @TempDir Path tmp;

    private final ObjectMapper mapper = new ObjectMapper();
    private PlaybookFolders folders;
    private SpectrolyzrController controller;

    @BeforeEach
    void setUp() {
        folders = new PlaybookFolders(tmp.resolve("playbooks.json"));
        controller = new SpectrolyzrController(ManifestReader.read("spectrolyzr").manifest(), folders);
    }

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    private static MockHttpServletRequest foreign() {
        MockHttpServletRequest remote = new MockHttpServletRequest();
        remote.setRemoteAddr("203.0.113.7");
        remote.setServerName("example.com");
        remote.addHeader("Origin", "https://example.com");
        return remote;
    }

    private JsonNode json(ResponseEntity<?> response) {
        return mapper.valueToTree(response.getBody());
    }

    private ObjectNode body(String archetype, String language, List<String> addons, String name,
                            Path dir, Path playbookDir) {
        ObjectNode node = mapper.createObjectNode();
        node.put("archetype", archetype);
        node.put("language", language);
        ArrayNode list = node.putArray("addons");
        addons.forEach(list::add);
        node.put("name", name);
        if (dir != null) node.put("dir", dir.toString());
        if (playbookDir != null) node.put("playbookDir", playbookDir.toString());
        return node;
    }

    private static List<String> ids(JsonNode list) {
        List<String> out = new ArrayList<>();
        list.forEach(item -> out.add(item.path("id").asText()));
        return out;
    }

    private static Map<String, String> hashes(Path... roots) throws Exception {
        Map<String, String> out = new TreeMap<>();
        for (Path root : roots) {
            if (!Files.exists(root)) {
                continue;
            }
            try (Stream<Path> walk = Files.walk(root)) {
                for (Path file : walk.filter(Files::isRegularFile).toList()) {
                    byte[] digest = MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(file));
                    out.put(file.toString(), java.util.HexFormat.of().formatHex(digest));
                }
            }
        }
        return out;
    }

    private static List<String> strings(JsonNode list) {
        List<String> out = new ArrayList<>();
        list.forEach(item -> out.add(item.asText()));
        return out;
    }

    @Test
    void theCatalogListsArchetypesLanguagesAndAddonsInManifestOrderWithBothLanguages() {
        ResponseEntity<?> response = controller.catalog();
        assertEquals(200, response.getStatusCode().value());
        JsonNode out = json(response);
        assertEquals(List.of("service", "library", "cli"), ids(out.path("archetypes")));
        assertEquals(List.of("typescript", "python", "java"), ids(out.path("languages")));
        assertEquals(List.of("quality-gate", "ci", "spectro-playbook"), ids(out.path("addons")));
        for (String list : List.of("archetypes", "addons")) {
            for (JsonNode item : out.path(list)) {
                for (String field : List.of("name", "description")) {
                    assertFalse(item.path(field).path("en").asText().isBlank(), list + " " + field + " en");
                    assertFalse(item.path(field).path("de").asText().isBlank(), list + " " + field + " de");
                }
            }
        }
        for (JsonNode language : out.path("languages")) {
            assertFalse(language.path("name").asText().isBlank());
        }
    }

    @Test
    void thePreviewOfAJavaServiceWithCiListsTheSpecFilesEachWithAReasonInBothLanguages() {
        ResponseEntity<?> response = controller.preview("service", "java", "ci", "ledger-api");
        assertEquals(200, response.getStatusCode().value());
        JsonNode out = json(response);
        List<String> paths = new ArrayList<>();
        for (JsonNode file : out.path("files")) {
            assertEquals("project", file.path("root").asText());
            paths.add(file.path("path").asText());
            assertFalse(file.path("why").path("en").asText().isBlank(), file.path("path").asText());
            assertFalse(file.path("why").path("de").asText().isBlank(), file.path("path").asText());
            assertEquals(file.path("content").asText().getBytes(java.nio.charset.StandardCharsets.UTF_8).length,
                    file.path("size").asInt(), file.path("path").asText());
        }
        List<String> expected = List.of("settings.gradle.kts", ".gitignore", "CLAUDE.md", "build.gradle.kts",
                "README.md", "src/main/java/ledgerapi/App.java", "src/main/java/ledgerapi/HealthHandler.java",
                "src/test/java/ledgerapi/AppTest.java", ".github/workflows/ci.yml");
        assertEquals(expected.size(), paths.size(), paths.toString());
        assertEquals(new java.util.HashSet<>(expected), new java.util.HashSet<>(paths));
        assertEquals("gradle test", out.path("commands").path("test").asText());
        assertEquals("gradle test", out.path("commands").path("check").asText());
    }

    @Test
    void thePreviewTakesTheQualityGateCommandAsTheCheckCommand() {
        JsonNode out = json(controller.preview("library", "python", "quality-gate,ci", "tally"));
        Manifest.Language python = ManifestReader.read("spectrolyzr").manifest().languages().stream()
                .filter(l -> l.id().equals("python")).findFirst().orElseThrow();
        assertEquals(python.commands().get("test"), out.path("commands").path("test").asText());
        assertEquals(python.commands().get("gate"), out.path("commands").path("check").asText());
        assertFalse(python.commands().get("gate").equals(python.commands().get("test")),
                "the quality gate command differs from the plain test command");
    }

    @Test
    void thePreviewRefusesAnUnknownValueWithTheFieldAndNoFallback() {
        ResponseEntity<?> language = controller.preview("service", "go", "", "ledger-api");
        assertEquals(400, language.getStatusCode().value());
        assertEquals("language", json(language).path("field").asText());
        assertFalse(json(language).path("message").asText().isBlank());

        assertEquals("archetype", json(controller.preview("kb", "java", "", "ledger-api")).path("field").asText());
        assertEquals("addons", json(controller.preview("service", "java", "ci,magic", "ledger-api")).path("field").asText());
        assertEquals("name", json(controller.preview("service", "java", "", "Ledger API")).path("field").asText());
        ResponseEntity<?> missing = controller.preview(null, null, null, null);
        assertEquals(400, missing.getStatusCode().value());
        assertEquals("archetype", json(missing).path("field").asText());
    }

    @Test
    void generateFromACrossSiteOriginIsABlank404AndWritesNothing() throws Exception {
        Path dir = tmp.resolve("ledger-api");
        ResponseEntity<?> response = controller.generate(body("service", "java", List.of(), "ledger-api", dir, null),
                foreign());
        assertEquals(404, response.getStatusCode().value());
        assertNull(response.getBody());
        assertFalse(Files.exists(dir));
        assertEquals(List.of(), folders.read().folders());
    }

    @Test
    void generateWritesTheProjectAndThePlaybookAndPinsOneToTheOther() throws Exception {
        Path dir = tmp.resolve("ledger-api");
        Path playbookDir = tmp.resolve("ledger-api-playbook");
        ResponseEntity<?> response = controller.generate(body("service", "java", List.of("ci", "spectro-playbook"),
                "ledger-api", dir, playbookDir), local());
        assertEquals(200, response.getStatusCode().value(), String.valueOf(response.getBody()));
        JsonNode out = json(response);
        assertTrue(out.path("pinned").asBoolean());
        assertTrue(Files.isRegularFile(dir.resolve("build.gradle.kts")));
        assertTrue(Files.isRegularFile(dir.resolve(".github/workflows/ci.yml")));
        assertTrue(Files.isRegularFile(playbookDir.resolve("playbook.json")));
        assertEquals(dir.toAbsolutePath().normalize().toString(), out.path("project").path("dir").asText());
        assertEquals(playbookDir.toAbsolutePath().normalize().toString(), out.path("playbook").path("dir").asText());
        assertTrue(strings(out.path("project").path("written")).contains("build.gradle.kts"));
        assertTrue(strings(out.path("playbook").path("written")).contains("playbook.json"));
        assertFalse(Files.exists(dir.resolve("playbook.json")), "the playbook is not inside the project");

        PlaybookLoader.Loaded loaded = PlaybookLoader.load(playbookDir.toRealPath(), dir.toRealPath(),
                SpectroConfig.load(SpectroConfig.Overrides.none()));
        assertEquals(List.of(), loaded.findings());
        assertEquals(playbookDir.toRealPath(), folders.activeFor(dir));
        assertTrue(folders.read().folders().contains(playbookDir.toRealPath().toString()));
    }

    @Test
    void generateWithoutThePlaybookAddonWritesOnlyTheProjectAndPinsNothing() throws Exception {
        Path dir = tmp.resolve("tally");
        ResponseEntity<?> response = controller.generate(body("library", "python", List.of(), "tally", dir, null),
                local());
        assertEquals(200, response.getStatusCode().value(), String.valueOf(response.getBody()));
        JsonNode out = json(response);
        assertTrue(out.path("playbook").isNull());
        assertFalse(out.path("pinned").asBoolean());
        assertTrue(Files.isDirectory(dir));
        assertNull(folders.activeFor(dir));
        assertEquals(List.of(), folders.read().folders());
    }

    @Test
    void aPlaybookFolderInsideAroundOrEqualToTheProjectIsRefusedWithNothingWritten() throws Exception {
        Path dir = tmp.resolve("ledger-api");
        for (Path playbookDir : List.of(dir.resolve("playbook"), tmp, dir, tmp.resolve("ledger-api/../ledger-api"))) {
            ResponseEntity<?> response = controller.generate(body("service", "java", List.of("spectro-playbook"),
                    "ledger-api", dir, playbookDir), local());
            assertEquals(400, response.getStatusCode().value(), playbookDir.toString());
            assertEquals("playbookDir", json(response).path("field").asText(), playbookDir.toString());
        }
        assertFalse(Files.exists(dir));
        assertEquals(List.of(), folders.read().folders());
    }

    @Test
    void thePlaybookAddonWithoutAPlaybookFolderIsRefused() {
        Path dir = tmp.resolve("ledger-api");
        ResponseEntity<?> response = controller.generate(body("service", "java", List.of("spectro-playbook"),
                "ledger-api", dir, null), local());
        assertEquals(400, response.getStatusCode().value());
        assertEquals("playbookDir", json(response).path("field").asText());
        assertFalse(Files.exists(dir));
    }

    @Test
    void foldersMustBeAbsoluteAndTheirParentMustExist() {
        ObjectNode relative = body("service", "java", List.of(), "ledger-api", null, null);
        relative.put("dir", "ledger-api");
        ResponseEntity<?> notAbsolute = controller.generate(relative, local());
        assertEquals(400, notAbsolute.getStatusCode().value());
        assertEquals("dir", json(notAbsolute).path("field").asText());

        ResponseEntity<?> blank = controller.generate(body("service", "java", List.of(), "ledger-api", null, null),
                local());
        assertEquals(400, blank.getStatusCode().value());
        assertEquals("dir", json(blank).path("field").asText());

        Path deep = tmp.resolve("missing/ledger-api");
        ResponseEntity<?> noParent = controller.generate(body("service", "java", List.of(), "ledger-api", deep, null),
                local());
        assertEquals(400, noParent.getStatusCode().value());
        assertEquals("dir", json(noParent).path("field").asText());
        assertFalse(Files.exists(tmp.resolve("missing")));
    }

    @Test
    void generateRefusesAnUnknownChoiceAndAnInvalidNameWithTheFieldAndWritesNothing() {
        Path dir = tmp.resolve("ledger-api");
        ResponseEntity<?> language = controller.generate(body("service", "go", List.of(), "ledger-api", dir, null),
                local());
        assertEquals(400, language.getStatusCode().value());
        assertEquals("language", json(language).path("field").asText());
        ResponseEntity<?> name = controller.generate(body("service", "java", List.of(), "Ledger API", dir, null),
                local());
        assertEquals(400, name.getStatusCode().value());
        assertEquals("name", json(name).path("field").asText());
        assertFalse(Files.exists(dir));
    }

    @Test
    void anExistingFileInEitherFolderAnswers409ListingBothRootsAndChangesNothingAndPinsNothing() throws Exception {
        Path dir = Files.createDirectories(tmp.resolve("ledger-api"));
        Path playbookDir = Files.createDirectories(tmp.resolve("ledger-api-playbook"));
        Files.writeString(dir.resolve("README.md"), "mine\n");
        Files.writeString(playbookDir.resolve("playbook.json"), "{}\n");
        Map<String, String> before = hashes(dir, playbookDir);

        ResponseEntity<?> response = controller.generate(body("service", "java", List.of("spectro-playbook"),
                "ledger-api", dir, playbookDir), local());
        assertEquals(409, response.getStatusCode().value());
        JsonNode conflicts = json(response).path("conflicts");
        assertEquals(List.of("README.md"), strings(conflicts.path("project")));
        assertEquals(List.of("playbook.json"), strings(conflicts.path("playbook")));
        assertEquals(before, hashes(dir, playbookDir));
        assertNull(folders.activeFor(dir), "a refused generate pins nothing");
        assertEquals(List.of(), folders.read().folders());
    }

    @Test
    void generatingTheSameChoicesAgainAnswers409AndLeavesEveryByteUnchanged() throws Exception {
        Path dir = tmp.resolve("ledger-api");
        Path playbookDir = tmp.resolve("ledger-api-playbook");
        ObjectNode request = body("service", "java", List.of("ci", "spectro-playbook"), "ledger-api", dir, playbookDir);
        assertEquals(200, controller.generate(request, local()).getStatusCode().value());
        Map<String, String> before = hashes(dir, playbookDir);

        ResponseEntity<?> again = controller.generate(request, local());
        assertEquals(409, again.getStatusCode().value());
        JsonNode conflicts = json(again).path("conflicts");
        assertTrue(strings(conflicts.path("project")).contains("build.gradle.kts"));
        assertTrue(strings(conflicts.path("playbook")).contains("playbook.json"));
        assertEquals(before, hashes(dir, playbookDir));
    }

    @Test
    void aProjectThatConflictsStopsBeforeThePlaybookFolderIsCreated() throws Exception {
        Path dir = Files.createDirectories(tmp.resolve("ledger-api"));
        Path playbookDir = tmp.resolve("ledger-api-playbook");
        Files.writeString(dir.resolve("README.md"), "mine\n");
        ResponseEntity<?> response = controller.generate(body("service", "java", List.of("spectro-playbook"),
                "ledger-api", dir, playbookDir), local());
        assertEquals(409, response.getStatusCode().value());
        assertFalse(Files.exists(playbookDir), "pass one covers both folders before anything is written");
        assertEquals(List.of(), strings(json(response).path("conflicts").path("playbook")));
        assertFalse(Files.exists(dir.resolve("build.gradle.kts")));
    }

    @Test
    void generatingTwiceFromTheSameChoicesGivesTheSameBytes() throws Exception {
        Path first = tmp.resolve("one");
        Path second = tmp.resolve("two");
        for (Path dir : List.of(first, second)) {
            assertEquals(200, controller.generate(body("cli", "typescript", List.of("quality-gate", "ci"), "ledger-api",
                    dir, null), local()).getStatusCode().value());
        }
        Map<String, String> one = new TreeMap<>();
        Map<String, String> two = new TreeMap<>();
        hashes(first).forEach((k, v) -> one.put(first.relativize(Path.of(k)).toString(), v));
        hashes(second).forEach((k, v) -> two.put(second.relativize(Path.of(k)).toString(), v));
        assertFalse(one.isEmpty());
        assertEquals(one, two);
    }
}
