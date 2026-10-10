package dev.spectroscope.core.playbook.run;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PlaybookRecorderTest {

    static final ObjectMapper JSON = new ObjectMapper();
    @TempDir Path tmp;

    static List<JsonNode> lines(Path file) throws IOException {
        return Files.readAllLines(file).stream().map(l -> {
            try {
                return JSON.readTree(l);
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
        }).toList();
    }

    @Test
    void aLineHasTypeFirstAndTsLastAndRedactsSecrets() throws IOException {
        Path file = tmp.resolve("s1.playbook.jsonl");
        try (PlaybookRecorder r = new PlaybookRecorder(file, PlaybookRecorder.DEFAULT_CEILING_BYTES)) {
            Map<String, Object> fields = new LinkedHashMap<>();
            fields.put("run", "abcdefabcdef");
            fields.put("node", "implement");
            fields.put("endpoint", "http://localhost:11434");
            fields.put("error", "bearer abcdefghijklmnopqrstuvwxyz0123");
            r.record("step_end", fields);
        }
        String raw = Files.readString(file);
        assertTrue(raw.startsWith("{\"type\":\"step_end\",\"run\":\"abcdefabcdef\""), raw);
        JsonNode line = lines(file).get(0);
        List<String> keys = new java.util.ArrayList<>();
        line.fieldNames().forEachRemaining(keys::add);
        assertEquals("ts", keys.get(keys.size() - 1));
        assertEquals("http://localhost:11434", line.get("endpoint").asText());
        assertEquals("bearer", line.get("error").get("redacted").asText());
        assertFalse(raw.contains("abcdefghijklmnopqrstuvwxyz0123"));
    }

    @Test
    void anUnknownTypeIsRefused() {
        PlaybookRecorder r = new PlaybookRecorder(tmp.resolve("x.playbook.jsonl"), 1024);
        assertThrows(IllegalArgumentException.class, () -> r.record("node_start", Map.of()));
    }

    @Test
    void theCeilingLatchesWithOneTruncationLine() throws IOException {
        Path file = tmp.resolve("c.playbook.jsonl");
        PlaybookRecorder r = new PlaybookRecorder(file, 200);
        for (int i = 0; i < 10; i++) {
            r.record("check", Map.of("run", "abcdefabcdef", "detail", "x".repeat(60)));
        }
        List<JsonNode> got = lines(file);
        assertEquals("truncated", got.get(got.size() - 1).get("type").asText());
        assertEquals(1, got.stream().filter(n -> "truncated".equals(n.get("type").asText())).count());
    }

    @Test
    void theIdIsNeverAPath() {
        assertTrue(PlaybookRecorder.fileFor("s-1").endsWith(Path.of(".spectro", "playbook-runs", "s-1.playbook.jsonl")));
        assertTrue(PlaybookRecorder.graphFileFor("s-1", "abcdefabcdef")
                .endsWith(Path.of(".spectro", "playbook-runs", "s-1.abcdefabcdef.graph.jsonl")));
        assertThrows(IllegalArgumentException.class, () -> PlaybookRecorder.fileFor("../x"));
        assertThrows(IllegalArgumentException.class, () -> PlaybookRecorder.graphFileFor("s-1", "../../y"));
    }
}
