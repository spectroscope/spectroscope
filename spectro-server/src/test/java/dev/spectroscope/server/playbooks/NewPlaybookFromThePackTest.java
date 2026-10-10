package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.config.SpectroConfig;
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
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 515, decision E: a new playbook without a project is a copy of the
 * shipped spectro pack with the model choices from the page. The page makes
 * it with three existing routes in this order: the copy route, the draft
 * route for the hash and the canonical tree, and the file route with the
 * models map replaced. This drives that chain against the shipped pack, not
 * the test fixture, because the pack is what the owner gets.
 */
class NewPlaybookFromThePackTest {

    @TempDir Path tmp;

    private final ObjectMapper mapper = new ObjectMapper();
    private PlaybookFolders folders;
    private PlaybookController controller;

    @BeforeEach
    void setUp() {
        folders = new PlaybookFolders(tmp.resolve("playbooks.json"));
        controller = new PlaybookController(folders, PlaybookController.BUNDLE_ROOT);
    }

    /** The choices the page sends: role to provider and model. */
    private static final Map<String, String[]> CHOICES = Map.of(
            "fast", new String[] {"ollama", "qwen2.5:7b"},
            "strong", new String[] {"anthropic", "claude-sonnet-5-5"});

    /** The chain the page runs; answers the folder the copy route reported. */
    private Path newPlaybook(String name, Map<String, String[]> choices) throws IOException {
        Path target = Files.createDirectories(tmp.resolve("work").resolve(name));
        ObjectNode copyBody = mapper.createObjectNode().put("dir", target.toString());
        ResponseEntity<?> copied = controller.copy("spectro", copyBody, new MockHttpServletRequest());
        assertEquals(200, copied.getStatusCode().value(), String.valueOf(copied.getBody()));
        Path root = Path.of(String.valueOf(((Map<?, ?>) copied.getBody()).get("dir")));

        ResponseEntity<?> draft = controller.getDraft(root.toString(), null);
        assertEquals(200, draft.getStatusCode().value());
        EditorView view = (EditorView) draft.getBody();
        assertTrue(view.editable(), "the shipped pack must be editable without loss");

        ObjectNode doc = view.document().deepCopy();
        ObjectNode models = (ObjectNode) doc.get("models");
        for (Map.Entry<String, String[]> c : choices.entrySet()) {
            ObjectNode role = (ObjectNode) models.get(c.getKey());
            role.set("primary", mapper.createObjectNode()
                    .put("provider", c.getValue()[0]).put("model", c.getValue()[1]));
        }
        ObjectNode put = mapper.createObjectNode().put("baseHash", view.diskHash());
        put.set("playbook", doc);
        ResponseEntity<?> saved = controller.putFile(root.toString(), null, put.toString(), new MockHttpServletRequest());
        assertEquals(200, saved.getStatusCode().value(), String.valueOf(saved.getBody()));
        return root;
    }

    /** Every file below {@code root} as its path to its bytes, in path order. */
    private static Map<String, byte[]> tree(Path root) throws IOException {
        Map<String, byte[]> out = new TreeMap<>();
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path p : walk.filter(Files::isRegularFile).toList()) {
                out.put(root.relativize(p).toString(), Files.readAllBytes(p));
            }
        }
        return out;
    }

    @Test
    void theNewPlaybookCarriesTheChosenModelsInTheCanonicalFormAndLoadsWithoutFindings() throws IOException {
        Path root = newPlaybook("pb", CHOICES);

        String text = Files.readString(root.resolve("playbook.json"), StandardCharsets.UTF_8);
        PlaybookReader.Read read = PlaybookReader.read(text);
        assertEquals(List.of(), read.findings());
        assertEquals(PlaybookWriter.write(read.playbook()), text, "the file is in the canonical form");
        assertEquals("ollama", read.playbook().models().get("fast").primary().provider());
        assertEquals("qwen2.5:7b", read.playbook().models().get("fast").primary().model());
        assertEquals("claude-sonnet-5-5", read.playbook().models().get("strong").primary().model());
        // A role the page left alone keeps the pack's choice.
        assertEquals("claude-fable-5-1", read.playbook().models().get("judge").primary().model());
        assertEquals(List.of("fast", "standard", "strong", "judge"),
                List.copyOf(read.playbook().models().keySet()));

        PlaybookLoader.Loaded loaded = PlaybookLoader.load(root, root, SpectroConfig.load(SpectroConfig.Overrides.none()));
        assertEquals(List.of(), loaded.findings());
        assertTrue(Files.isRegularFile(root.resolve("skills/spectropowers/brainstorming/SKILL.md")));
    }

    @Test
    void theSameChoicesWriteByteIdenticalFoldersAndOtherChoicesDoNot() throws IOException {
        Map<String, byte[]> a = tree(newPlaybook("a", CHOICES));
        Map<String, byte[]> b = tree(newPlaybook("b", CHOICES));
        assertEquals(a.keySet(), b.keySet());
        for (String path : a.keySet()) {
            assertArrayEquals(a.get(path), b.get(path), path);
        }

        Map<String, byte[]> c = tree(newPlaybook("c", Map.of("judge", new String[] {"ollama", "qwen2.5:7b"})));
        assertEquals(a.keySet(), c.keySet());
        assertNotEquals(new String(a.get("playbook.json"), StandardCharsets.UTF_8),
                new String(c.get("playbook.json"), StandardCharsets.UTF_8));
    }

    @Test
    void theFolderIsListedAndPinnedToNothingAndNothingElseIsWritten() throws IOException {
        Path root = newPlaybook("pb", CHOICES);

        assertEquals(List.of(root.toString()), folders.read().folders());
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        assertNull(controller.list(ws.toString()).get("active"));
        try (Stream<Path> siblings = Files.list(tmp.resolve("work"))) {
            assertEquals(List.of(root.getFileName().toString()),
                    siblings.map(p -> p.getFileName().toString()).toList(), "no project folder beside it");
        }
        try (Stream<Path> leftovers = Files.list(root)) {
            assertFalse(leftovers.anyMatch(p -> p.getFileName().toString().endsWith(".tmp")));
        }
    }

    @Test
    void aFolderThatAlreadyHoldsThePackIsRefusedWith409AndKeepsItsFile() throws IOException {
        Path root = newPlaybook("pb", CHOICES);
        byte[] before = Files.readAllBytes(root.resolve("playbook.json"));

        ResponseEntity<?> again = controller.copy("spectro",
                mapper.createObjectNode().put("dir", root.toString()), new MockHttpServletRequest());

        assertEquals(409, again.getStatusCode().value());
        JsonNode body = mapper.valueToTree(again.getBody());
        assertTrue(body.get("conflicts").toString().contains("playbook.json"), body.toString());
        assertArrayEquals(before, Files.readAllBytes(root.resolve("playbook.json")));
    }
}
