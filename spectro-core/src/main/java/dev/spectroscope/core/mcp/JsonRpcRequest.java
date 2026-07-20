package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * A JSON-RPC 2.0 request frame. {@code id} correlates a response with its call;
 * a notification omits it (null, so it is dropped from the wire). {@code params}
 * is an arbitrary object — {@code null} params are omitted, matching what MCP
 * servers expect for parameterless methods like {@code tools/list}.
 *
 * @param jsonrpc protocol tag, always {@code "2.0"}
 * @param id      correlation id — numeric in practice, {@code null} for a notification
 * @param method  JSON-RPC method name, e.g. {@code tools/call}
 * @param params  parameters object, or {@code null} to omit the member
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record JsonRpcRequest(String jsonrpc, Object id, String method, JsonNode params) {

    /**
     * The constructor call sites use — pins {@code jsonrpc} to {@code "2.0"}.
     *
     * @param id     correlation id, or {@code null} for a notification
     * @param method JSON-RPC method name
     * @param params parameters object, or {@code null} to omit the member
     */
    public JsonRpcRequest(Object id, String method, JsonNode params) {
        this("2.0", id, method, params);
    }
}
