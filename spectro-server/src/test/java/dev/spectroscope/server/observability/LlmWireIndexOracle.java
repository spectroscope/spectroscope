package dev.spectroscope.server.observability;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The llm-wire index as {@code LlmWireController.index} built it up to 0.13.0
 * (card 434): a {@link BufferedReader} over the sidecar and one full Jackson
 * tree per line. Kept in the test tree as the oracle the streamed index is
 * compared against; the loop and the three helpers are copied from the
 * controller at {@code 7c24ebcf} with only the file handling around them
 * changed, so "the same answer" means the answer this code gives.
 */
final class LlmWireIndexOracle {

    private static final ObjectMapper JSON = new ObjectMapper();

    private LlmWireIndexOracle() {
    }

    /**
     * The index of one sidecar, the old way.
     *
     * @param file the sidecar
     * @return the exchange metadata array, or null where the old endpoint
     *         answered 404 because the reader threw (an unreadable file, or a
     *         byte sequence the UTF-8 decoder refuses anywhere in it)
     */
    static List<Map<String, Object>> index(Path file) {
        Map<String, Map<String, Object>> entries = new LinkedHashMap<>();
        try (BufferedReader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                JsonNode node;
                try {
                    node = JSON.readTree(line);
                } catch (IOException torn) {
                    continue;
                }
                switch (node.path("type").asText()) {
                    case "llm_request" -> entries.put(node.path("xid").asText(), openEntry(node));
                    case "llm_response" -> {
                        Map<String, Object> entry = entries.get(node.path("xid").asText());
                        if (entry != null) {
                            closeEntry(entry, node);
                        }
                    }
                    default -> { }
                }
            }
        } catch (IOException unreadable) {
            return null;
        }
        return new ArrayList<>(entries.values());
    }

    private static Map<String, Object> openEntry(JsonNode node) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("xid", node.path("xid").asText());
        entry.put("agentId", textOrNull(node, "agentId"));
        entry.put("turn", node.hasNonNull("turn") ? node.get("turn").asInt() : null);
        entry.put("kind", textOrNull(node, "kind"));
        entry.put("provider", textOrNull(node, "provider"));
        entry.put("model", textOrNull(node, "model"));
        entry.put("transport", textOrNull(node, "transport"));
        entry.put("url", textOrNull(node, "url"));
        entry.put("status", null);
        entry.put("requestBytes", node.path("bodyBytes").asLong(0));
        entry.put("responseBytes", 0L);
        entry.put("responseLines", 0);
        entry.put("aborted", false);
        entry.put("fidelity", textOrNull(node, "fidelity"));
        entry.put("durationMs", null);
        entry.put("ts", node.path("ts").asLong(0));
        return entry;
    }

    private static void closeEntry(Map<String, Object> entry, JsonNode node) {
        entry.put("status", node.hasNonNull("status") ? node.get("status").asInt() : null);
        entry.put("responseBytes", node.path("bodyBytes").asLong(0));
        entry.put("responseLines", node.has("lines") && node.get("lines").isArray()
                ? node.get("lines").size()
                : node.path("lineCount").asInt(0));
        entry.put("aborted", node.path("aborted").asBoolean(false));
        entry.put("durationMs", node.hasNonNull("durationMs") ? node.get("durationMs").asLong() : null);
        entry.put("ts", node.path("ts").asLong(0));
    }

    private static String textOrNull(JsonNode node, String field) {
        return node.hasNonNull(field) ? node.get(field).asText() : null;
    }
}
