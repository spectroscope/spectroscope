package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.mcp.McpServerRegistry.McpServerHandle;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Registry façade: eager connect, wrap tools, skip failing servers, expose handles. */
class McpServerRegistryTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static McpToolDescriptor tool(String name) {
        return new McpToolDescriptor(name, name + " desc", JSON.createObjectNode().put("type", "object"));
    }

    private static McpInitializeResult init(String server) {
        return new McpInitializeResult("2024-11-05", server, null);
    }

    @Test
    void healthyServerContributesPrefixedToolsAndAReachableHandle() {
        McpServerConfig healthy = new McpServerConfig("notes", "java", List.of("-jar", "x.jar"), null, null, null);
        Function<McpServerConfig, McpTransport> factory = cfg ->
                new FakeTransport(init(cfg.name()), List.of(tool("search_notes"), tool("add_note")),
                        (name, args) -> "ok");

        McpServerRegistry registry = McpServerRegistry.load(List.of(healthy), Path.of("."), factory);

        List<Tool> tools = registry.tools();
        assertEquals(2, tools.size());
        assertEquals("mcp__notes__search_notes", tools.get(0).name());
        assertEquals("mcp__notes__add_note", tools.get(1).name());
        assertTrue(tools.get(0).needsPermission());

        assertEquals(1, registry.servers().size());
        McpServerHandle handle = registry.servers().get(0);
        assertEquals("notes", handle.name());
        assertTrue(handle.reachable());
        assertEquals(2, handle.toolCount());
        assertEquals("java", handle.target());
    }

    @Test
    void aServerThatFailsToInitializeIsSkippedAndTheHealthyOneStillLoads() {
        McpServerConfig healthy = new McpServerConfig("notes", "java", null, null, null, null);
        McpServerConfig broken = new McpServerConfig("broken", "nope", null, null, null, null);

        Function<McpServerConfig, McpTransport> factory = cfg -> {
            if (cfg.name().equals("broken")) {
                throw new RuntimeException("cannot spawn");
            }
            return new FakeTransport(init(cfg.name()), List.of(tool("search_notes")), (name, args) -> "ok");
        };

        McpServerRegistry registry = McpServerRegistry.load(List.of(healthy, broken), Path.of("."), factory);

        // Only the healthy server's tool survives; load() did not throw.
        assertEquals(1, registry.tools().size());
        assertEquals("mcp__notes__search_notes", registry.tools().get(0).name());

        // Both servers get a handle; the broken one is marked unreachable with zero tools.
        assertEquals(2, registry.servers().size());
        McpServerHandle notes = registry.servers().stream()
                .filter(h -> h.name().equals("notes")).findFirst().orElseThrow();
        McpServerHandle broke = registry.servers().stream()
                .filter(h -> h.name().equals("broken")).findFirst().orElseThrow();
        assertTrue(notes.reachable());
        assertFalse(broke.reachable());
        assertEquals(0, broke.toolCount());
    }

    @Test
    void nullOrEmptyServerListYieldsNoToolsAndNoCrash() {
        McpServerRegistry fromNull = McpServerRegistry.load(null, Path.of("."), cfg -> null);
        McpServerRegistry fromEmpty = McpServerRegistry.load(List.of(), Path.of("."), cfg -> null);

        assertTrue(fromNull.tools().isEmpty());
        assertTrue(fromNull.servers().isEmpty());
        assertTrue(fromEmpty.tools().isEmpty());
    }

    @Test
    void httpServerHandleReportsTheUrlAsItsTarget() {
        McpServerConfig remote = new McpServerConfig("remote", null, null, null, "http://localhost:8931/sse", "sse");
        Function<McpServerConfig, McpTransport> factory = cfg ->
                new FakeTransport(init(cfg.name()), List.of(tool("ping")), (name, args) -> "pong");

        McpServerRegistry registry = McpServerRegistry.load(List.of(remote), Path.of("."), factory);

        assertEquals("http://localhost:8931/sse", registry.servers().get(0).target());
        assertEquals("mcp__remote__ping", registry.tools().get(0).name());
    }
}
