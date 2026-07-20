package dev.spectroscope.core.mcp;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertInstanceOf;

/** The default transport factory maps a config's {@link McpServerConfig.TransportKind} to a transport. */
class McpTransportsTest {

    @Test
    void stdioConfigYieldsAStdioTransport() {
        // A command that exits immediately is fine — the factory only constructs, it does not initialize.
        McpServerConfig cfg = new McpServerConfig("echo", "true", List.of(), null, null, null);
        McpTransport transport = McpTransports.defaultFactory(Path.of(".")).apply(cfg);
        assertInstanceOf(StdioTransport.class, transport);
        transport.close();
    }

    @Test
    void httpSseConfigYieldsAnHttpSseTransport() {
        // A url (optionally type:"sse") selects the optional HTTP/SSE transport.
        McpServerConfig cfg = new McpServerConfig("remote", null, null, null, "http://localhost:8931/sse", "sse");
        McpTransport transport = McpTransports.defaultFactory(Path.of(".")).apply(cfg);
        assertInstanceOf(HttpSseTransport.class, transport);
        transport.close();
    }
}
