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
}
