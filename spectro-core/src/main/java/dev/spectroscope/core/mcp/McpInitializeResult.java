package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * The subset of an MCP {@code initialize} result spectroscope cares about: the agreed
 * {@code protocolVersion}, the advertised server name (from {@code serverInfo.name}),
 * and the raw {@code capabilities} node for anything a later stage may want to
 * inspect. Everything else the server sends is ignored.
 *
 * @param protocolVersion the version the server agreed to speak
 * @param serverName      advertised display name, or {@code null} when the server sent none
 * @param capabilities    raw capabilities node, kept unparsed for later inspection
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record McpInitializeResult(String protocolVersion, String serverName, JsonNode capabilities) {}
