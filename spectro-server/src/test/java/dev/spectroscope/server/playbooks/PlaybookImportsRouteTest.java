package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.playbook.AgentFile;
import dev.spectroscope.core.playbook.Finding;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.PlaybookWriter;
import dev.spectroscope.server.settings.SkillCatalogue;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Supplier;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 523: the routes that assemble a playbook bundle from what the machine already has. Skills
 * from the installed roots and the catalogue, the hooks of the user settings, agents and commands
 * from a template, and the removal of an entry. Driven directly with mock requests, like
 * {@link PlaybookFilesRouteTest}.
 */
class PlaybookImportsRouteTest {

    @TempDir Path tmp;

    private final ObjectMapper mapper = new ObjectMapper();
    private PlaybookFolders folders;
    private PlaybookController controller;
    private Path dir;
    private Path home;
    private Path spectroHome;
    private Path userSettings;
    private Path launch;

    @BeforeEach
    void setUp() throws IOException {
        folders = new PlaybookFolders(tmp.resolve("playbooks.json"));
        home = Files.createDirectories(tmp.resolve("home"));
        spectroHome = Files.createDirectories(home.resolve(".spectro"));
        userSettings = spectroHome.resolve("settings.json");
        launch = Files.createDirectories(tmp.resolve("launch"));
        controller = new PlaybookController(folders, PlaybookController.BUNDLE_ROOT,
                new InstallLedger(tmp.resolve("ledger/playbook-installs.json")), spectroHome, launch, userSettings);
        dir = Files.createDirectories(tmp.resolve("pb"));
        Files.writeString(dir.resolve("playbook.json"), PlaybookLoaderTest.MINIMAL);
        write(dir, "skills/spectropowers/brainstorming/SKILL.md", "---\nname: brainstorming\ndescription: d\n---\nbody\n");
        write(dir, "templates/spec.md", "# Goal\n");
        write(dir, "LICENSE", "MIT\n");
        write(dir, "PROVENANCE.md", "# Provenance\n\nmade here\n");
        folders.register(dir);
    }

    // ---- fixtures ------------------------------------------------------------------------------

    private static Path write(Path base, String rel, String text) throws IOException {
        Path file = base.resolve(rel);
        Files.createDirectories(file.getParent());
        return Files.writeString(file, text);
    }

    private Path userSkill(String rel, String name) throws IOException {
        return write(spectroHome.resolve("skills"), rel + "/SKILL.md",
                "---\nname: " + name + "\ndescription: the " + name + " skill\n---\nDo " + name + ".\n").getParent();
    }

    private Path projectSkill(String rel, String name) throws IOException {
        return write(launch.resolve(".spectro/skills"), rel + "/SKILL.md",
                "---\nname: " + name + "\ndescription: the " + name + " skill\n---\nDo " + name + ".\n").getParent();
    }

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    private static MockHttpServletRequest foreign() {
        MockHttpServletRequest remote = new MockHttpServletRequest();
        remote.setRemoteAddr("203.0.113.7");
        return remote;
    }

