package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.PlaybookWriter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The save route: {@code PUT /api/playbooks/file}, driven directly with a mock
 * request the way {@link PlaybookDraftRouteTest} drives the draft routes.
 */
class PlaybookFileRouteTest {

    private static final int CAP = 1_048_576;

    @TempDir Path tmp;

    private final ObjectMapper mapper = new ObjectMapper();
    private PlaybookController controller;
    private Path dir;
    private Path file;
    private String canonical;
    private String base;

    @BeforeEach
    void setUp() throws Exception {
        PlaybookFolders folders = new PlaybookFolders(tmp.resolve("playbooks.json"));
        controller = new PlaybookController(folders, PlaybookControllerTest.FIXTURE_ROOT);
        canonical = PlaybookWriter.write(PlaybookReader.read(PlaybookLoaderTest.MINIMAL).playbook());
        dir = Files.createDirectories(tmp.resolve("pb"));
        file = dir.resolve("playbook.json");
        Files.writeString(file, canonical);
        Path skill = Files.createDirectories(dir.resolve("skills/spectropowers/brainstorming"));
        Files.writeString(skill.resolve("SKILL.md"), "---\nname: brainstorming\ndescription: d\n---\nbody\n");
        folders.register(dir);
        base = EditorView.sha256(Files.readAllBytes(file));
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

    private ObjectNode canonicalTree() throws IOException {
        return (ObjectNode) mapper.readTree(canonical);
    }

    private String body(String baseHash, JsonNode playbook) {
        ObjectNode body = mapper.createObjectNode();
        body.put("baseHash", baseHash);
        body.set("playbook", playbook);
        return body.toString();
    }

    private ResponseEntity<?> put(String baseHash, JsonNode playbook) {
        return controller.putFile(dir.toString(), null, body(baseHash, playbook), local());
    }

    private List<String> findingPaths(ResponseEntity<?> response) {
        JsonNode tree = mapper.valueToTree(response.getBody());
        List<String> paths = new ArrayList<>();
        for (JsonNode f : tree.path("findings")) {
            paths.add(f.path("path").asText());
        }
        return paths;
    }

    private List<String> tempFiles() throws IOException {
        try (Stream<Path> listing = Files.list(dir)) {
            return listing.map(p -> p.getFileName().toString())
                    .filter(n -> n.startsWith(".playbook.json.") && n.endsWith(".tmp")).toList();
        }
    }

    @Test
    void writesTheCanonicalFormAndAnswersTheNewView() throws Exception {
        List<String> before = Files.readAllLines(file);
        ObjectNode draft = canonicalTree();
        ((ObjectNode) draft.get("nodes").get(0)).put("name", "Write the spec");

        ResponseEntity<?> response = put(base, draft);

        assertEquals(200, response.getStatusCode().value());
        String expected = PlaybookWriter.write(PlaybookReader.read(draft.toString()).playbook());
        assertEquals(expected, Files.readString(file, StandardCharsets.UTF_8));
        List<String> after = Files.readAllLines(file);
        assertEquals(before.size(), after.size());
        int differing = 0;
        for (int i = 0; i < before.size(); i++) {
            if (!before.get(i).equals(after.get(i))) {
                differing++;
            }
        }
        assertEquals(1, differing, "the diff shows the change and nothing else");
        EditorView view = (EditorView) response.getBody();
        assertEquals(EditorView.sha256(Files.readAllBytes(file)), view.diskHash());
        assertTrue(view.canonical());
        assertTrue(view.editable());
        assertEquals(List.of(), tempFiles(), "no temp file is left behind");
    }

    @Test
    void refusesWhileFindingsExistAndWritesNothing() throws Exception {
        byte[] before = Files.readAllBytes(file);
        ObjectNode draft = canonicalTree();
        ((ArrayNode) draft.get("arrows")).remove(2);

        ResponseEntity<?> response = put(base, draft);

        assertEquals(400, response.getStatusCode().value());
        assertTrue(findingPaths(response).contains("nodes[1]"), findingPaths(response).toString());
        assertArrayEquals(before, Files.readAllBytes(file));
        assertEquals(List.of(), tempFiles());
    }

    @Test
    void refusesAStaleBaseWith409() throws Exception {
        String edited = canonical.replace("\"description\": \"d\"", "\"description\": \"d \"");
        assertFalse(edited.equals(canonical));
        Files.writeString(file, edited);
        byte[] theirs = Files.readAllBytes(file);
        ObjectNode draft = canonicalTree();
        ((ObjectNode) draft.get("nodes").get(0)).put("name", "Write the spec");

        ResponseEntity<?> response = put(base, draft);

        assertEquals(409, response.getStatusCode().value());
        assertEquals(EditorView.sha256(theirs), mapper.valueToTree(response.getBody()).path("diskHash").asText());
        assertArrayEquals(theirs, Files.readAllBytes(file));
    }

    @Test
    void refusesASymbolicLink() throws Exception {
        Path outside = tmp.resolve("outside.json");
        Files.writeString(outside, canonical);
        Files.delete(file);
        try {
            Files.createSymbolicLink(file, outside);
        } catch (IOException | UnsupportedOperationException refused) {
            assumeTrue(false, "the file system refuses symbolic links");
        }
        ObjectNode draft = canonicalTree();
        ((ObjectNode) draft.get("nodes").get(0)).put("name", "Write the spec");

        ResponseEntity<?> response = put(base, draft);

        assertEquals(400, response.getStatusCode().value());
        assertEquals(canonical, Files.readString(outside));
        assertTrue(Files.isSymbolicLink(file), "the link is still a link");
    }

    @Test
    void keepsTheFilesPermissions() throws Exception {
        assumeTrue(Files.getFileAttributeView(file, java.nio.file.attribute.PosixFileAttributeView.class) != null);
        Set<PosixFilePermission> wanted = PosixFilePermissions.fromString("rw-r--r--");
        Files.setPosixFilePermissions(file, wanted);
        ObjectNode draft = canonicalTree();
        ((ObjectNode) draft.get("nodes").get(0)).put("name", "Write the spec");

        assertEquals(200, put(base, draft).getStatusCode().value());

        assertEquals(wanted, Files.getPosixFilePermissions(file));
    }

    @Test
    void aForeignCallerGets404() throws Exception {
        byte[] before = Files.readAllBytes(file);
        ObjectNode draft = canonicalTree();
        ((ObjectNode) draft.get("nodes").get(0)).put("name", "Write the spec");
        String body = body(base, draft);

        assertEquals(404, controller.putFile(dir.toString(), null, body, foreign()).getStatusCode().value());
        assertEquals(404, controller.putFile(dir.toString(), null, body, crossSite()).getStatusCode().value());
        assertArrayEquals(before, Files.readAllBytes(file));
    }

    @Test
    void anUnknownFieldInTheDraftIsRefused() throws Exception {
        byte[] before = Files.readAllBytes(file);
        ObjectNode draft = canonicalTree();
        ((ObjectNode) draft.get("nodes").get(0)).put("colour", "red");

        ResponseEntity<?> response = put(base, draft);

        assertEquals(400, response.getStatusCode().value());
        assertTrue(findingPaths(response).contains("nodes[0].colour"), findingPaths(response).toString());
        assertArrayEquals(before, Files.readAllBytes(file));
    }

    @Test
    void aBodyAboveTheCapIs413() throws Exception {
        byte[] before = Files.readAllBytes(file);
        String over = "{\"baseHash\":\"" + base + "\",\"playbook\":{},\"pad\":\"" + "x".repeat(CAP) + "\"}";
        assertTrue(over.getBytes(StandardCharsets.UTF_8).length > CAP);

        assertEquals(413, controller.putFile(dir.toString(), null, over, local()).getStatusCode().value());
        assertArrayEquals(before, Files.readAllBytes(file));
    }

    @Test
    void aMissingHashOrPlaybookOrFolderIs400() throws Exception {
        assertEquals(400, controller.putFile(dir.toString(), null, "{\"playbook\":" + canonical + "}", local())
                .getStatusCode().value());
        assertEquals(400, controller.putFile(dir.toString(), null, "{\"baseHash\":\"" + base + "\"}", local())
                .getStatusCode().value());
        assertEquals(400, controller.putFile(dir.toString(), null, "not json", local()).getStatusCode().value());
        assertEquals(400, controller.putFile(tmp.resolve("nowhere").toString(), null,
                body(base, canonicalTree()), local()).getStatusCode().value());
    }

    @Test
    void anUnchangedDraftStillWritesTheCanonicalFormOverAForeignLayout() throws Exception {
        Files.writeString(file, PlaybookLoaderTest.MINIMAL);
        String foreignBase = EditorView.sha256(Files.readAllBytes(file));

        ResponseEntity<?> response = put(foreignBase, mapper.readTree(PlaybookLoaderTest.MINIMAL));

        assertEquals(200, response.getStatusCode().value());
        assertEquals(canonical, Files.readString(file, StandardCharsets.UTF_8));
    }
}
