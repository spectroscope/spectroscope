package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * The {@code error} member of a JSON-RPC 2.0 response: a numeric code and a human message.
 *
 * @param code    numeric JSON-RPC error code, e.g. {@code -32601} for an unknown method
 * @param message human-readable error text, surfaced verbatim to the caller
 * @param data    optional structured detail — {@code null} when the server sends none
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record JsonRpcError(int code, String message, JsonNode data) {}
