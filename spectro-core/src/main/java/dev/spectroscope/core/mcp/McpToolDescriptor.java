package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * One entry of an MCP {@code tools/list} result: the remote tool's name,
 * human description, and JSON Schema for its arguments. The schema arrives on
 * the wire as {@code inputSchema} (MCP naming) and is surfaced verbatim to the
 * model — MCP tools are advertised in full, unlike progressively-disclosed skills.
 *
 * @param name        remote tool name, unqualified
 * @param description human-readable text shown to the model, may be {@code null}
 * @param inputSchema JSON Schema of the arguments — may be {@code null} or non-object
 *                    from a sloppy server; {@link McpTool#inputSchema()} guards that
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record McpToolDescriptor(
        String name,
        String description,
        @JsonProperty("inputSchema") JsonNode inputSchema) {}
