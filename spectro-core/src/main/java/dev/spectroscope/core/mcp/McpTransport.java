package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

/**
 * The seam that makes the MCP client testable without a real process. A
 * transport speaks JSON-RPC 2.0 to one server — stdio (spawn + stdin/stdout)
 * or HTTP/SSE — and is driven entirely through these four methods, so a test
 * can inject a plain in-memory fake. Implementations may throw on I/O failure;
 * {@link McpClient} owns the retry/degrade policy.
 */
public interface McpTransport {

    /** Perform the MCP {@code initialize} handshake and return the negotiated result. */
    McpInitializeResult initialize();

    /** Call {@code tools/list} and return the advertised tools. */
    List<McpToolDescriptor> listTools();

    /**
     * Call {@code tools/call} for {@code toolName} with {@code arguments}; return the text content.
     *
     * @param toolName  remote tool name as advertised by {@code tools/list}
     * @param arguments JSON arguments object; implementations treat {@code null} as empty
     * @return the reply's text blocks joined, or the raw result JSON for unexpected shapes
     */
    String callTool(String toolName, JsonNode arguments);

    /** Release the process / connection. Must be idempotent and never throw. */
    void close();
}
