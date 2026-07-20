package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.PipedReader;
import java.io.PipedWriter;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The MCP method mapping of {@link StdioTransport} — {@code initialize},
 * {@code notifications/initialized}, {@code tools/list}, {@code tools/call} — driven
 * over a {@link JsonRpcChannel} on in-memory pipes with a scripted MCP responder.
 * No process is spawned here; the real end-to-end spawn arrives with the notes server.
 */
class StdioTransportProtocolTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private record Wiring(BufferedReader channelIn, BufferedWriter channelOut,
                          BufferedReader serverIn, BufferedWriter serverOut) {}

    private static Wiring pipes() throws IOException {
        PipedWriter cOut = new PipedWriter();
        PipedReader sIn = new PipedReader(cOut);
        PipedWriter sOut = new PipedWriter();
        PipedReader cIn = new PipedReader(sOut);
        return new Wiring(new BufferedReader(cIn), new BufferedWriter(cOut),
                new BufferedReader(sIn), new BufferedWriter(sOut));
    }

    /** A minimal MCP server: answers initialize/tools-list/tools-call, records the methods it saw. */
    private static Thread mcpResponder(Wiring w, List<String> methodsSeen, AtomicReference<Throwable> failure) {
        Thread t = new Thread(() -> {
            try {
                String line;
                while ((line = w.serverIn().readLine()) != null) {
                    JsonNode req = JSON.readTree(line);
                    String method = req.path("method").asText();
                    methodsSeen.add(method);
                    JsonNode id = req.get("id");
                    if (id == null || id.isNull()) {
                        continue; // notification — no reply
                    }
                    JsonNode result = switch (method) {
                        case "initialize" -> {
                            var r = JSON.createObjectNode();
                            r.put("protocolVersion", "2024-11-05");
                            r.set("serverInfo", JSON.createObjectNode().put("name", "notes"));
                            r.set("capabilities", JSON.createObjectNode());
                            yield r;
                        }
                        case "tools/list" -> {
                            var tool = JSON.createObjectNode();
                            tool.put("name", "search_notes");
                            tool.put("description", "search the notes");
                            tool.set("inputSchema", JSON.createObjectNode().put("type", "object"));
                            var r = JSON.createObjectNode();
                            r.set("tools", JSON.createArrayNode().add(tool));
                            yield r;
                        }
                        case "tools/call" -> {
                            String name = req.path("params").path("name").asText();
                            String q = req.path("params").path("arguments").path("query").asText();
                            var textBlock = JSON.createObjectNode();
                            textBlock.put("type", "text");
                            textBlock.put("text", "hit for " + name + ": " + q);
                            var r = JSON.createObjectNode();
                            r.set("content", JSON.createArrayNode().add(textBlock));
                            yield r;
                        }
                        default -> JSON.createObjectNode();
                    };
                    var resp = JSON.createObjectNode();
                    resp.put("jsonrpc", "2.0");
                    resp.set("id", id);
                    resp.set("result", result);
                    w.serverOut().write(JSON.writeValueAsString(resp));
                    w.serverOut().write("\n");
                    w.serverOut().flush();
                }
            } catch (Throwable e) {
                failure.set(e);
            }
        }, "mcp-responder");
        t.setDaemon(true);
        return t;
    }

    @Test
    void initializeListAndCallSpeakTheRightMcpMethodsAndExtractText() throws Exception {
        Wiring w = pipes();
        List<String> methods = new CopyOnWriteArrayList<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        mcpResponder(w, methods, failure).start();

        JsonRpcChannel channel = new JsonRpcChannel(w.channelIn(), w.channelOut(), Duration.ofSeconds(5));
        StdioTransport transport = new StdioTransport(channel, () -> {});
        try {
            McpInitializeResult init = transport.initialize();
            assertEquals("2024-11-05", init.protocolVersion());
            assertEquals("notes", init.serverName());

            List<McpToolDescriptor> tools = transport.listTools();
            assertEquals(1, tools.size());
            assertEquals("search_notes", tools.get(0).name());
            assertEquals("search the notes", tools.get(0).description());

            String out = transport.callTool("search_notes", JSON.createObjectNode().put("query", "gradle"));
            assertEquals("hit for search_notes: gradle", out);
        } finally {
            transport.close();
        }

        // initialize is followed by the notifications/initialized notification (MCP handshake).
        assertTrue(methods.contains("initialize"));
        assertTrue(methods.contains("notifications/initialized"));
        assertTrue(methods.contains("tools/list"));
        assertTrue(methods.contains("tools/call"));
        assertTrue(methods.indexOf("initialize") < methods.indexOf("notifications/initialized"),
                "initialized notification must follow the initialize response");
        assertTrue(failure.get() == null, "responder failed: " + failure.get());
    }
}
