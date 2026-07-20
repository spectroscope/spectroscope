package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * A JSON-RPC 2.0 response frame. Exactly one of {@code result} / {@code error}
 * is present per spec; unknown members are ignored so a chatty server does not
 * break parsing.
 *
 * @param jsonrpc protocol tag as echoed by the server
 * @param id      correlation id of the answered request — kept raw for the mismatch check
 * @param result  payload on success, {@code null} on error
 * @param error   failure detail on error, {@code null} on success
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record JsonRpcResponse(String jsonrpc, JsonNode id, JsonNode result, JsonRpcError error) {}
