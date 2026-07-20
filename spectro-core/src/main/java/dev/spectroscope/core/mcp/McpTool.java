package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.tools.Tool;

/**
 * Adapts one remote MCP tool into an ordinary spectroscope {@link Tool}. The punchline
 * of this stage: an MCP server is just another <i>tool source</i>, so once
 * wrapped its calls flow as plain {@code tool_call}/{@code tool_result} events —
 * no new {@code RunEvent} type, no JSONL change.
 *
 * <p>The name follows this harness's own convention, {@code mcp__<server>__<tool>};
 * the description and input schema come straight from {@code tools/list}. Every
 * MCP tool is permission-gated: its inputs are model output and its effects are
 * external, so it is untrusted by the house rule.
 */
public final class McpTool implements Tool {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final String serverName;
    private final McpClient client;
    private final McpToolDescriptor descriptor;
    private final String qualifiedName;

    /**
     * Wraps one advertised remote tool; the qualified name is fixed here and never recomputed.
     *
     * @param serverName configured server name — the middle segment of the qualified name
     * @param client     connection every call goes through
     * @param descriptor the remote tool as advertised by {@code tools/list}
     */
    public McpTool(String serverName, McpClient client, McpToolDescriptor descriptor) {
        this.serverName = serverName;
        this.client = client;
        this.descriptor = descriptor;
        this.qualifiedName = "mcp__" + serverName + "__" + descriptor.name();
    }

    /** The configured server this tool belongs to. */
    public String serverName() {
        return serverName;
    }

    /** The unqualified tool name as the server knows it — what {@code tools/call} is sent. */
    public String remoteName() {
        return descriptor.name();
    }

    /** The harness-side name the model calls: {@code mcp__<server>__<tool>}. */
    @Override
    public String name() {
        return qualifiedName;
    }

    /** The server's own description, or an empty string when it sent none. */
    @Override
    public String description() {
        return descriptor.description() != null ? descriptor.description() : "";
    }

    /**
     * The remote tool's argument schema, <b>never null</b>. A {@code tools/list}
     * entry may omit {@code inputSchema} (or send a non-object), in which case the
     * descriptor's schema is null/scalar; we substitute an empty object schema
     * {@code {"type":"object"}} so a provider that reads {@code node.has("properties")}
     * (e.g. AnthropicProvider.toSchema) never NPEs on untrusted server output.
     */
    @Override
    public JsonNode inputSchema() {
        JsonNode schema = descriptor.inputSchema();
        if (schema == null || !schema.isObject()) {
            ObjectNode empty = JSON.createObjectNode();
            empty.put("type", "object");
            return empty;
        }
        return schema;
    }

    /** Always {@code true} — the inputs are model output and the effects are external. */
    @Override
    public boolean needsPermission() {
        return true;
    }

    /**
     * Delegates straight to {@link McpClient#call} — the client already degrades every
     * failure to a readable string, so there is nothing to catch here.
     *
     * @param input   JSON arguments from the model, passed through unmodified
     * @param context unused — an MCP call emits no extra events
     * @return the remote tool's text output, or an {@code ERROR: ...} string
     */
    @Override
    public String execute(JsonNode input, ToolContext context) {
        // McpClient.call already returns text or an "ERROR: ..." string and never throws.
        return client.call(descriptor.name(), input);
    }
}
