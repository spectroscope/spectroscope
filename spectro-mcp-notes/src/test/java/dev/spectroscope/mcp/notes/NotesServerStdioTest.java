package dev.spectroscope.mcp.notes;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Drives the full stdio JSON-RPC loop in-JVM over byte streams (reliable,
 * binary-free, no process spawn): initialize -> tools/list -> tools/call
 * (search_notes) finds a seeded note.
 */
class NotesServerStdioTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void initializeThenListThenCallSearchFindsSeededNote(@TempDir Path dir) throws Exception {
        Files.writeString(dir.resolve("note-0000-fox.txt"),
                "the quick brown fox jumps", StandardCharsets.UTF_8);
        Files.writeString(dir.resolve("note-0001-dog.txt"),
                "a lazy dog naps all day", StandardCharsets.UTF_8);

        String requests = String.join("\n",
                req(1, "initialize", "{}"),
                req(2, "tools/list", "{}"),
                req(3, "tools/call",
                        "{\"name\":\"search_notes\",\"arguments\":{\"query\":\"fox\",\"limit\":5}}"),
                "");

        ByteArrayInputStream in = new ByteArrayInputStream(requests.getBytes(StandardCharsets.UTF_8));
        ByteArrayOutputStream out = new ByteArrayOutputStream();

        new NotesServer(new NotesStore(dir)).serve(in, out);

        List<String> lines = out.toString(StandardCharsets.UTF_8).lines().toList();
        assertEquals(3, lines.size(), "one response per request");

        JsonNode init = JSON.readTree(lines.get(0));
        assertEquals(1, init.get("id").asInt());
        assertEquals("2024-11-05", init.get("result").get("protocolVersion").asText());

        JsonNode list = JSON.readTree(lines.get(1));
        JsonNode tools = list.get("result").get("tools");
        List<String> toolNames = tools.findValuesAsText("name");
        assertTrue(toolNames.contains("search_notes"));
        assertTrue(toolNames.contains("add_note"));

        JsonNode call = JSON.readTree(lines.get(2));
        String text = call.get("result").get("content").get(0).get("text").asText();
        assertTrue(text.contains("note-0000-fox.txt"), "search should surface the fox note");
        assertFalse(text.contains("note-0001-dog.txt"), "the dog note does not match 'fox'");
    }

    @Test
    void addNoteCreatesANoteThatASubsequentSearchFinds(@TempDir Path dir) throws Exception {
        String requests = String.join("\n",
                req(1, "initialize", "{}"),
                req(2, "tools/call",
                        "{\"name\":\"add_note\",\"arguments\":{\"text\":\"buy oat milk tomorrow\"}}"),
                req(3, "tools/call",
                        "{\"name\":\"search_notes\",\"arguments\":{\"query\":\"oat milk\",\"limit\":5}}"),
                "");

        ByteArrayInputStream in = new ByteArrayInputStream(requests.getBytes(StandardCharsets.UTF_8));
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        new NotesServer(new NotesStore(dir)).serve(in, out);

        List<String> lines = out.toString(StandardCharsets.UTF_8).lines().toList();
        assertEquals(3, lines.size());

        // add_note reports the created note file and is not an error.
        JsonNode add = JSON.readTree(lines.get(1));
        JsonNode addResult = add.get("result");
        String addText = addResult.get("content").get(0).get("text").asText();
        assertTrue(addText.startsWith("Added note "), "add_note should report the created note, got: " + addText);
        assertFalse(addResult.has("isError") && addResult.get("isError").asBoolean(),
                "a successful add is not an error");

        // The note is on disk and search surfaces it.
        assertEquals(1, store(dir), "exactly one note file should exist after add_note");
        JsonNode search = JSON.readTree(lines.get(2));
        String searchText = search.get("result").get("content").get(0).get("text").asText();
        assertTrue(searchText.contains("oat milk"), "search should find the just-added note, got: " + searchText);
    }

    @Test
    void addNoteWithBlankTextReturnsAnIsErrorResult(@TempDir Path dir) throws Exception {
        String response = new NotesServer(new NotesStore(dir))
                .handle(req(7, "tools/call", "{\"name\":\"add_note\",\"arguments\":{\"text\":\"   \"}}"));

        JsonNode node = JSON.readTree(response);
        JsonNode result = node.get("result");
        assertTrue(result.get("isError").asBoolean(), "blank add_note text must be flagged isError:true");
        assertTrue(result.get("content").get(0).get("text").asText().contains("non-empty"));
        // Nothing was written.
        assertEquals(0, store(dir), "a rejected blank note must not create a file");
    }

    private static long store(Path dir) throws Exception {
        if (!Files.isDirectory(dir)) {
            return 0;
        }
        try (var files = Files.list(dir)) {
            return files.filter(Files::isRegularFile).count();
        }
    }

    @Test
    void unknownMethodYieldsJsonRpcError(@TempDir Path dir) {
        String response = new NotesServer(new NotesStore(dir)).handle(req(9, "does/notExist", "{}"));
        assertTrue(response.contains("\"error\""));
        assertTrue(response.contains("-32601"));
    }

    @Test
    void malformedJsonIsIgnoredWithoutCrashing(@TempDir Path dir) {
        assertEquals(null, new NotesServer(new NotesStore(dir)).handle("{ this is not json"));
    }

    private static String req(int id, String method, String paramsJson) {
        return "{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"method\":\"" + method
                + "\",\"params\":" + paramsJson + "}";
    }
}
