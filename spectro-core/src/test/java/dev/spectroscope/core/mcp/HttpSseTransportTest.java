package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The optional {@link HttpSseTransport}, driven against an in-process
 * {@link HttpServer} on an ephemeral port that returns canned JSON-RPC responses
 * as an SSE ({@code text/event-stream}, {@code data:} lines) body. No network,
 * no external server, no key — the same style the LLM providers are tested with.
 */
class HttpSseTransportTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private HttpServer server;
    private String url;
    private final List<String> methodsSeen = new CopyOnWriteArrayList<>();

    @BeforeEach
    void startStub() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/sse", this::handle);
        server.start();
        url = "http://127.0.0.1:" + server.getAddress().getPort() + "/sse";
    }

    @AfterEach
    void stopStub() {
        if (server != null) {
            server.stop(0);
        }
    }

    /** A minimal SSE MCP endpoint: read the posted JSON-RPC request, reply with one SSE data frame. */
    private void handle(HttpExchange exchange) throws IOException {
        byte[] reqBytes = exchange.getRequestBody().readAllBytes();
        JsonNode req = JSON.readTree(reqBytes);
        String method = req.path("method").asText();
        methodsSeen.add(method);
        JsonNode id = req.get("id");

        JsonNode result = switch (method) {
            case "initialize" -> {
                var r = JSON.createObjectNode();
                r.put("protocolVersion", "2024-11-05");
                r.set("serverInfo", JSON.createObjectNode().put("name", "remote"));
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

        // notifications/initialized carries no id → just 202 Accepted, no SSE body.
        if (id == null || id.isNull()) {
            exchange.sendResponseHeaders(202, -1);
            exchange.close();
            return;
        }

        var resp = JSON.createObjectNode();
        resp.put("jsonrpc", "2.0");
        resp.set("id", id);
        resp.set("result", result);

        // SSE body: an "event:" line plus a "data:" line carrying the JSON-RPC response.
        String body = "event: message\n"
                + "data: " + JSON.writeValueAsString(resp) + "\n\n";
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        exchange.sendResponseHeaders(200, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    @Test
    void initializeListAndCallRoundTripOverSse() {
        McpServerConfig cfg = new McpServerConfig("remote", null, null, null, url, "sse");
        HttpSseTransport transport = new HttpSseTransport(cfg, Duration.ofSeconds(5));
        try {
            McpInitializeResult init = transport.initialize();
            assertEquals("2024-11-05", init.protocolVersion());
            assertEquals("remote", init.serverName());

            List<McpToolDescriptor> tools = transport.listTools();
            assertEquals(1, tools.size());
            assertEquals("search_notes", tools.get(0).name());
            assertEquals("search the notes", tools.get(0).description());

            String out = transport.callTool("search_notes", JSON.createObjectNode().put("query", "gradle"));
            assertEquals("hit for search_notes: gradle", out);
        } finally {
            transport.close();
        }

        assertTrue(methodsSeen.contains("initialize"));
        assertTrue(methodsSeen.contains("notifications/initialized"));
        assertTrue(methodsSeen.contains("tools/list"));
        assertTrue(methodsSeen.contains("tools/call"));
    }

    @Test
    void httpSseConfigYieldsAnHttpSseTransportFromTheFactory() {
        McpServerConfig cfg = new McpServerConfig("remote", null, null, null, url, "sse");
        McpTransport transport = McpTransports.defaultFactory(java.nio.file.Path.of(".")).apply(cfg);
        try {
            assertTrue(transport instanceof HttpSseTransport,
                    "an sse/url config must map to HttpSseTransport");
        } finally {
            transport.close();
        }
    }
}
