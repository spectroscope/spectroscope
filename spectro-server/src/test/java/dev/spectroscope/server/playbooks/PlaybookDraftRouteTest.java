package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.playbook.Finding;
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
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The editor view and the draft check: {@code GET} and {@code POST
 * /api/playbooks/draft}, driven directly with a mock request the way
 * {@link PlaybookControllerTest} drives the other playbook routes.
 */
class PlaybookDraftRouteTest {

    private static final int CAP = 1_048_576;

    @TempDir Path tmp;

    private final ObjectMapper mapper = new ObjectMapper();
    private PlaybookController controller;
    private PlaybookFolders folders;
    private Path dir;

    @BeforeEach
    void setUp() throws IOException {
        folders = new PlaybookFolders(tmp.resolve("playbooks.json"));
        controller = new PlaybookController(folders, PlaybookControllerTest.FIXTURE_ROOT);
        dir = folder("pb", PlaybookLoaderTest.MINIMAL);
        folders.register(dir);
    }

    private Path folder(String name, String json) throws IOException {
        Path d = Files.createDirectories(tmp.resolve(name));
        Files.writeString(d.resolve("playbook.json"), json);
        Path skill = Files.createDirectories(d.resolve("skills/spectropowers/brainstorming"));
        Files.writeString(skill.resolve("SKILL.md"), "---\nname: brainstorming\ndescription: d\n---\nbody\n");
        return d;
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

    private static String sha256(byte[] bytes) throws NoSuchAlgorithmException {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private EditorView view(ResponseEntity<?> response) {
        assertEquals(200, response.getStatusCode().value());
        return (EditorView) response.getBody();
    }

    private static List<String> paths(EditorView view) {
        return view.loaded().findings().stream().map(Finding::path).toList();
    }

    private ObjectNode parsedMinimal() throws IOException {
        return (ObjectNode) mapper.readTree(PlaybookLoaderTest.MINIMAL);
    }

    @Test
    void getDraftShowsTheFileWithItsHashAndForm() throws Exception {
        byte[] disk = Files.readAllBytes(dir.resolve("playbook.json"));

        EditorView view = view(controller.getDraft(dir.toString(), null));

        assertTrue(view.editable());
        assertFalse(view.canonical(), "the compact test file is not in the canonical form");
        assertEquals(sha256(disk), view.diskHash());
        assertEquals(4, view.document().get("arrows").size());
        assertEquals(List.of("pass", "fail", "exhausted"), view.outcomes().get("ok"));
        assertEquals(List.of(""), view.outcomes().get("write"));
        assertFalse(view.outcomes().containsKey("done"), "an end has no outcomes");
        assertEquals(1, view.choices().size());
        EditorView.ChoiceState fast = view.choices().get(0);
        assertEquals("fast", fast.choice());
        assertEquals("ollama", fast.provider());
        assertEquals("qwen3:8b", fast.model());
        assertNotNull(fast.state());
        assertNotNull(fast.reason());
        assertEquals(dir.toRealPath().toString(), view.loaded().dir());
    }

    @Test
    void aCanonicalFileReadsCanonical() throws IOException {
        String canonical = PlaybookWriter.write(PlaybookReader.read(PlaybookLoaderTest.MINIMAL).playbook());
        Files.writeString(dir.resolve("playbook.json"), canonical);

        EditorView view = view(controller.getDraft(dir.toString(), null));

        assertTrue(view.canonical());
        assertTrue(view.editable());
    }

    @Test
    void postDraftChecksTheBodyAndWritesNothing() throws IOException {
        Path file = dir.resolve("playbook.json");
        byte[] before = Files.readAllBytes(file);
        ObjectNode draft = parsedMinimal();
        ((ArrayNode) draft.get("arrows")).remove(2);

        EditorView view = view(controller.postDraft(dir.toString(), null, draft.toString(), local()));

        assertTrue(view.loaded().findings().stream().anyMatch(f -> f.path().equals("nodes[1]")
                && f.message().contains("no arrow for outcome fail")), view.loaded().findings().toString());
        assertEquals(3, view.document().get("arrows").size(), "the view is of the body, not of the file");
        assertArrayEquals(before, Files.readAllBytes(file));
    }

    @Test
    void anUnknownFieldMakesTheFileNotEditable() throws IOException {
        ObjectNode withColour = parsedMinimal();
        ((ObjectNode) withColour.get("nodes").get(0)).put("colour", "red");
        Files.writeString(dir.resolve("playbook.json"), withColour.toString());

        EditorView view = view(controller.getDraft(dir.toString(), null));

        assertFalse(view.editable());
        assertTrue(paths(view).contains("nodes[0].colour"), paths(view).toString());
    }

    @Test
    void aForeignCallerGets404AndTheFenceRunsFirst() throws IOException {
        String body = PlaybookLoaderTest.MINIMAL;
        assertEquals(404, controller.postDraft(dir.toString(), null, body, foreign()).getStatusCode().value());
        assertEquals(404, controller.postDraft(dir.toString(), null, body, crossSite()).getStatusCode().value());
        // The fence answers before the size and the folder are looked at.
        String huge = "x".repeat(CAP + 1);
        assertEquals(404, controller.postDraft(dir.toString(), null, huge, foreign()).getStatusCode().value());
        assertEquals(404, controller.postDraft(tmp.resolve("nowhere").toString(), null, body, crossSite())
                .getStatusCode().value());
    }

    @Test
    void aBodyAboveTheCapIs413() {
        String base = PlaybookLoaderTest.MINIMAL.replace("\"description\": \"d\"", "\"description\": \"D\"");
        int pad = CAP + 1 - base.getBytes(StandardCharsets.UTF_8).length + 1;
        String over = base.replace("\"D\"", "\"" + "x".repeat(pad) + "\"");
        assertEquals(CAP + 1, over.getBytes(StandardCharsets.UTF_8).length);
        String exactly = base.replace("\"D\"", "\"" + "x".repeat(pad - 1) + "\"");
        assertEquals(CAP, exactly.getBytes(StandardCharsets.UTF_8).length);

        assertEquals(413, controller.postDraft(dir.toString(), null, over, local()).getStatusCode().value());
        assertEquals(200, controller.postDraft(dir.toString(), null, exactly, local()).getStatusCode().value(),
                "a body of exactly the cap is read");
    }

    @Test
    void anUnregisteredFolderIs400() throws IOException {
        Path stranger = folder("stranger", PlaybookLoaderTest.MINIMAL);

        assertEquals(400, controller.getDraft(stranger.toString(), null).getStatusCode().value());
        assertEquals(400, controller.postDraft(stranger.toString(), null, PlaybookLoaderTest.MINIMAL, local())
                .getStatusCode().value());
        assertEquals(400, controller.getDraft(tmp.resolve("nowhere").toString(), null).getStatusCode().value());
        assertEquals("unknown folder", mapper.valueToTree(controller.getDraft(stranger.toString(), null).getBody())
                .path("message").asText());
    }
}