    private static MockHttpServletRequest crossSite() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("Origin", "http://evil.example");
        return request;
    }

    private JsonNode json(ResponseEntity<?> response) {
        return mapper.valueToTree(response.getBody());
    }

    private ObjectNode body() {
        return mapper.createObjectNode().put("dir", dir.toString());
    }

    private ObjectNode installedItem(String pack, String name) {
        ObjectNode item = mapper.createObjectNode().put("source", "installed");
        if (pack != null) {
            item.put("pack", pack);
        }
        if (name != null) {
            item.put("name", name);
        }
        return item;
    }

    private ResponseEntity<?> importSkills(ObjectNode... items) {
        ObjectNode body = body();
        ArrayNode list = body.putArray("items");
        for (ObjectNode item : items) {
            list.add(item);
        }
        return controller.importSkills(body, local());
    }

    private Playbook playbook() throws IOException {
        Playbook p = PlaybookReader.read(Files.readString(dir.resolve("playbook.json"))).playbook();
        assertNotNull(p, "the playbook still reads");
        return p;
    }

    private byte[] playbookBytes() throws IOException {
        return Files.readAllBytes(dir.resolve("playbook.json"));
    }

    /** Every file below the playbook folder with its bytes, for "nothing was written". */
    private Map<String, String> snapshot() throws IOException {
        Map<String, String> out = new TreeMap<>();
        try (Stream<Path> walk = Files.walk(dir)) {
            for (Path p : walk.toList()) {
                String rel = dir.relativize(p).toString();
                if (Files.isSymbolicLink(p)) {
                    out.put(rel, "link");
                } else if (Files.isDirectory(p)) {
                    out.put(rel + "/", "dir");
                } else {
                    out.put(rel, EditorView.sha256(Files.readAllBytes(p)));
                }
            }
        }
        return out;
    }

    /** AC6: the entry has no folder finding and the install preview lists it with a hash. */
    private void assertClean(String kind, String entry, String itemKind) throws IOException {
        Playbook p = playbook();
        List<String> listed = switch (kind) {
            case "skills" -> p.contents().skills();
            case "agents" -> p.contents().agents();
            case "hooks" -> p.contents().hooks();
            case "commands" -> p.contents().commands();
            default -> p.contents().workflows();
        };
        assertTrue(listed.contains(entry), kind + " lists " + entry + ": " + listed);
        int index = listed.indexOf(entry);
        List<Finding> folder = PlaybookLoader.contentsFindings(dir.toRealPath(), p.contents());
        assertTrue(folder.stream().noneMatch(f -> f.path().equals("contents." + kind + "[" + index + "]")),
                "no folder finding for " + entry + ": " + folder);
        ResponseEntity<?> preview = controller.contents(dir.toString(), null, local());
        assertEquals(200, preview.getStatusCode().value());
        PlaybookContents.Preview shown = (PlaybookContents.Preview) preview.getBody();
        assertEquals(List.of(), shown.findings().stream()
                .filter(f -> f.path().startsWith(entry)).toList(), "no preview finding under " + entry);
        assertTrue(shown.items().stream().anyMatch(i -> i.kind().equals(itemKind) && i.source().startsWith(entry)
                        && i.sha256() != null && i.sha256().length() == 64),
                "the preview lists a " + itemKind + " from " + entry + " with its hash: " + shown.items());
    }

    /** AC6 after a removal: no folder finding at all, and the preview shows nothing from the entry. */
    private void assertRemovedClean(String entry) throws IOException {
        Playbook p = playbook();
        assertEquals(List.of(), PlaybookLoader.contentsFindings(dir.toRealPath(), p.contents()), "no folder finding");
        ResponseEntity<?> preview = controller.contents(dir.toString(), null, local());
        assertEquals(200, preview.getStatusCode().value());
        PlaybookContents.Preview shown = (PlaybookContents.Preview) preview.getBody();
        assertEquals(List.of(), shown.findings(), "no preview finding");
        assertTrue(shown.items().stream().noneMatch(i -> i.source().startsWith(entry)),
                "the preview lists nothing from " + entry + ": " + shown.items());
    }

    /** The file is written in the one canonical form. */
    private void assertCanonical() throws IOException {
        String text = Files.readString(dir.resolve("playbook.json"));
        assertEquals(PlaybookWriter.write(PlaybookReader.read(text).playbook()), text);
    }

    // ---- AC1: the sources ----------------------------------------------------------------------

    @Test
    void importSourcesListsInstalledSkillsByRootAndPack() throws IOException {
        userSkill("humanizer", "humanizer");
        userSkill("mypack/alpha", "alpha");
        projectSkill("beta", "beta");

        ResponseEntity<?> answer = controller.importSources(dir.toString(), null, local());

        assertEquals(200, answer.getStatusCode().value());
        JsonNode installed = json(answer).path("installed");
        List<String> rows = new ArrayList<>();
        installed.forEach(r -> rows.add(r.path("root").asText() + " " + r.path("pack").asText("-") + " "
                + r.path("name").asText() + " " + r.path("inPlaybook").asBoolean()));
        assertTrue(rows.contains("user - humanizer false"), rows.toString());
        assertTrue(rows.contains("user mypack alpha false"), rows.toString());
        assertTrue(rows.contains("project - beta false"), rows.toString());
    }

    @Test
    void importSourcesMarksASkillAlreadyInThePlaybook() throws IOException {
        userSkill("humanizer", "humanizer");
        assertEquals(200, importSkills(installedItem(null, "humanizer")).getStatusCode().value());

        JsonNode installed = json(controller.importSources(dir.toString(), null, local())).path("installed");

        boolean marked = false;
        for (JsonNode r : installed) {
            if (r.path("name").asText().equals("humanizer")) {
                marked = r.path("inPlaybook").asBoolean();
            }
        }
        assertTrue(marked, installed.toString());
    }

    @Test
    void importSourcesListsCatalogueSkillsById() {
        assumeTrue(!SkillCatalogue.index().isEmpty(), "the catalogue rides on the test classpath");

        JsonNode catalogue = json(controller.importSources(dir.toString(), null, local())).path("catalogue");

        assertEquals(SkillCatalogue.index().size(), catalogue.size());
        for (JsonNode row : catalogue) {
            assertEquals(row.path("pack").asText() + "/" + row.path("name").asText(), row.path("id").asText());
            assertFalse(row.has("dir"), "the catalogue's own folder is not echoed");
        }
    }

    @Test
    void importSourcesListsTheSettingsHooks() throws IOException {
        Files.writeString(userSettings, """
                { "hooks": [
                  { "event": "pre_tool_use", "matcher": "run_command", "command": "bash %s/guard.sh", "timeoutSeconds": 5 },
                  { "event": "post_tool_use", "command": "echo done" } ] }
                """.formatted(spectroHome.resolve("hooks")));

        JsonNode hooks = json(controller.importSources(dir.toString(), null, local())).path("hooks");

        assertEquals(2, hooks.size(), hooks.toString());
        assertEquals("pre_tool_use", hooks.get(0).path("event").asText());
        assertEquals("run_command", hooks.get(0).path("matcher").asText());
        assertEquals("bash ~/.spectro/hooks/guard.sh", hooks.get(0).path("command").asText());
        assertEquals("echo done", hooks.get(1).path("command").asText());
    }

    @Test
    void importSourcesEchoesNoPathOfTheMachine() throws IOException {
        userSkill("humanizer", "humanizer");
        projectSkill("beta", "beta");
        Files.writeString(userSettings, """
                { "hooks": [ { "event": "pre_tool_use", "command": "bash %s/guard.sh" },
                             { "event": "post_tool_use", "command": "bash %s/after.sh" },
                             { "event": "post_tool_use", "command": "echo --log=%s/log.txt" } ] }
                """.formatted(launch.resolve("scripts"), spectroHome.resolve("hooks"), home));

        String text = mapper.writeValueAsString(controller.importSources(dir.toString(), null, local()).getBody());

        assertFalse(text.contains(tmp.toString()), text);
        assertFalse(text.contains(tmp.toRealPath().toString()), text);
        assertTrue(text.contains("humanizer"), "positive: the listing is not empty: " + text);
    }

    // ---- AC2: importing skills -----------------------------------------------------------------

    @Test
    void importingAFlatInstalledSkillCopiesItIntoTheImportedPack() throws IOException {
        Path source = userSkill("humanizer", "humanizer");
        write(source, "LICENSE", "MIT humanizer\n");
        write(source, "refs/notes.md", "notes\n");

        ResponseEntity<?> answer = importSkills(installedItem(null, "humanizer"));

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        Path copy = dir.resolve("skills/imported/humanizer");
        assertArrayEquals(Files.readAllBytes(source.resolve("SKILL.md")), Files.readAllBytes(copy.resolve("SKILL.md")));
        assertEquals("MIT humanizer\n", Files.readString(copy.resolve("LICENSE")));
        assertEquals("notes\n", Files.readString(copy.resolve("refs/notes.md")));
        assertTrue(playbook().contents().skills().contains("skills/imported"));
        assertTrue(Files.readString(dir.resolve("PROVENANCE.md")).contains("skills/imported/humanizer"));
        assertTrue(Files.readString(dir.resolve("PROVENANCE.md")).startsWith("# Provenance\n\nmade here\n"),
                "the old provenance stays");
        assertCanonical();
        assertClean("skills", "skills/imported", "skill");
        assertFalse(Files.exists(dir.resolve(".import-staging")), "no staging folder stays behind");
    }

    @Test
    void importingAPackSkillKeepsItsPackName() throws IOException {
        userSkill("mypack/alpha", "alpha");
        write(spectroHome.resolve("skills/mypack"), "LICENSE", "MIT pack\n");

        ResponseEntity<?> answer = importSkills(installedItem("mypack", "alpha"));

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertTrue(Files.isRegularFile(dir.resolve("skills/mypack/alpha/SKILL.md")));
        assertEquals("MIT pack\n", Files.readString(dir.resolve("skills/mypack/alpha/LICENSE")),
                "a pack licence travels with the skill that has none of its own");
        assertTrue(playbook().contents().skills().contains("skills/mypack"));
        assertClean("skills", "skills/mypack", "skill");
    }

    @Test
    void importingAWholePackCopiesEverySkillOfIt() throws IOException {
        userSkill("mypack/alpha", "alpha");
        userSkill("mypack/gamma", "gamma");

        ResponseEntity<?> answer = importSkills(installedItem("mypack", null));

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertTrue(Files.isRegularFile(dir.resolve("skills/mypack/alpha/SKILL.md")));
        assertTrue(Files.isRegularFile(dir.resolve("skills/mypack/gamma/SKILL.md")));
        assertEquals(1, playbook().contents().skills().stream().filter("skills/mypack"::equals).count());
    }

    @Test
    void importingAProjectSkillTakesItFromTheProjectRoot() throws IOException {
        projectSkill("beta", "beta");
        write(spectroHome.resolve("skills"), "beta/SKILL.md", "---\nname: beta\ndescription: user\n---\nUser beta.\n");

        ResponseEntity<?> answer = importSkills(installedItem(null, "beta"));

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertTrue(Files.readString(dir.resolve("skills/imported/beta/SKILL.md")).contains("Do beta."),
                "without a root label the project skill wins, as the skill library ranks them");
    }

    @Test
    void aRootLabelPicksTheUserSkill() throws IOException {
        projectSkill("beta", "beta");
        write(spectroHome.resolve("skills"), "beta/SKILL.md", "---\nname: beta\ndescription: user\n---\nUser beta.\n");

        ResponseEntity<?> answer = importSkills(installedItem(null, "beta").put("root", "user"));

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertTrue(Files.readString(dir.resolve("skills/imported/beta/SKILL.md")).contains("User beta."));
    }

    @Test
    void importingACatalogueSkillLandsInImportedWithThePackLicence() throws IOException {
        assumeTrue(!SkillCatalogue.index().isEmpty(), "the catalogue rides on the test classpath");
        SkillCatalogue.Entry entry = SkillCatalogue.index().stream()
                .filter(e -> e.files() < 20).findFirst().orElseThrow();

        ResponseEntity<?> answer = importSkills(mapper.createObjectNode().put("source", "catalogue")
                .put("pack", entry.pack()).put("name", entry.name()));

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        Path copy = dir.resolve("skills/imported").resolve(entry.name());
        assertTrue(Files.isRegularFile(copy.resolve("SKILL.md")));
        assertTrue(Files.list(copy).anyMatch(p -> p.getFileName().toString().startsWith("LICENSE")),
                "the pack licence travels with the copy");
        assertTrue(Files.readString(dir.resolve("PROVENANCE.md")).contains(entry.id()));
        assertClean("skills", "skills/imported", "skill");
    }

    @Test
    void importingTheSameSkillAgainAnswersAlready() throws IOException {
        userSkill("humanizer", "humanizer");
        assertEquals(200, importSkills(installedItem(null, "humanizer")).getStatusCode().value());
        Map<String, String> before = snapshot();

        ResponseEntity<?> again = importSkills(installedItem(null, "humanizer"));

        assertEquals(200, again.getStatusCode().value(), String.valueOf(again.getBody()));
        assertEquals("humanizer", json(again).path("already").get(0).asText());
        assertEquals(0, json(again).path("imported").size());
        assertEquals(before, snapshot(), "nothing changed on disk");
    }

    @Test
    void aTargetWithOtherContentAnswers409AndCopiesNothing() throws IOException {
        userSkill("humanizer", "humanizer");
        userSkill("other", "other");
        write(dir, "skills/imported/humanizer/SKILL.md", "---\nname: humanizer\ndescription: mine\n---\nmine\n");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importSkills(installedItem(null, "other"), installedItem(null, "humanizer"));

        assertEquals(409, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("taken", json(answer).path("reason").asText());
        assertEquals(before, snapshot(), "not even the first item was copied");
    }

    @Test
    void theFileCapIsCheckedBeforeTheFirstByte() throws IOException {
        Path source = userSkill("big", "big");
        for (int i = 0; i < PlaybookLoader.MAX_FILES; i++) {
            write(source, "f/" + i + ".md", "x\n");
        }
        // An unreadable file turns a copy into a failure, so only a check before the first byte answers 413.
        assumeTrue(Files.getFileAttributeView(source, java.nio.file.attribute.PosixFileAttributeView.class) != null,
                "a POSIX file system");
        Files.setPosixFilePermissions(source.resolve("f/0.md"), java.util.Set.of());
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importSkills(installedItem(null, "big"));

        assertEquals(413, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("too-many-files", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
    }

    @Test
    void theByteCapIsCheckedBeforeTheFirstByte() throws IOException {
        Path source = userSkill("heavy", "heavy");
        try (RandomAccessFile sparse = new RandomAccessFile(source.resolve("blob.bin").toFile(), "rw")) {
            sparse.setLength(PlaybookFiles.MAX_FOLDER_BYTES + 1);
        }
        // An unreadable blob turns a copy into a failure, so only a check before the first byte answers 413.
        assumeTrue(Files.getFileAttributeView(source, java.nio.file.attribute.PosixFileAttributeView.class) != null,
                "a POSIX file system");
        Files.setPosixFilePermissions(source.resolve("blob.bin"), java.util.Set.of());
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importSkills(installedItem(null, "heavy"));

        assertEquals(413, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("folder-too-large", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
    }

    @Test
    void aPackNamedLikeThePlaybookIdIsRefused() throws IOException {
        assertEquals("p", playbook().id(), "premise: the fixture's id");
        userSkill("p/alpha", "alpha");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importSkills(installedItem("p", "alpha"));

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("pack-is-playbook-id", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
    }

    @Test
    void aSourceSkillWithASymbolicLinkIsRefusedAsAWhole() throws IOException {
        Path source = userSkill("linked", "linked");
        Path secret = write(tmp, "secret/key.txt", "secret\n");
        assumeTrue(link(source.resolve("key.txt"), secret), "the file system makes links");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importSkills(installedItem(null, "linked"));

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("link", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
        assertFalse(String.valueOf(answer.getBody()).contains(tmp.toString()), "no machine path in the refusal");
    }

    @Test
    void aSourceSkillFolderThatIsALinkIsRefused() throws IOException {
        Path real = write(tmp, "elsewhere/away/SKILL.md", "---\nname: away\ndescription: d\n---\nb\n").getParent();
        Files.createDirectories(spectroHome.resolve("skills"));
        assumeTrue(link(spectroHome.resolve("skills/away"), real), "the file system makes links");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importSkills(installedItem(null, "away"));

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("link", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
    }

    @Test
    void pathShapedNamesAreUnknownSources() throws IOException {
        userSkill("humanizer", "humanizer");
        write(tmp, "outside/SKILL.md", "---\nname: outside\ndescription: d\n---\nb\n");
        Map<String, String> before = snapshot();

        List<ObjectNode> shapes = List.of(
                installedItem(null, "../../outside"),
                installedItem("..", "outside"),
                installedItem(null, "humanizer/../humanizer"),
                installedItem(null, tmp.resolve("outside").toString()),
                installedItem(null, "humanizer").put("root", "../../"),
                mapper.createObjectNode().put("source", "catalogue").put("pack", "..").put("name", "outside"),
                mapper.createObjectNode().put("source", "elsewhere").put("name", "humanizer"));
        for (ObjectNode shape : shapes) {
            ResponseEntity<?> answer = importSkills(shape);
            assertEquals(400, answer.getStatusCode().value(), shape + " -> " + answer.getBody());
            assertEquals("unknown-source", json(answer).path("reason").asText(), shape.toString());
        }
        assertEquals(before, snapshot());
        assertEquals(200, importSkills(installedItem(null, "humanizer")).getStatusCode().value(),
                "positive: the plain name imports");
    }

    @Test
    void aStaleBaseHashAnswers409AndCopiesNothing() throws IOException {
        userSkill("humanizer", "humanizer");
        Map<String, String> before = snapshot();
        ObjectNode body = body().put("baseHash", "0".repeat(64));
        body.putArray("items").add(installedItem(null, "humanizer"));

        ResponseEntity<?> answer = controller.importSkills(body, local());

        assertEquals(409, answer.getStatusCode().value());
        assertEquals("changed", json(answer).path("reason").asText());
        assertEquals(EditorView.sha256(playbookBytes()), json(answer).path("diskHash").asText());
        assertEquals(before, snapshot());
    }

    @Test
    void aPlaybookWithAnUnknownFieldIsNotRewritten() throws IOException {
        Files.writeString(dir.resolve("playbook.json"), PlaybookLoaderTest.MINIMAL.replace(
                "\"schema_version\": 1,", "\"schema_version\": 1, \"colour\": \"blue\","));
        userSkill("humanizer", "humanizer");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importSkills(installedItem(null, "humanizer"));

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("playbook-findings", json(answer).path("reason").asText());
        assertEquals(before, snapshot(), "an unknown field would be lost by the canonical writer");
    }

    // ---- AC3: importing hooks ------------------------------------------------------------------

    private String settingsWithHooks() throws IOException {
        write(spectroHome, "hooks/guard.sh", "#!/bin/sh\necho guard\n");
        String text = """
                { "model": "qwen2.5:7b", "hooks": [
                  { "event": "pre_tool_use", "matcher": "run_command", "command": "bash %s/guard.sh --strict", "timeoutSeconds": 5 },
                  { "event": "post_tool_use", "command": "echo done" } ] }
                """.formatted(spectroHome.resolve("hooks"));
        Files.writeString(userSettings, text);
        return text;
    }

    @Test
    void importingHooksWritesHooksJsonAndCopiesTheScript() throws IOException {
        String settings = settingsWithHooks();

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        JsonNode hooks = mapper.readTree(Files.readString(dir.resolve("hooks/hooks.json")));
        assertEquals(2, hooks.size());
        assertEquals("pre_tool_use", hooks.get(0).path("event").asText());
        assertEquals("run_command", hooks.get(0).path("matcher").asText());
        assertEquals("bash {hooks}/guard.sh --strict", hooks.get(0).path("command").asText());
        assertEquals(5, hooks.get(0).path("timeoutSeconds").asInt());
        assertEquals("echo done", hooks.get(1).path("command").asText());
        assertFalse(hooks.get(1).has("matcher"), "an absent matcher stays absent");
        List<String> fields = new ArrayList<>();
        hooks.get(0).fieldNames().forEachRemaining(fields::add);
        assertEquals(List.of("event", "matcher", "command", "timeoutSeconds"), fields);
        assertEquals("#!/bin/sh\necho guard\n", Files.readString(dir.resolve("hooks/guard.sh")));
        assertEquals(List.of("hooks/hooks.json"), playbook().contents().hooks());
        assertEquals(settings, Files.readString(userSettings), "the settings file is unchanged");
        assertCanonical();
        assertClean("hooks", "hooks/hooks.json", "hook");
    }

    @Test
    void importingHooksAgainAnswers409UnlessReplace() throws IOException {
        settingsWithHooks();
        assertEquals(200, controller.importHooks(body(), local()).getStatusCode().value());
        Files.writeString(userSettings, """
                { "hooks": [ { "event": "post_tool_use", "command": "echo second" } ] }
                """);
        Map<String, String> before = snapshot();

        ResponseEntity<?> again = controller.importHooks(body(), local());

        assertEquals(409, again.getStatusCode().value(), String.valueOf(again.getBody()));
        assertEquals("exists", json(again).path("reason").asText());
        assertEquals(before, snapshot());

        ResponseEntity<?> replaced = controller.importHooks(body().put("replace", true), local());

        assertEquals(200, replaced.getStatusCode().value(), String.valueOf(replaced.getBody()));
        assertEquals("echo second", mapper.readTree(Files.readString(dir.resolve("hooks/hooks.json")))
                .get(0).path("command").asText());
        assertEquals(List.of("hooks/hooks.json"), playbook().contents().hooks(), "listed once");
    }

    @Test
    void aCommandThatNamesNoFileOfThisMachineIsWrittenAsItIs() throws IOException {
        Path outside = write(tmp, "elsewhere/run.sh", "echo outside\n");
        String command = "bash " + outside + " && /no/such/script.sh";
        Files.writeString(userSettings, mapper.createObjectNode().set("hooks", mapper.createArrayNode()
                .add(mapper.createObjectNode().put("event", "pre_tool_use").put("command", command))).toString());

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(command, mapper.readTree(Files.readString(dir.resolve("hooks/hooks.json")))
                .get(0).path("command").asText());
        assertFalse(Files.exists(dir.resolve("hooks/run.sh")), "a file outside the home and the project is not copied");
    }

    @Test
    void aLinkedScriptIsNotCopied() throws IOException {
        Path secret = write(tmp, "secret/run.sh", "echo secret\n");
        Files.createDirectories(spectroHome.resolve("hooks"));
        assumeTrue(link(spectroHome.resolve("hooks/run.sh"), secret), "the file system makes links");
        hooks("bash " + spectroHome.resolve("hooks/run.sh"), "echo done");

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertFalse(Files.exists(dir.resolve("hooks/run.sh")), "a link is never followed");
        assertEquals(List.of("echo done"), importedCommands(),
                "the hook still names a file under ~/.spectro, so it is left out");
        assertEquals(List.of("pre_tool_use ~/.spectro home-dot-folder"), left(json(answer)));
    }

    @Test
    void aHomeDotFolderLeavesTheHookOutAndAMissingScriptEndingKeepsAFileOut() throws IOException {
        write(home, ".ssh/deploy.sh", "echo key\n");
        write(home, "keys/id_rsa", "PRIVATE\n");
        write(launch, ".env", "TOKEN=x\n");
        write(spectroHome, "hooks/ok.sh", "echo ok\n");
        hooks("bash ~/.ssh/deploy.sh", "cat ~/keys/id_rsa " + launch.resolve(".env") + " && bash ~/.spectro/hooks/ok.sh");

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("hooks.json", "ok.sh"), hooksFolder(), "only the plain script under ~/.spectro is copied");
        assertEquals(List.of("cat ~/keys/id_rsa {project}/.env && bash {hooks}/ok.sh"), importedCommands());
        assertEquals(List.of("pre_tool_use ~/.ssh home-dot-folder"), left(json(answer)));
    }

    /** One pre_tool_use hook per command in the user settings. */
    private void hooks(String... commands) throws IOException {
        com.fasterxml.jackson.databind.node.ArrayNode list = mapper.createArrayNode();
        for (String command : commands) {
            list.add(mapper.createObjectNode().put("event", "pre_tool_use").put("command", command));
        }
        Files.writeString(userSettings, mapper.createObjectNode().set("hooks", list).toString());
    }

    private List<String> importedCommands() throws IOException {
        List<String> out = new ArrayList<>();
        mapper.readTree(Files.readString(dir.resolve("hooks/hooks.json"))).forEach(e -> out.add(e.path("command").asText()));
        return out;
    }

    /** The hooks an answer names as left out: event, folder and reason. */
    private static List<String> left(JsonNode answer) {
        List<String> out = new ArrayList<>();
        answer.path("left").forEach(e -> out.add(e.path("event").asText() + " " + e.path("folder").asText() + " "
                + e.path("reason").asText()));
        return out;
    }

    @Test
    void theHomeSpellingsTheTextCheckKnowsLeaveADotFolderHookOut() throws IOException {
        hooks("cat $HOME/.aws/credentials", "cat ${HOME}/.config/gh/hosts.yml", "cat " + home + "/.netrc",
                "run --key=~/.spectro/settings.json", "cat '" + home.toRealPath() + "/.docker/config.json'",
                "echo done", "cat ~/notes/.hidden.txt");

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("echo done", "cat ~/notes/.hidden.txt"), importedCommands(),
                "positive: a hook with no dot folder of the home is written, also one naming a dot file below a plain folder");
        assertEquals(List.of("pre_tool_use ~/.aws home-dot-folder", "pre_tool_use ~/.config home-dot-folder",
                "pre_tool_use ~/.netrc home-dot-folder", "pre_tool_use ~/.spectro home-dot-folder",
                "pre_tool_use ~/.docker home-dot-folder"), left(json(answer)));
        String text = mapper.writeValueAsString(answer.getBody());
        assertFalse(text.contains(tmp.toString()) || text.contains(tmp.toRealPath().toString()), text);
    }

    @Test
    void everyHookLeftOutWritesNothingAndSaysWhy() throws IOException {
        write(home, ".ssh/x.sh", "echo key\n");
        hooks("bash ~/.ssh/x.sh");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("all-left-out", json(answer).path("reason").asText());
        assertEquals(List.of("pre_tool_use ~/.ssh home-dot-folder"), left(json(answer)));
        assertTrue(json(answer).path("message").asText().contains("~/.ssh"), String.valueOf(answer.getBody()));
        assertEquals(before, snapshot());
    }

    @Test
    void theListingMarksTheHooksTheImportLeavesOut() throws IOException {
        hooks("bash ~/.ssh/x.sh", "echo done");

        JsonNode rows = json(controller.importSources(dir.toString(), null, local())).path("hooks");

        assertEquals("home-dot-folder", rows.get(0).path("left").asText(), rows.toString());
        assertTrue(rows.get(1).path("left").isNull(), rows.toString());
    }

    @Test
    void aProjectPathIsWrittenWithTheProjectPlaceholderAndNotCopied() throws IOException {
        write(launch, "scripts/check.sh", "echo check\n");
        hooks(launch.resolve("scripts/check.sh") + " --conf=\"" + launch + "/conf.yml\"",
                "bash " + launch.toRealPath().resolve("scripts/check.sh"));

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("{project}/scripts/check.sh --conf=\"{project}/conf.yml\"", "bash {project}/scripts/check.sh"),
                importedCommands());
        assertEquals(List.of("hooks.json"), hooksFolder(), "a project script stays in the project");
        JsonNode rows = json(controller.importSources(dir.toString(), null, local())).path("hooks");
        assertEquals(importedCommands().get(0), rows.get(0).path("command").asText(), "the listing shows what hooks.json holds");
    }

    @Test
    void aWorkspaceTheRequestNamesIsTheProjectAndAnUnusableOneIsNot() throws IOException {
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        hooks("bash " + ws + "/run.sh && cat " + launch + "/x");

        ResponseEntity<?> answer = controller.importHooks(body().put("workspace", ws.toString()), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("bash {project}/run.sh && cat " + launch + "/x", importedCommand());
        assertEquals(importedCommand(), json(controller.importSources(dir.toString(), ws.toString(), local()))
                .path("hooks").get(0).path("command").asText());

        ResponseEntity<?> fallback = controller.importHooks(body().put("workspace", "relative/ws").put("replace", true), local());

        assertEquals(200, fallback.getStatusCode().value(), String.valueOf(fallback.getBody()));
        assertEquals("bash " + ws + "/run.sh && cat {project}/x", importedCommand(),
                "a workspace that is not an absolute folder leaves the launch folder as the project");
    }

    @Test
    void noSettingsHooksWriteNothing() throws IOException {
        Files.writeString(userSettings, "{ \"model\": \"x\" }");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("no-hooks", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
    }

    // ---- AC4: agents and commands --------------------------------------------------------------

    @Test
    void newAgentWritesTheTemplateAndListsIt() throws IOException {
        ResponseEntity<?> answer = controller.newAgent(body().put("name", "reviewer").put("type", "worker")
                .put("skill", "spectropowers:brainstorming"), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        String text = Files.readString(dir.resolve("agents/reviewer.md"));
        AgentFile.Read read = AgentFile.read(text, "agents/reviewer.md");
        assertEquals(List.of(), read.findings());
        assertEquals("worker", read.agent().type());
        assertEquals("spectropowers:brainstorming", read.agent().skill());
        assertEquals(List.of("agents/reviewer.md"), playbook().contents().agents());
        assertCanonical();
        assertClean("agents", "agents/reviewer.md", "agent");
    }

    @Test
    void newAgentRefusesABadNameAnExistingOneAndAnUnknownType() throws IOException {
        assertEquals(200, controller.newAgent(body().put("name", "reviewer").put("type", "worker"), local())
                .getStatusCode().value());
        Map<String, String> before = snapshot();

        for (String name : List.of("reviewer", "../evil", "a/b", "-dash", "", "x.y")) {
            ResponseEntity<?> answer = controller.newAgent(body().put("name", name).put("type", "worker"), local());
            assertEquals(409, answer.getStatusCode().value(), name + " -> " + answer.getBody());
            assertEquals(name.equals("reviewer") ? "exists" : "name", json(answer).path("reason").asText(), name);
        }
        ResponseEntity<?> type = controller.newAgent(body().put("name", "other").put("type", "boss"), local());
        assertEquals(400, type.getStatusCode().value(), String.valueOf(type.getBody()));
        ResponseEntity<?> skill = controller.newAgent(body().put("name", "other").put("type", "worker")
                .put("skill", "a\nbelt: all"), local());
        assertEquals(400, skill.getStatusCode().value(), String.valueOf(skill.getBody()));
        assertEquals(before, snapshot());
    }

    @Test
    void newCommandWritesTheTemplateAndListsIt() throws IOException {
        ResponseEntity<?> answer = controller.newCommand(body().put("name", "ship"), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertTrue(Files.isRegularFile(dir.resolve("commands/ship.md")));
        assertEquals(List.of("commands/ship.md"), playbook().contents().commands());
        assertCanonical();
        assertClean("commands", "commands/ship.md", "command");
    }

    @Test
    void newCommandRefusesABadNameAndAnExistingOne() throws IOException {
        assertEquals(200, controller.newCommand(body().put("name", "ship"), local()).getStatusCode().value());
        Map<String, String> before = snapshot();

        for (String name : List.of("ship", "..", "a/b", "_x", "")) {
            ResponseEntity<?> answer = controller.newCommand(body().put("name", name), local());
            assertEquals(409, answer.getStatusCode().value(), name + " -> " + answer.getBody());
            assertEquals(name.equals("ship") ? "exists" : "name", json(answer).path("reason").asText(), name);
        }
        assertEquals(before, snapshot());
    }

    // ---- AC5: removing an entry ----------------------------------------------------------------

    @Test
    void removeContentDropsTheEntryAndItsFiles() throws IOException {
        userSkill("humanizer", "humanizer");
        importSkills(installedItem(null, "humanizer"));
        controller.newAgent(body().put("name", "reviewer").put("type", "worker"), local());
        settingsWithHooks();
        controller.importHooks(body(), local());
        assertTrue(Files.exists(dir.resolve("hooks/guard.sh")), "premise: the script was copied");

        ResponseEntity<?> skill = controller.removeContent(body().put("kind", "skills").put("path", "skills/imported"), local());
        ResponseEntity<?> agent = controller.removeContent(body().put("kind", "agents").put("path", "agents/reviewer.md"), local());
        ResponseEntity<?> hooks = controller.removeContent(body().put("kind", "hooks").put("path", "hooks/hooks.json"), local());

        assertEquals(200, skill.getStatusCode().value(), String.valueOf(skill.getBody()));
        assertEquals(200, agent.getStatusCode().value(), String.valueOf(agent.getBody()));
        assertEquals(200, hooks.getStatusCode().value(), String.valueOf(hooks.getBody()));
        assertFalse(Files.exists(dir.resolve("skills/imported")));
        assertFalse(Files.exists(dir.resolve("agents/reviewer.md")));
        assertFalse(Files.exists(dir.resolve("hooks/hooks.json")));
        assertFalse(Files.exists(dir.resolve("hooks/guard.sh")), "the script the hooks named goes with them");
        Playbook p = playbook();
        assertEquals(List.of("skills/spectropowers"), p.contents().skills());
        assertEquals(List.of(), p.contents().agents());
        assertEquals(List.of(), p.contents().hooks());
        assertTrue(Files.isRegularFile(dir.resolve("skills/spectropowers/brainstorming/SKILL.md")), "the other pack stays");
        assertTrue(Files.isRegularFile(dir.resolve("playbook.json")));
        assertFalse(Files.exists(dir.resolve("hooks")), "the emptied hooks folder goes too");
        assertCanonical();
        assertRemovedClean("skills/imported");
        assertRemovedClean("agents/reviewer.md");
        assertRemovedClean("hooks/hooks.json");
    }

    @Test
    void removeContentDropsACommandEntry() throws IOException {
        assertEquals(200, controller.newCommand(body().put("name", "ship"), local()).getStatusCode().value());
        assertEquals(200, controller.newCommand(body().put("name", "keep"), local()).getStatusCode().value());

        ResponseEntity<?> answer = controller.removeContent(body().put("kind", "commands").put("path", "commands/ship.md"), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("commands/ship.md", json(answer).path("removed").get(0).asText());
        assertFalse(Files.exists(dir.resolve("commands/ship.md")));
        assertTrue(Files.isRegularFile(dir.resolve("commands/keep.md")), "the other command stays");
        assertEquals(List.of("commands/keep.md"), playbook().contents().commands());
        assertCanonical();
        assertRemovedClean("commands/ship.md");
        assertClean("commands", "commands/keep.md", "command");
    }

    @Test
    void removeContentNeverLeavesTheKindsFolder() throws IOException {
        Files.writeString(dir.resolve("playbook.json"), PlaybookLoaderTest.MINIMAL.replace(
                "\"contents\": { \"skills\": [\"skills/spectropowers\"] }",
                "\"contents\": { \"skills\": [\"skills/spectropowers\"], \"workflows\": [\"workflows/..\"] }"));
        Map<String, String> before = snapshot();

        List<String[]> attempts = List.of(
                new String[] {"workflows", "workflows/.."},
                new String[] {"skills", "skills/.."},
                new String[] {"skills", "playbook.json"},
                new String[] {"hooks", "playbook.json"},
                new String[] {"agents", "../outside.md"},
                new String[] {"skills", "/etc"},
                new String[] {"settings", "skills/spectropowers"},
                new String[] {"agents", "agents/nobody.md"});
        for (String[] attempt : attempts) {
            ResponseEntity<?> answer = controller.removeContent(body().put("kind", attempt[0]).put("path", attempt[1]), local());
            assertEquals(400, answer.getStatusCode().value(), String.join(" ", attempt) + " -> " + answer.getBody());
        }
        assertEquals(before, snapshot());
    }

    @Test
    void removeContentRefusesALinkedPackAndLeavesItsTarget() throws IOException {
        Path outside = write(tmp, "outside/keep/SKILL.md", "---\nname: keep\ndescription: d\n---\nb\n").getParent().getParent();
        assumeTrue(link(dir.resolve("skills/linked"), outside), "the file system makes links");
        Files.writeString(dir.resolve("playbook.json"), PlaybookLoaderTest.MINIMAL.replace(
                "\"skills\": [\"skills/spectropowers\"] }", "\"skills\": [\"skills/spectropowers\", \"skills/linked\"] }"));

        ResponseEntity<?> answer = controller.removeContent(body().put("kind", "skills").put("path", "skills/linked"), local());

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("link", json(answer).path("reason").asText());
        assertTrue(Files.isRegularFile(outside.resolve("keep/SKILL.md")), "the target of the link stays");
        assertTrue(Files.isSymbolicLink(dir.resolve("skills/linked")));
    }

    // ---- the fence -----------------------------------------------------------------------------

    @Test
    void aForeignCallerAndAForeignOriginGetABlank404OnEveryRoute() throws IOException {
        userSkill("humanizer", "humanizer");
        settingsWithHooks();
        Map<String, String> before = snapshot();
        ObjectNode skills = body();
        skills.putArray("items").add(installedItem(null, "humanizer"));
        for (Supplier<MockHttpServletRequest> who : List.<Supplier<MockHttpServletRequest>>of(
                PlaybookImportsRouteTest::foreign, PlaybookImportsRouteTest::crossSite)) {
            List<ResponseEntity<?>> answers = List.of(
                    controller.importSources(dir.toString(), null, who.get()),
                    controller.importSkills(skills, who.get()),
                    controller.importHooks(body(), who.get()),
                    controller.newAgent(body().put("name", "r").put("type", "worker"), who.get()),
                    controller.newCommand(body().put("name", "c"), who.get()),
                    controller.removeContent(body().put("kind", "skills").put("path", "skills/spectropowers"), who.get()));
            for (ResponseEntity<?> answer : answers) {
                assertEquals(404, answer.getStatusCode().value());
                assertNull(answer.getBody());
            }
        }
        assertEquals(before, snapshot());
        assertEquals(200, controller.importSources(dir.toString(), null, local()).getStatusCode().value(),
                "positive: a local caller is served");
    }

    @Test
    void anUnregisteredFolderIsABlank404() throws IOException {
        Path other = Files.createDirectories(tmp.resolve("other"));
        Files.writeString(other.resolve("playbook.json"), PlaybookLoaderTest.MINIMAL);
        ObjectNode body = mapper.createObjectNode().put("dir", other.toString()).put("name", "c");

        assertEquals(404, controller.importSources(other.toString(), null, local()).getStatusCode().value());
        assertEquals(404, controller.newCommand(body, local()).getStatusCode().value());
        assertFalse(Files.exists(other.resolve("commands")));
    }

    // ---- the scenario --------------------------------------------------------------------------

    @Test
    void assemblingABundleFromTheSpectroPack() throws IOException {
        Path target = Files.createDirectories(tmp.resolve("work/bundle"));
        ResponseEntity<?> copied = controller.copy("spectro", mapper.createObjectNode().put("dir", target.toString()), local());
        assertEquals(200, copied.getStatusCode().value(), String.valueOf(copied.getBody()));
        dir = target.toRealPath();
        userSkill("humanizer", "humanizer");
        String settings = settingsWithHooks();

        assertEquals(200, importSkills(installedItem(null, "humanizer")).getStatusCode().value());
        assertTrue(Files.isRegularFile(dir.resolve("skills/imported/humanizer/SKILL.md")));
        assertTrue(playbook().contents().skills().contains("skills/imported"));

        assertEquals(200, controller.importHooks(body(), local()).getStatusCode().value());
        assertEquals(2, mapper.readTree(Files.readString(dir.resolve("hooks/hooks.json"))).size());
        assertEquals(settings, Files.readString(userSettings));

        assertEquals(200, controller.newAgent(body().put("name", "reviewer").put("type", "worker"), local())
                .getStatusCode().value());
        assertTrue(Files.isRegularFile(dir.resolve("agents/reviewer.md")));
        assertTrue(playbook().contents().agents().contains("agents/reviewer.md"));

        assertClean("skills", "skills/imported", "skill");
        assertClean("hooks", "hooks/hooks.json", "hook");
        assertClean("agents", "agents/reviewer.md", "agent");
        assertCanonical();
    }

    // ---- fix round: the scope of a hook script -------------------------------------------------

    private PlaybookController launchedIn(Path launchDir) {
        return new PlaybookController(folders, PlaybookController.BUNDLE_ROOT,
                new InstallLedger(tmp.resolve("ledger/playbook-installs.json")), spectroHome, launchDir, userSettings);
    }

    private void hook(String command) throws IOException {
        Files.writeString(userSettings, mapper.createObjectNode().set("hooks", mapper.createArrayNode()
                .add(mapper.createObjectNode().put("event", "pre_tool_use").put("command", command))).toString());
    }

    private List<String> hooksFolder() throws IOException {
        try (Stream<Path> listed = Files.list(dir.resolve("hooks"))) {
            return listed.map(p -> p.getFileName().toString()).sorted().toList();
        }
    }

    private String importedCommand() throws IOException {
        return mapper.readTree(Files.readString(dir.resolve("hooks/hooks.json"))).get(0).path("command").asText();
    }

    @Test
    void aLaunchFolderThatIsTheHomeIsNoProjectScope() throws IOException {
        write(home, "tools/check.sh", "echo check\n");
        write(spectroHome, "hooks/ok.sh", "echo ok\n");
        hook("bash ~/tools/check.sh ~/.spectro/hooks/ok.sh");
        PlaybookController fromHome = launchedIn(home);

        ResponseEntity<?> answer = fromHome.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("check.sh", "hooks.json", "ok.sh"), hooksFolder(),
                "a home script and a spectro home script are copied");
        assertEquals("bash {hooks}/check.sh {hooks}/ok.sh", importedCommand());
        assertEquals("bash ~/tools/check.sh ~/.spectro/hooks/ok.sh",
                json(fromHome.importSources(dir.toString(), null, local())).path("hooks").get(0).path("command").asText(),
                "the home is shown as ~, not as the project");
    }

    @Test
    void aLaunchFolderAtTheFilesystemRootIsNoProjectScope() throws IOException {
        Path outside = write(tmp, "elsewhere/run.sh", "echo outside\n");
        write(spectroHome, "hooks/ok.sh", "echo ok\n");
        String command = "bash " + outside + " ~/.spectro/hooks/ok.sh";
        hook(command);
        Path rootFolder = outside.getRoot();
        PlaybookController fromRoot = launchedIn(rootFolder);

        ResponseEntity<?> answer = fromRoot.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("hooks.json", "ok.sh"), hooksFolder(), "a file outside the home is not copied");
        assertEquals("bash " + outside + " {hooks}/ok.sh", importedCommand());
        assertFalse(json(fromRoot.importSources(dir.toString(), null, local())).path("hooks").get(0).path("command").asText()
                .contains("{project}"), "the root is not written as the project");
    }

    @Test
    void aScriptWhoseOwnNameStartsWithADotIsNotCopied() throws IOException {
        write(home, "tools/.env.sh", "TOKEN=x\n");
        write(launch, ".secret.sh", "TOKEN=y\n");
        write(spectroHome, "hooks/ok.sh", "echo ok\n");
        String command = "bash ~/tools/.env.sh " + launch.resolve(".secret.sh") + " ~/.spectro/hooks/ok.sh";
        hook(command);

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("hooks.json", "ok.sh"), hooksFolder());
        assertEquals("bash ~/tools/.env.sh {project}/.secret.sh {hooks}/ok.sh", importedCommand());
    }

    @Test
    void aProjectUnderTheHomeIsWrittenAsTheProjectAlsoInItsOwnDotFolders() throws IOException {
        Path project = Files.createDirectories(home.resolve("work"));
        write(project, ".config/x.sh", "echo key\n");
        write(project, "scripts/check.sh", "echo check\n");
        hook("bash ~/work/.config/x.sh ~/work/scripts/check.sh " + project.resolve("notes.txt"));

        ResponseEntity<?> answer = launchedIn(project).importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("hooks.json"), hooksFolder(), "nothing of the project is copied");
        assertEquals("bash {project}/.config/x.sh {project}/scripts/check.sh {project}/notes.txt", importedCommand());
    }

    // ---- fix round: the refusals of import-hooks -----------------------------------------------

    @Test
    void aHookScriptThatIsNotTextAnswers415() throws IOException {
        Path script = spectroHome.resolve("hooks/bin.sh");
        Files.createDirectories(script.getParent());
        Files.write(script, new byte[] {'e', 'c', 0, 'h', 'o'});
        hook("bash ~/.spectro/hooks/bin.sh");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(415, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("script-not-text", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
        Files.writeString(script, "echo text\n");
        assertEquals(200, controller.importHooks(body(), local()).getStatusCode().value(), "positive: text is copied");
        assertEquals("echo text\n", Files.readString(dir.resolve("hooks/bin.sh")));
    }

    @Test
    void twoDifferentScriptsOfOneNameAnswer409() throws IOException {
        write(spectroHome, "hooks/run.sh", "echo one\n");
        Path second = write(home, "tools/run.sh", "echo two\n");
        hook("bash ~/.spectro/hooks/run.sh ~/tools/run.sh");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(409, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("script-name", json(answer).path("reason").asText());
        assertTrue(json(answer).path("message").asText().contains("run.sh"));
        assertEquals(before, snapshot());
        Files.writeString(second, "echo one\n");
        assertEquals(200, controller.importHooks(body(), local()).getStatusCode().value(),
                "positive: two copies of the same text are one script");
        assertEquals("bash {hooks}/run.sh {hooks}/run.sh", importedCommand());
    }

    @Test
    void aScriptNameTheFolderDoesNotTakeAnswers409AndNamesIt() throws IOException {
        write(home, "tools/_x.sh", "echo x\n");
        hook("bash ~/tools/_x.sh");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(409, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("script-name", json(answer).path("reason").asText());
        assertTrue(json(answer).path("message").asText().contains("_x.sh"), String.valueOf(answer.getBody()));
        assertEquals(before, snapshot());
        write(home, "tools/x.sh", "echo x\n");
        hook("bash ~/tools/x.sh");
        assertEquals(200, controller.importHooks(body(), local()).getStatusCode().value(), "positive: a plain name is copied");
    }

    @Test
    void anotherScriptOfTheSameNameInThePlaybookAnswers409UnlessReplace() throws IOException {
        settingsWithHooks();
        write(dir, "hooks/guard.sh", "echo mine\n");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(409, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("exists", json(answer).path("reason").asText());
        assertTrue(json(answer).path("message").asText().contains("hooks/guard.sh"), String.valueOf(answer.getBody()));
        assertEquals(before, snapshot());

        ResponseEntity<?> replaced = controller.importHooks(body().put("replace", true), local());

        assertEquals(200, replaced.getStatusCode().value(), String.valueOf(replaced.getBody()));
        assertEquals("#!/bin/sh\necho guard\n", Files.readString(dir.resolve("hooks/guard.sh")));
    }

    // ---- fix round: the refusals of import-skills ----------------------------------------------

    @Test
    void aSkillMdThatNamesAnotherSkillAnswersName() throws IOException {
        userSkill("humanizer", "someone-else");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importSkills(installedItem(null, "humanizer"));

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("name", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
        userSkill("humanizer", "humanizer");
        assertEquals(200, importSkills(installedItem(null, "humanizer")).getStatusCode().value(),
                "positive: a SKILL.md that names its folder is imported");
    }

    @Test
    void aMissingOrUnreadablePlaybookJsonIsRefused() throws IOException {
        userSkill("humanizer", "humanizer");
        byte[] good = playbookBytes();
        Path file = dir.resolve("playbook.json");

        Files.delete(file);
        Map<String, String> absent = snapshot();
        ResponseEntity<?> missing = importSkills(installedItem(null, "humanizer"));
        assertEquals(400, missing.getStatusCode().value(), String.valueOf(missing.getBody()));
        assertEquals("playbook-unreadable", json(missing).path("reason").asText());
        assertEquals(absent, snapshot());

        String padded = new String(good, StandardCharsets.UTF_8) + " ".repeat((int) PlaybookLoader.MAX_BYTES);
        Files.writeString(file, padded);
        assertNotNull(PlaybookReader.read(padded).playbook(), "premise: the padded file reads as a playbook");
        Map<String, String> large = snapshot();
        ResponseEntity<?> tooLarge = importSkills(installedItem(null, "humanizer"));
        assertEquals(400, tooLarge.getStatusCode().value(), String.valueOf(tooLarge.getBody()));
        assertEquals("playbook-unreadable", json(tooLarge).path("reason").asText());
        assertEquals(large, snapshot());

        Files.writeString(file, "{ not a playbook");
        Map<String, String> broken = snapshot();
        ResponseEntity<?> unreadable = importSkills(installedItem(null, "humanizer"));
        assertEquals(400, unreadable.getStatusCode().value(), String.valueOf(unreadable.getBody()));
        assertEquals("playbook-unreadable", json(unreadable).path("reason").asText());
        assertEquals(broken, snapshot());

        Files.write(file, good);
        assertEquals(200, importSkills(installedItem(null, "humanizer")).getStatusCode().value(),
                "positive: the plain import still works");
    }

    @Test
    void importSkillsWithoutItemsIsABadRequest() throws IOException {
        Map<String, String> before = snapshot();
        for (ObjectNode request : List.of(body(), body().put("items", "humanizer"), body().set("items", mapper.createArrayNode()))) {
            ResponseEntity<?> answer = controller.importSkills(request, local());
            assertEquals(400, answer.getStatusCode().value(), request + " -> " + answer.getBody());
            assertEquals("bad-request", json(answer).path("reason").asText(), request.toString());
        }
        assertEquals(before, snapshot());
    }

    @Test
    void twoItemsForOneTargetWithOtherContentAnswer409() throws IOException {
        assumeTrue(!SkillCatalogue.index().isEmpty(), "the catalogue rides on the test classpath");
        SkillCatalogue.Entry entry = SkillCatalogue.index().stream()
                .filter(e -> e.files() < 20).findFirst().orElseThrow();
        userSkill(entry.name(), entry.name());
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importSkills(
                mapper.createObjectNode().put("source", "catalogue").put("pack", entry.pack()).put("name", entry.name()),
                installedItem(null, entry.name()));

        assertEquals(409, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("taken", json(answer).path("reason").asText());
        assertEquals(before, snapshot(), "neither item was copied");
    }

    @Test
    void theSameSkillNamedTwiceIsImportedOnce() throws IOException {
        userSkill("humanizer", "humanizer");

        ResponseEntity<?> answer = importSkills(installedItem(null, "humanizer"), installedItem(null, "humanizer"));

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(1, json(answer).path("imported").size());
        assertEquals(0, json(answer).path("already").size());
        assertTrue(Files.isRegularFile(dir.resolve("skills/imported/humanizer/SKILL.md")));
    }

    // ---- fix round: a failure takes everything back --------------------------------------------

    private PlaybookImports failingMidway() {
        return new PlaybookImports(spectroHome, launch.resolve(".spectro/skills"), launch, userSettings)
                .midway(() -> {
                    throw new IOException("injected");
                });
    }

    @Test
    void aFailureMidwayTakesBackARemoval() throws IOException {
        userSkill("humanizer", "humanizer");
        assertEquals(200, importSkills(installedItem(null, "humanizer")).getStatusCode().value());
        settingsWithHooks();
        assertEquals(200, controller.importHooks(body(), local()).getStatusCode().value());
        Path root = dir.toRealPath();

        for (String[] entry : List.of(new String[] {"skills", "skills/imported"}, new String[] {"hooks", "hooks/hooks.json"})) {
            Map<String, String> before = snapshot();
            ObjectNode request = body().put("kind", entry[0]).put("path", entry[1]);
            assertThrows(IOException.class, () -> failingMidway().removeContent(root, request), entry[1]);
            assertEquals(before, snapshot(), "everything is back after the failed removal of " + entry[1]);
        }
        assertEquals(200, controller.removeContent(body().put("kind", "skills").put("path", "skills/imported"), local())
                .getStatusCode().value(), "positive: without the failure the removal goes through");
    }

    @Test
    void aFailureMidwayTakesBackASkillImport() throws IOException {
        userSkill("humanizer", "humanizer");
        Map<String, String> before = snapshot();
        ObjectNode request = body();
        request.putArray("items").add(installedItem(null, "humanizer"));

        assertThrows(IOException.class, () -> failingMidway().importSkills(dir.toRealPath(), request));

        assertEquals(before, snapshot());
    }

    @Test
    void aFailureMidwayTakesBackAHookImport() throws IOException {
        settingsWithHooks();
        Map<String, String> before = snapshot();

        assertThrows(IOException.class, () -> failingMidway().importHooks(dir.toRealPath(), body()));

        assertEquals(before, snapshot());
    }

    @Test
    void aFailureMidwayTakesBackANewAgentAndANewCommand() throws IOException {
        Map<String, String> before = snapshot();

        assertThrows(IOException.class, () -> failingMidway().newAgent(dir.toRealPath(),
                body().put("name", "reviewer").put("type", "worker")));
        assertThrows(IOException.class, () -> failingMidway().newCommand(dir.toRealPath(), body().put("name", "ship")));

        assertEquals(before, snapshot(), "no file and no new folder stays");
    }

    // ---- second fix round ----------------------------------------------------------------------

    @Test
    void aLaunchFolderThatHoldsTheHomeIsNoProjectScope() throws IOException {
        Path beside = write(tmp, "beside/run.sh", "echo beside\n");
        write(spectroHome, "hooks/ok.sh", "echo ok\n");
        hook("bash " + beside + " ~/.spectro/hooks/ok.sh");
        PlaybookController fromAbove = launchedIn(home.getParent());

        ResponseEntity<?> answer = fromAbove.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("hooks.json", "ok.sh"), hooksFolder(),
                "a file beside the home is not copied when the launch folder holds the home");
        assertEquals("bash " + beside + " {hooks}/ok.sh", importedCommand());
        assertFalse(json(fromAbove.importSources(dir.toString(), null, local())).path("hooks").get(0).path("command")
                .asText().contains("{project}"), "a folder that holds the home is not written as the project");
    }

    @Test
    void aPlaybookJsonChangedBeforeTheContentsAreWrittenAnswers409AndTakesTheRestBack() throws IOException {
        userSkill("humanizer", "humanizer");
        Path root = dir.toRealPath();
        String original = Files.readString(dir.resolve("playbook.json"));
        String edited = original + "\n";
        Files.writeString(dir.resolve("playbook.json"), edited);
        Map<String, String> expected = snapshot();
        Files.writeString(dir.resolve("playbook.json"), original);
        PlaybookImports racing = new PlaybookImports(spectroHome, launch.resolve(".spectro/skills"), launch,
                userSettings).midway(() -> Files.writeString(root.resolve("playbook.json"), edited));
        ObjectNode request = body();
        request.putArray("items").add(installedItem(null, "humanizer"));

        PlaybookFiles.Answer skill = racing.importSkills(root, request);

        assertTrue(skill instanceof PlaybookFiles.Refused r && r.status() == 409 && r.reason().equals("changed"),
                String.valueOf(skill));
        assertEquals(expected, snapshot(), "the skill and its provenance line are taken back; the other write stays");

        Files.writeString(dir.resolve("playbook.json"), original);
        PlaybookFiles.Answer command = racing.newCommand(root, body().put("name", "ship"));

        assertTrue(command instanceof PlaybookFiles.Refused r && r.status() == 409 && r.reason().equals("changed"),
                String.valueOf(command));
        assertEquals(expected, snapshot(), "the command file and its folder are taken back");
    }

    @Test
    void aLinkedScriptWhoseTargetIsInScopeIsNotCopied() throws IOException {
        Path real = write(spectroHome, "hooks/real.sh", "echo real\n");
        assumeTrue(link(spectroHome.resolve("hooks/linked.sh"), real), "the file system makes links");
        hooks("bash ~/.spectro/hooks/linked.sh", "bash ~/.spectro/hooks/real.sh");

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("hooks.json", "real.sh"), hooksFolder(),
                "the link is not copied; the file it points at, named by itself, is");
        assertEquals(List.of("bash {hooks}/real.sh"), importedCommands());
        assertEquals(List.of("pre_tool_use ~/.spectro home-dot-folder"), left(json(answer)));
    }

    @Test
    void aHomePathThatIsNotCopiedIsWrittenWithATildeAsTheListingShowsIt() throws IOException {
        write(home, "keys/key.txt", "key\n");
        hook("cat " + home.resolve("keys/key.txt") + " --home " + home);

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        String written = Files.readString(dir.resolve("hooks/hooks.json"));
        assertFalse(written.contains(tmp.toString()), written);
        assertFalse(written.contains(tmp.toRealPath().toString()), written);
        assertEquals("cat ~/keys/key.txt --home ~", importedCommand());
        assertEquals(importedCommand(), json(controller.importSources(dir.toString(), null, local())).path("hooks").get(0)
                .path("command").asText(), "the listing shows what hooks.json holds");
        assertEquals(List.of("hooks.json"), hooksFolder(), "positive: a file that is no script is not copied");
    }

    @Test
    void aProjectPathUnderTheHomeIsListedAsHooksJsonHoldsIt() throws IOException {
        Path project = Files.createDirectories(home.resolve("proj"));
        write(project, "notes.txt", "notes\n");
        hook("cat " + project.resolve("notes.txt"));
        PlaybookController fromProject = launchedIn(project);

        ResponseEntity<?> answer = fromProject.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("cat {project}/notes.txt", importedCommand());
        assertEquals(importedCommand(), json(fromProject.importSources(dir.toString(), null, local())).path("hooks").get(0)
                .path("command").asText(), "the listing shows what hooks.json holds");
    }

    @Test
    void aLinkedHooksAgentsOrCommandsFolderAnswers400LinkAndWritesNothingThere() throws IOException {
        Path outside = Files.createDirectories(tmp.resolve("outside-target"));
        assumeTrue(link(dir.resolve("hooks"), outside), "the file system makes links");
        assumeTrue(link(dir.resolve("agents"), outside), "the file system makes links");
        assumeTrue(link(dir.resolve("commands"), outside), "the file system makes links");
        settingsWithHooks();
        Map<String, String> before = snapshot();

        List<ResponseEntity<?>> answers = List.of(
                controller.importHooks(body(), local()),
                controller.newAgent(body().put("name", "reviewer").put("type", "worker"), local()),
                controller.newCommand(body().put("name", "ship"), local()));

        for (ResponseEntity<?> answer : answers) {
            assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
            assertEquals("link", json(answer).path("reason").asText(), String.valueOf(answer.getBody()));
            assertFalse(json(answer).path("message").asText().isBlank(), "the refusal says why");
        }
        assertEquals(before, snapshot());
        try (Stream<Path> listed = Files.list(outside)) {
            assertEquals(0, listed.count(), "nothing is written through a link");
        }
    }

    @Test
    void aLinkOnTheWayToTheTargetSkillFolderIsRefused() throws IOException {
        userSkill("pk/s1", "s1");
        Path outside = Files.createDirectories(tmp.resolve("outside-pack"));
        assumeTrue(link(dir.resolve("skills/pk"), outside), "the file system makes links");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importSkills(installedItem("pk", "s1"));

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("link", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
        try (Stream<Path> listed = Files.list(outside)) {
            assertEquals(0, listed.count(), "nothing is copied through the link");
        }
    }

    @Test
    void aFolderThatIsALinkWhenTheSkillMovesInIsNotUsed() throws IOException {
        Path outside = Files.createDirectories(tmp.resolve("outside-folder"));
        Path linked = dir.resolve("skills/raced");
        assumeTrue(link(linked, outside), "the file system makes links");
        List<Path> created = new ArrayList<>();

        assertFalse(PlaybookImports.plainFolder(linked, created), "a link is not a folder of the playbook");
        assertEquals(List.of(), created);
        assertTrue(PlaybookImports.plainFolder(dir.resolve("skills/fresh"), created),
                "positive: a missing folder is created");
        assertEquals(List.of(dir.resolve("skills/fresh")), created);
    }

    // ---- card 538 restart review: more spellings, aliases and paths that climb ------------------

    @Test
    void quotedDoubledDottedAndParameterSpellingsOfTheHomeLeaveTheHookOut() throws IOException {
        hooks("cat \"$HOME\"/.ssh/id_rsa", "cat \"${HOME}\"/.aws/credentials", "cat ~/./.ssh/id_rsa",
                "cat ~//.ssh/id_rsa", "cat ~/x/../.ssh/id_rsa", "cat $HOME//.ssh/id_rsa", "cat ${HOME:?}/.ssh/id_rsa",
                "cat ~/'.ssh'/id_rsa", "cd ~ && cat .ssh/id_rsa", "cat \"" + home + "\"/.ssh/id_rsa",
                "cat ~/\\.ssh/id_rsa", "cat ~/[.]ssh/id_rsa", "cd && cat ./.gnupg/key", "echo done");

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("echo done"), importedCommands(), "positive: the plain hook is written");
        assertEquals(List.of("pre_tool_use ~/.ssh home-dot-folder", "pre_tool_use ~/.aws home-dot-folder",
                "pre_tool_use ~/.ssh home-dot-folder", "pre_tool_use ~/.ssh home-dot-folder",
                "pre_tool_use ~/.ssh home-dot-folder", "pre_tool_use ~/.ssh home-dot-folder",
                "pre_tool_use ~/.ssh home-dot-folder", "pre_tool_use ~/.ssh home-dot-folder",
                "pre_tool_use ~/.ssh home-dot-folder", "pre_tool_use ~/.ssh home-dot-folder",
                "pre_tool_use ~/.ssh home-dot-folder", "pre_tool_use ~/.ssh home-dot-folder",
                "pre_tool_use ~/.gnupg home-dot-folder"), left(json(answer)));
        String text = mapper.writeValueAsString(answer.getBody());
        assertFalse(text.contains(tmp.toString()) || text.contains(tmp.toRealPath().toString()), text);
    }

    @Test
    void aHomeTokenInsideAnotherWordTheParentOfTheHomeAndARelativeDotPathElsewhereAreWritten() throws IOException {
        List<String> commands = List.of("cat foo/~/.ssh/x", "cat a--~/.ssh/x", "cat foo/$HOME/.ssh/x", "cat ~/../x",
                "bash .claude/hooks/check.sh", "cd ~/work && cat .env", "cd /tmp && cat .x");
        hooks(commands.toArray(String[]::new));

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(commands, importedCommands());
        assertEquals(List.of(), left(json(answer)));
    }

    @Test
    void aProjectPathThatClimbsAboveTheProjectIsLeftOutAndOneThatStaysInsideIsWritten() throws IOException {
        hooks("bash " + launch + "/../x.sh", "bash " + launch + "/a/../b.sh", "cat \"" + launch + "\"/./../.env");

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("bash {project}/a/../b.sh"), importedCommands());
        assertEquals(List.of("pre_tool_use {project}/.. project-parent", "pre_tool_use {project}/.. project-parent"),
                left(json(answer)));
        String text = mapper.writeValueAsString(answer.getBody());
        assertFalse(text.contains(tmp.toString()) || text.contains(tmp.toRealPath().toString()), text);
        JsonNode rows = json(controller.importSources(dir.toString(), null, local())).path("hooks");
        assertEquals("project-parent", rows.get(0).path("left").asText(), rows.toString());
        assertTrue(rows.get(1).path("left").isNull(), rows.toString());
    }

    @Test
    void everyHookLeftOutForEitherReasonWritesNothingAndTheSentenceNamesBoth() throws IOException {
        hooks("bash " + launch + "/../x.sh", "cat ~/.ssh/id_rsa");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = controller.importHooks(body(), local());

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("all-left-out", json(answer).path("reason").asText());
        String message = json(answer).path("message").asText();
        assertTrue(message.contains("~/.ssh") && message.contains("{project}/.."), message);
        assertEquals(before, snapshot());
    }

    @Test
    void anotherSpellingOfTheWorkspaceThroughALinkIsWrittenAsTheProject() throws IOException {
        Path real = Files.createDirectories(tmp.toRealPath().resolve("wsreal"));
        Path alias = tmp.toRealPath().resolve("wslink");
        assumeTrue(link(alias, real), "the file system makes links");
        hooks("bash " + alias + "/a.sh", "bash " + tmp.resolve("wsreal") + "/b.sh", "bash " + alias + "/../c.sh");

        ResponseEntity<?> answer = controller.importHooks(body().put("workspace", real.toString()), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("bash {project}/a.sh", "bash {project}/b.sh"), importedCommands());
        assertEquals(List.of("pre_tool_use {project}/.. project-parent"), left(json(answer)));
        String listed = mapper.writeValueAsString(json(controller.importSources(dir.toString(), real.toString(), local())));
        assertFalse(listed.contains(tmp.toString()) || listed.contains(tmp.toRealPath().toString()), listed);
    }

    @Test
    void aWorkspaceGivenThroughALinkInsideItselfIsWrittenAtItsLongestSpelling() throws IOException {
        Path a = Files.createDirectories(tmp.toRealPath().resolve("nest/a"));
        assumeTrue(link(a.resolve("b"), a), "the file system makes links");
        hooks("bash " + a + "/b/s.sh");

        ResponseEntity<?> answer = controller.importHooks(body().put("workspace", a.resolve("b").toString()), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("bash {project}/s.sh"), importedCommands());
    }

    private static boolean link(Path link, Path target) {
        try {
            Files.createSymbolicLink(link, target);
            return true;
        } catch (IOException | UnsupportedOperationException unsupported) {
            return false;
        }
    }

    @SuppressWarnings("unused")
    private static String utf8(byte[] bytes) {
        return new String(bytes, StandardCharsets.UTF_8);
    }
}
