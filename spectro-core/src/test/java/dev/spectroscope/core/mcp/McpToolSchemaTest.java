package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Regression for a HIGH finding: a remote {@code tools/list} entry with NO
 * {@code inputSchema} deserializes to a null schema, which — fed unchanged into a
 * provider that reads {@code node.has("properties")} — NPEs and crashes the run
 * loop on the first request. {@link McpTool#inputSchema()} must never return null.
 */
class McpToolSchemaTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static McpInitializeResult init() {
        return new McpInitializeResult("2024-11-05", "notes", null);
    }

    @Test
    void aDescriptorWithNoInputSchemaYieldsANonNullObjectSchema() {
        // A descriptor as it would deserialize from a tools/list entry that omits inputSchema.
        McpToolDescriptor noSchema = new McpToolDescriptor("search_notes", "search", null);
        McpClient client = new McpClient(
                new McpServerConfig("notes", "java", null, null, null, null),
                () -> new FakeTransport(init(), List.of(noSchema), (name, args) -> "ok"));

        McpTool tool = new McpTool("notes", client, noSchema);
        JsonNode schema = tool.inputSchema();

        assertNotNull(schema, "inputSchema() must never be null for a schema-less remote tool");
        assertTrue(schema.isObject());
        assertEquals("object", schema.path("type").asText());
    }

    @Test
    void aNonObjectInputSchemaIsTreatedAsAnEmptyObjectSchema() {
        // Defensive: a server that sends a scalar/array schema must not leak through either.
        McpToolDescriptor scalarSchema =
                new McpToolDescriptor("weird", "weird", JSON.getNodeFactory().textNode("not-an-object"));
        McpClient client = new McpClient(
                new McpServerConfig("notes", "java", null, null, null, null),
                () -> new FakeTransport(init(), List.of(scalarSchema), (name, args) -> "ok"));

        JsonNode schema = new McpTool("notes", client, scalarSchema).inputSchema();

        assertTrue(schema.isObject());
        assertEquals("object", schema.path("type").asText());
    }

    @Test
    void registryWrappingASchemaLessServerDoesNotThrowAndSchemaIsUsable() {
        McpServerConfig cfg = new McpServerConfig("notes", "java", null, null, null, null);
        Function<McpServerConfig, McpTransport> factory = c ->
                new FakeTransport(init(), List.of(new McpToolDescriptor("search_notes", "search", null)),
                        (name, args) -> "ok");

        McpServerRegistry registry =
                assertDoesNotThrow(() -> McpServerRegistry.load(List.of(cfg), Path.of("."), factory));

        List<Tool> tools = registry.tools();
        assertEquals(1, tools.size());
        JsonNode schema = tools.get(0).inputSchema();
        assertNotNull(schema);
        assertTrue(schema.isObject());
        assertEquals("object", schema.path("type").asText());
    }
}
