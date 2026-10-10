package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The playbook routes, driven directly with a mock request (no MockMvc), the
 * way {@code BundleControllerTest} drives the scaffold. The bundled playbook
 * comes from the test fixture {@code test-bundled-playbooks/spectro/}.
 */
class PlaybookControllerTest {

    static final String FIXTURE_ROOT = "test-bundled-playbooks";

    @TempDir Path tmp;

    private final ObjectMapper mapper = new ObjectMapper();
    private PlaybookController controller;
    private PlaybookFolders folders;

    @BeforeEach
    void setUp() {
        folders = new PlaybookFolders(tmp.resolve("playbooks.json"));
        controller = new PlaybookController(folders, FIXTURE_ROOT);
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
        request.addHeader("Origin", "https://evil.example");
        return request;
    }

    private JsonNode body(String... pairs) {
        ObjectNode node = mapper.createObjectNode();
        for (int i = 0; i < pairs.length; i += 2) {
            node.put(pairs[i], pairs[i + 1]);
        }
        return node;
    }

    private Path playbookFolder(String name) throws IOException {
        Path dir = Files.createDirectories(tmp.resolve(name));
        Files.writeString(dir.resolve("playbook.json"), PlaybookLoaderTest.MINIMAL);
        Path skill = Files.createDirectories(dir.resolve("skills/spectropowers/brainstorming"));
        Files.writeString(skill.resolve("SKILL.md"), "---\nname: brainstorming\ndescription: d\n---\nbody\n");
        return dir;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(ResponseEntity<?> response) {
        return (Map<String, Object>) response.getBody();
    }

    @Test
    void registersPinsListsAndLoadsAFolder() throws IOException {
        Path a = playbookFolder("a");
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        String real = a.toRealPath().toString();

        ResponseEntity<?> registered = controller.register(body("dir", a.toString()), local());
        assertEquals(200, registered.getStatusCode().value());
        assertEquals(List.of(real), map(registered).get("folders"));

        ResponseEntity<?> pinned = controller.pin(body("workspace", ws.toString(), "dir", a.toString()), local());
        assertEquals(200, pinned.getStatusCode().value());
        assertEquals(real, map(pinned).get("active"));

        Map<String, Object> listed = controller.list(ws.toString());
        assertEquals(List.of(real), listed.get("folders"));
        assertEquals(real, listed.get("active"));
        assertNull(controller.list(null).get("active"));

        ResponseEntity<?> loaded = controller.load(a.toString(), ws.toString());
        assertEquals(200, loaded.getStatusCode().value());
        PlaybookLoader.Loaded body = (PlaybookLoader.Loaded) loaded.getBody();
        assertEquals(List.of(), body.findings());
        assertEquals("p", body.playbook().id());
        assertEquals(real, body.dir());
    }

    @Test
    void theLoadAnswerCarriesTheKindOfEveryNodeOnTheWire() throws IOException {
        Path a = playbookFolder("a");
        controller.register(body("dir", a.toString()), local());

        ResponseEntity<?> loaded = controller.load(a.toString(), null);
        JsonNode wire = mapper.valueToTree(loaded.getBody());
        JsonNode nodes = wire.path("playbook").path("nodes");
        assertEquals(3, nodes.size());
        assertEquals("step", nodes.get(0).path("kind").asText(null));
        assertEquals("decision", nodes.get(1).path("kind").asText(null));
        assertEquals("end", nodes.get(2).path("kind").asText(null));
        // The web reads the decision's ceiling under this name.
        assertEquals(2, nodes.get(1).path("maxRounds").asInt());
    }

    @Test
    void refusesAFolderWithoutAPlaybookAPinToAnUnknownFolderAndALoadOfAnUnregisteredOne() throws IOException {
        Path empty = Files.createDirectories(tmp.resolve("empty"));
        Path stranger = playbookFolder("stranger");
        Path ws = Files.createDirectories(tmp.resolve("ws"));

        assertEquals(400, controller.register(body("dir", empty.toString()), local()).getStatusCode().value());
        assertEquals(400, controller.register(body("dir", tmp.resolve("absent").toString()), local())
                .getStatusCode().value());
        assertEquals(400, controller.register(body(), local()).getStatusCode().value());
        assertEquals(400, controller.pin(body("workspace", ws.toString(), "dir", stranger.toString()), local())
                .getStatusCode().value());
        assertEquals(400, controller.load(stranger.toString(), ws.toString()).getStatusCode().value());
        assertEquals(List.of(), folders.read().folders());
    }

    @Test
    void copiesTheBundledPlaybookIntoAnEmptyFolderAndRegistersIt() throws IOException {
        Path target = Files.createDirectories(tmp.resolve("target"));

        ResponseEntity<?> copied = controller.copy("spectro", body("dir", target.toString()), local());

        assertEquals(200, copied.getStatusCode().value(), String.valueOf(copied.getBody()));
        assertTrue(Files.isRegularFile(target.resolve("playbook.json")));
        assertTrue(Files.isRegularFile(target.resolve("LICENSE")));
        assertTrue(Files.isRegularFile(target.resolve("PROVENANCE.md")));
        assertTrue(Files.isRegularFile(target.resolve("skills/spectropowers/brainstorming/SKILL.md")));
        @SuppressWarnings("unchecked")
        List<String> written = (List<String>) map(copied).get("written");
        assertTrue(written.contains("skills/spectropowers/brainstorming/SKILL.md"), written.toString());
        assertEquals(target.toRealPath().toString(), map(copied).get("dir"));
        assertEquals(List.of(target.toRealPath().toString()), folders.read().folders());
    }

    @Test
    void aSecondCopyIntoTheSameFolderIsAConflictAndWritesNothing() throws IOException {
        Path target = Files.createDirectories(tmp.resolve("target"));
        assertEquals(200, controller.copy("spectro", body("dir", target.toString()), local()).getStatusCode().value());
        Files.writeString(target.resolve("LICENSE"), "mine");

        ResponseEntity<?> again = controller.copy("spectro", body("dir", target.toString()), local());

        assertEquals(409, again.getStatusCode().value());
        @SuppressWarnings("unchecked")
        List<String> conflicts = (List<String>) map(again).get("conflicts");
        assertTrue(conflicts.contains("LICENSE"), conflicts.toString());
        assertTrue(conflicts.contains("playbook.json"), conflicts.toString());
        assertEquals("mine", Files.readString(target.resolve("LICENSE")));
    }

    @Test
    void anUnknownBundledIdIsNotFound() throws IOException {
        Path target = Files.createDirectories(tmp.resolve("target"));
        assertEquals(404, controller.copy("nope", body("dir", target.toString()), local()).getStatusCode().value());
        assertEquals(404, controller.copy("../spectro", body("dir", target.toString()), local()).getStatusCode().value());
        // A folder inside a bundled playbook is not a playbook of its own.
        assertEquals(404, controller.copy("spectro/skills", body("dir", target.toString()), local()).getStatusCode().value());
        try (var entries = Files.list(target)) {
            assertEquals(0, entries.count());
        }
    }

    @Test
    void aCopyIntoSomethingThatIsNotAFolderIsABadRequest() {
        assertEquals(400, controller.copy("spectro", body("dir", tmp.resolve("absent").toString()), local())
                .getStatusCode().value());
        assertEquals(400, controller.copy("spectro", body(), local()).getStatusCode().value());
    }

    @Test
    void everyWriteRefusesAForeignCallerAndACrossSiteOrigin() throws IOException {
        Path a = playbookFolder("a");
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        Path target = Files.createDirectories(tmp.resolve("target"));
        for (MockHttpServletRequest request : List.of(foreign(), crossSite())) {
            assertEquals(404, controller.register(body("dir", a.toString()), request).getStatusCode().value());
            assertEquals(404, controller.pin(body("workspace", ws.toString(), "dir", a.toString()), request)
                    .getStatusCode().value());
            assertEquals(404, controller.copy("spectro", body("dir", target.toString()), request)
                    .getStatusCode().value());
        }
        assertEquals(List.of(), folders.read().folders());
        assertFalse(Files.exists(target.resolve("playbook.json")));
    }

    private PlaybookController contentsController() {
        return new PlaybookController(folders, FIXTURE_ROOT, new InstallLedger(tmp.resolve("home/playbook-installs.json")),
                tmp.resolve("home/.spectro"), tmp.resolve("launch"));
    }

    @Test
    void theContentsRouteAnswersAPreviewForARegisteredFolder() throws IOException {
        Path a = playbookFolder("a");
        PlaybookController contents = contentsController();
        contents.register(body("dir", a.toString()), local());

        ResponseEntity<?> answered = contents.contents(a.toString(), null, local());

        assertEquals(200, answered.getStatusCode().value());
        PlaybookContents.Preview preview = (PlaybookContents.Preview) answered.getBody();
        assertEquals("p", preview.playbook());
        assertEquals(a.toRealPath().toString(), preview.dir());
        assertEquals(List.of("skill spectropowers:brainstorming new"),
                preview.items().stream().map(i -> i.kind() + " " + i.name() + " " + i.state()).toList());
        assertEquals(List.of(), preview.findings());
        JsonNode wire = mapper.valueToTree(answered.getBody());
        assertEquals("spectropowers:brainstorming", wire.path("items").get(0).path("name").asText(null));
        assertEquals(64, wire.path("contentsHash").asText("").length());
    }

    @Test
    void theContentsRouteRefusesAnUnregisteredFolderAndAForeignCaller() throws IOException {
        Path stranger = playbookFolder("stranger");
        Path a = playbookFolder("a");
        PlaybookController contents = contentsController();
        contents.register(body("dir", a.toString()), local());

        assertEquals(400, contents.contents(stranger.toString(), null, local()).getStatusCode().value());
        assertEquals(400, contents.contents("", null, local()).getStatusCode().value());
        assertEquals(404, contents.contents(a.toString(), null, foreign()).getStatusCode().value());
        assertEquals(404, contents.contents(a.toString(), null, crossSite()).getStatusCode().value());
    }

    @Test
    void theContentsRouteNamesTheFindingsOfAPlaybookThatDoesNotReadInsteadOfFailing() throws IOException {
        Path a = playbookFolder("a");
        PlaybookController contents = contentsController();
        contents.register(body("dir", a.toString()), local());
        Files.writeString(a.resolve("playbook.json"), "{ not json");

        ResponseEntity<?> answered = contents.contents(a.toString(), null, local());

        assertEquals(200, answered.getStatusCode().value());
        PlaybookContents.Preview preview = (PlaybookContents.Preview) answered.getBody();
        assertEquals(List.of(), preview.items());
        assertFalse(preview.findings().isEmpty());
    }
    @Test
    void theContentsRouteAnswersABadRequestForAWorkspaceThatIsNotAPath() throws IOException {
        Path a = playbookFolder("a");
        PlaybookController contents = contentsController();
        contents.register(body("dir", a.toString()), local());

        ResponseEntity<?> answered = contents.contents(a.toString(), "work\u0000space", local());

        assertEquals(400, answered.getStatusCode().value());
        assertEquals(200, contents.contents(a.toString(), tmp.toString(), local()).getStatusCode().value(),
                "a usable workspace still answers the preview");
    }

    // ---- install and remove ------------------------------------------------------------------

    /** A registered folder with every kind of content, the fixture of {@link PlaybookInstallerTest}. */
    private Path fullFolder(PlaybookController controller, String name) throws IOException {
        Path dir = Files.createDirectories(tmp.resolve(name));
        Files.writeString(dir.resolve("playbook.json"), PlaybookLoaderTest.MINIMAL.replace(
                "\"contents\": { \"skills\": [\"skills/spectropowers\"] }", PlaybookContentsTest.CONTENTS));
        Map<String, String> files = Map.of(
                "skills/spectropowers/brainstorming/SKILL.md", "---\nname: brainstorming\ndescription: Shape an idea.\n---\nbody\n",
                "agents/reviewer.md", "---\nname: reviewer\ndescription: Reads the diff.\ntype: explore\n---\nYou review.\n",
                "hooks/hooks.json", PlaybookContentsTest.HOOKS,
                "hooks/guard.sh", "#!/bin/sh\nexit 0\n",
                "commands/ship.md", "---\ndescription: Ship it.\n---\nRun the release.\n",
                "workflows/build.js", "export default 1;\n",
                "LICENSE", "MIT\n",
                "PROVENANCE.md", "made here\n");
        for (Map.Entry<String, String> file : files.entrySet()) {
            Path target = dir.resolve(file.getKey());
            Files.createDirectories(target.getParent());
            Files.writeString(target, file.getValue());
        }
        assertEquals(200, controller.register(body("dir", dir.toString()), local()).getStatusCode().value());
        return dir;
    }

    private String shownHash(PlaybookController controller, Path dir) {
        return ((PlaybookContents.Preview) controller.contents(dir.toString(), null, local()).getBody()).contentsHash();
    }

    private JsonNode installBody(Path dir, String hash, boolean hooks) {
        ObjectNode node = mapper.createObjectNode();
        node.put("dir", dir.toString());
        node.put("contentsHash", hash);
        node.put("hooks", hooks);
        return node;
    }

    @Test
    void theInstallRouteAnswersChangedUnlicensedThenInstallsOnceAndAnswersAlready() throws IOException {
        PlaybookController contents = contentsController();
        Path a = fullFolder(contents, "a");
        String hash = shownHash(contents, a);

        ResponseEntity<?> changed = contents.install(installBody(a, "0".repeat(64), true), local());
        assertEquals(409, changed.getStatusCode().value());
        assertEquals("CHANGED", map(changed).get("reason"));

        Files.move(a.resolve("LICENSE"), tmp.resolve("LICENSE.aside"));
        ResponseEntity<?> unlicensed = contents.install(installBody(a, hash, true), local());
        assertEquals(400, unlicensed.getStatusCode().value());
        assertEquals("UNLICENSED", map(unlicensed).get("reason"));
        assertTrue(String.valueOf(map(unlicensed).get("message")).contains("unlicensed copy"));
        Files.move(tmp.resolve("LICENSE.aside"), a.resolve("LICENSE"));
        assertFalse(Files.exists(tmp.resolve("home/.spectro/skills")), "no refusal wrote anything");

        ResponseEntity<?> installed = contents.install(installBody(a, hash, true), local());
        assertEquals(200, installed.getStatusCode().value(), String.valueOf(installed.getBody()));
        @SuppressWarnings("unchecked")
        List<String> names = (List<String>) map(installed).get("installed");
        assertEquals(List.of("spectropowers:brainstorming", "p:ship", "pre_tool_use run_command", "reviewer", "build.js"),
                names);
        assertTrue(Files.isRegularFile(tmp.resolve("home/.spectro/skills/spectropowers/brainstorming/SKILL.md")));
        assertTrue(Files.readString(tmp.resolve("home/.spectro/settings.json")).contains("guard.sh"));

        ResponseEntity<?> again = contents.install(installBody(a, hash, true), local());
        assertEquals(409, again.getStatusCode().value());
        assertEquals("ALREADY", map(again).get("reason"));
        assertTrue(String.valueOf(map(again).get("message")).contains(a.toRealPath().toString()));
    }

    @Test
    void theInstallRouteAnswersFindingsForAPlaybookWithAFindingAndRefusesAnUnregisteredFolder() throws IOException {
        PlaybookController contents = contentsController();
        Path a = fullFolder(contents, "a");
        Files.writeString(a.resolve("commands/ship.md"), "---\n---\nRun the release.\n");
        Path stranger = playbookFolder("stranger");

        ResponseEntity<?> findings = contents.install(installBody(a, shownHash(contents, a), false), local());
        assertEquals(400, findings.getStatusCode().value());
        assertEquals("FINDINGS", map(findings).get("reason"));
        assertTrue(String.valueOf(map(findings).get("findings")).contains("commands/ship.md#description"));

        assertEquals(400, contents.install(installBody(stranger, "x", false), local()).getStatusCode().value());
        assertFalse(Files.exists(tmp.resolve("home/.spectro/skills")));
    }

    @Test
    void theRemoveRouteAnswersRemovedAndKeptAndNotFoundWhenNothingIsInstalled() throws IOException {
        PlaybookController contents = contentsController();
        Path a = fullFolder(contents, "a");
        assertEquals(404, contents.remove(body("dir", a.toString()), local()).getStatusCode().value());

        assertEquals(200, contents.install(installBody(a, shownHash(contents, a), true), local()).getStatusCode().value());
        ResponseEntity<?> removed = contents.remove(body("dir", a.toString()), local());

        assertEquals(200, removed.getStatusCode().value(), String.valueOf(removed.getBody()));
        assertEquals(List.of("spectropowers:brainstorming", "p:ship", "pre_tool_use run_command", "reviewer", "build.js"),
                map(removed).get("removed"));
        assertEquals(List.of(), map(removed).get("kept"));
        assertFalse(Files.exists(tmp.resolve("home/.spectro/skills/spectropowers")));
        assertEquals(400, contents.remove(body("dir", tmp.resolve("absent").toString()), local()).getStatusCode().value());
    }

    @Test
    void installAndRemoveRefuseAForeignCallerAndACrossSiteOrigin() throws IOException {
        PlaybookController contents = contentsController();
        Path a = fullFolder(contents, "a");
        String hash = shownHash(contents, a);
        for (MockHttpServletRequest request : List.of(foreign(), crossSite())) {
            assertEquals(404, contents.install(installBody(a, hash, true), request).getStatusCode().value());
            assertEquals(404, contents.remove(body("dir", a.toString()), request).getStatusCode().value());
        }
        assertFalse(Files.exists(tmp.resolve("home/.spectro/skills")));
    }
}
