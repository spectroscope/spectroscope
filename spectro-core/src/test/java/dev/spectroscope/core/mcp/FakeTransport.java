package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;
import java.util.function.BiFunction;

/**
 * A scripted in-memory {@link McpTransport} — the whole point of the transport
 * seam: the client logic (initialize, list, call, timeout, single-reconnect,
 * degrade) is exercised with no process, no I/O, no binary.
 */
final class FakeTransport implements McpTransport {

    private final McpInitializeResult initResult;
    private final List<McpToolDescriptor> descriptors;
    private final BiFunction<String, JsonNode, String> callHandler;

    int initializeCalls;
    int listToolsCalls;
    int callToolCalls;
    boolean closed;

    FakeTransport(McpInitializeResult initResult,
                  List<McpToolDescriptor> descriptors,
                  BiFunction<String, JsonNode, String> callHandler) {
        this.initResult = initResult;
        this.descriptors = descriptors;
        this.callHandler = callHandler;
    }

    @Override
    public McpInitializeResult initialize() {
        initializeCalls++;
        return initResult;
    }

    @Override
    public List<McpToolDescriptor> listTools() {
        listToolsCalls++;
        return descriptors;
    }

    @Override
    public String callTool(String toolName, JsonNode arguments) {
        callToolCalls++;
        return callHandler.apply(toolName, arguments);
    }

    @Override
    public void close() {
        closed = true;
    }
}
