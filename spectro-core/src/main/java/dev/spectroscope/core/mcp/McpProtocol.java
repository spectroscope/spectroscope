package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * The MCP method layer both transports speak — ONE copy of the frames and of
 * the reply mapping, finishing the hoist {@link McpCallResult#fromToolsCall}
 * started (card 198's lesson: the private {@code tools/call} mapping copy in
 * the SSE transport is what let an image reach the model as raw JSON).
 *
 * <p>Before this class, {@code PROTOCOL_VERSION} was declared twice and the
 * {@code initialize} params block plus the {@code tools/list} descriptor loop
 * were duplicated verbatim between {@link StdioTransport} and
 * {@link HttpSseTransport} — the exact defect class of card 198, still
 * structurally open one seam over. What stays per-transport is the CARRIER:
 * how a frame travels (stdio pipe vs HTTP/SSE) and how the far end is torn
 * down. Nothing here touches StdioTransport's census/goodbye order.</p>
 */
final class McpProtocol {

    /** The MCP protocol revision spectroscope negotiates — one declaration, two speakers. */
    static final String VERSION = "2024-11-05";

    /** Static method layer only — never instantiated. */
    private McpProtocol() {
    }

    /**
     * The {@code initialize} request params: protocol version, empty
     * capabilities, spectroscope's clientInfo.
     *
     * @param json the transport's mapper
     * @return the params object to send
     */
    static ObjectNode initializeParams(ObjectMapper json) {
        ObjectNode params = json.createObjectNode();
        params.put("protocolVersion", VERSION);
        params.set("capabilities", json.createObjectNode());
        ObjectNode clientInfo = json.createObjectNode();
        clientInfo.put("name", "spectroscope");
        clientInfo.put("version", "1.0");
        params.set("clientInfo", clientInfo);
        return params;
    }

    /**
     * Pulls the fields spectroscope keeps out of an {@code initialize} reply.
     *
     * @param result the JSON-RPC result object
     * @return the negotiated protocol version, server name, and raw capabilities
     */
    static McpInitializeResult initializeResult(JsonNode result) {
        String protocol = result.path("protocolVersion").asText(VERSION);
        String serverName = result.path("serverInfo").path("name").asText(null);
        JsonNode capabilities = result.get("capabilities");
        return new McpInitializeResult(protocol, serverName, capabilities);
    }

    /**
     * Maps a {@code tools/list} reply onto descriptors; a single malformed
     * descriptor is skipped with a log note rather than failing the whole list.
     *
     * @param result the JSON-RPC result object
     * @param json   the transport's mapper
     * @param log    the transport's own logger, so the note names the speaker
     * @return the advertised tools, in server order
     */
    static List<McpToolDescriptor> toolsListResult(JsonNode result, ObjectMapper json, Logger log) {
        JsonNode tools = result.path("tools");
        List<McpToolDescriptor> descriptors = new ArrayList<>();
        if (tools.isArray()) {
            for (JsonNode tool : tools) {
                try {
                    descriptors.add(json.treeToValue(tool, McpToolDescriptor.class));
                } catch (IOException malformed) {
                    log.warn("skipping malformed MCP tool descriptor: {}", malformed.getMessage());
                }
            }
        }
        return descriptors;
    }

    /**
     * The {@code tools/call} request params.
     *
     * @param json      the transport's mapper
     * @param toolName  remote tool name as advertised by {@code tools/list}
     * @param arguments JSON arguments object; {@code null} becomes an empty object
     * @return the params object to send
     */
    static ObjectNode toolsCallParams(ObjectMapper json, String toolName, JsonNode arguments) {
        ObjectNode params = json.createObjectNode();
        params.put("name", toolName);
        params.set("arguments", arguments != null ? arguments : json.createObjectNode());
        return params;
    }
}
