package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;

import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The optional / "extra credit" MCP transport: JSON-RPC 2.0 over HTTP with an
 * SSE reply. This is the secondary path — the primary teaching transport is
 * {@link StdioTransport}. Each call is a straightforward request/response:
 * <b>POST</b> the JSON-RPC frame to the configured URL, then read the
 * {@code text/event-stream} body and pull the JSON-RPC {@code result} out of the
 * {@code data:} line(s). It handles the request/response subset of MCP's
 * Streamable-HTTP transport — enough to {@code initialize}, {@code tools/list}
 * and {@code tools/call} against a server that answers each POST with one SSE
 * frame.
 *
 * <p>Built on spring-web's {@link RestClient} (already allowed in the core, as the
 * Ollama provider uses it), so the core stays container-free — no Spring Boot,
 * no reactive types.</p>
 */
public final class HttpSseTransport implements McpTransport {

    private static final Logger LOG = LoggerFactory.getLogger(HttpSseTransport.class);

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(20);
    private static final String PROTOCOL_VERSION = "2024-11-05";

    private final RestClient http;
    private final String url;
    private final AtomicLong nextId = new AtomicLong(1);

    /**
     * Connects with the default timeout.
     *
     * @param config server entry carrying the target {@code url}
     */
    public HttpSseTransport(McpServerConfig config) {
        this(config, DEFAULT_TIMEOUT);
    }

    /**
     * Builds a {@link RestClient} with finite connect and read bounds — a silent
     * server surfaces as an error, never a hang.
     *
     * @param config  server entry carrying the target {@code url}
     * @param timeout connect and read bound applied to every HTTP exchange
     */
    public HttpSseTransport(McpServerConfig config, Duration timeout) {
        this.url = config.url();
        var factory = new org.springframework.http.client.SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) timeout.toMillis());
        factory.setReadTimeout((int) timeout.toMillis());
        this.http = RestClient.builder().requestFactory(factory).build();
    }

    /**
     * Performs the {@code initialize} handshake, posts the mandatory
     * {@code notifications/initialized} follow-up, and pulls out the fields spectroscope keeps.
     *
     * @return the negotiated protocol version, server name, and raw capabilities
     */
    @Override
    public McpInitializeResult initialize() {
        ObjectNode params = JSON.createObjectNode();
        params.put("protocolVersion", PROTOCOL_VERSION);
        params.set("capabilities", JSON.createObjectNode());
        ObjectNode clientInfo = JSON.createObjectNode();
        clientInfo.put("name", "spectroscope");
        clientInfo.put("version", "1.0");
        params.set("clientInfo", clientInfo);

        JsonNode result = request("initialize", params);
        // Per MCP, the client posts an 'initialized' notification after the handshake.
        notify("notifications/initialized");

        String protocol = result.path("protocolVersion").asText(PROTOCOL_VERSION);
        String serverName = result.path("serverInfo").path("name").asText(null);
        JsonNode capabilities = result.get("capabilities");
        return new McpInitializeResult(protocol, serverName, capabilities);
    }

    /**
     * Fetches {@code tools/list}; a single malformed descriptor is skipped with a
     * stderr note rather than failing the whole list.
     *
     * @return the advertised tools, in server order
     */
    @Override
    public List<McpToolDescriptor> listTools() {
        JsonNode result = request("tools/list", null);
        JsonNode tools = result.path("tools");
        List<McpToolDescriptor> descriptors = new ArrayList<>();
        if (tools.isArray()) {
            for (JsonNode tool : tools) {
                try {
                    descriptors.add(JSON.treeToValue(tool, McpToolDescriptor.class));
                } catch (IOException malformed) {
                    LOG.warn("skipping malformed MCP tool descriptor: {}", malformed.getMessage());
                }
            }
        }
        return descriptors;
    }

    /**
     * Issues {@code tools/call} and reduces the reply's content blocks to plain text.
     *
     * @param toolName  remote tool name as advertised by {@code tools/list}
     * @param arguments JSON arguments object; {@code null} becomes an empty object
     * @return the joined text blocks, or the raw result JSON for unexpected shapes
     */
    @Override
    public String callTool(String toolName, JsonNode arguments) {
        ObjectNode params = JSON.createObjectNode();
        params.put("name", toolName);
        params.set("arguments", arguments != null ? arguments : JSON.createObjectNode());

        JsonNode result = request("tools/call", params);
        return extractText(result);
    }

    /** Idempotent, never throws — nothing to release for a stateless request/response client. */
    @Override
    public void close() {
        // No persistent connection or process to tear down.
    }

    // ---- JSON-RPC over HTTP/SSE --------------------------------------------

    /**
     * POST a JSON-RPC request; read the SSE reply and return its {@code result} member.
     *
     * @param method JSON-RPC method name, e.g. {@code tools/call}
     * @param params parameters object, or {@code null} for parameterless methods
     * @return the {@code result} node — a JSON null node when the member is absent
     */
    private JsonNode request(String method, JsonNode params) {
        long id = nextId.getAndIncrement();
        JsonRpcRequest frame = new JsonRpcRequest(id, method, params);
        String body = post(frame);

        String data = extractSseData(body);
        JsonRpcResponse response;
        try {
            response = JSON.readValue(data, JsonRpcResponse.class);
        } catch (IOException malformed) {
            throw new RuntimeException("malformed JSON-RPC response to '" + method + "': " + data, malformed);
        }
        if (response.error() != null) {
            JsonRpcError error = response.error();
            throw new RuntimeException("MCP error " + error.code() + " on '" + method + "': " + error.message());
        }
        if (response.id() == null || !response.id().isNumber() || response.id().asLong() != id) {
            throw new RuntimeException("JSON-RPC id mismatch on '" + method + "': expected " + id
                    + ", got " + (response.id() == null ? "null" : response.id()));
        }
        return response.result() != null ? response.result() : JSON.nullNode();
    }

    /**
     * A notification carries no id and expects no reply, so the SSE body is ignored.
     *
     * @param method JSON-RPC method name, e.g. {@code notifications/initialized}
     */
    private void notify(String method) {
        post(new JsonRpcRequest(null, method, null));
    }

    /**
     * POST one JSON-RPC frame, requesting an SSE reply; return the raw response body.
     *
     * @param frame request or notification to put on the wire
     * @return the response body as text — empty, never {@code null}
     */
    private String post(JsonRpcRequest frame) {
        try {
            String payload = JSON.writeValueAsString(frame);
            String reply = http.post()
                    .uri(url)
                    .contentType(MediaType.APPLICATION_JSON)
                    .accept(MediaType.TEXT_EVENT_STREAM, MediaType.APPLICATION_JSON)
                    .body(payload)
                    .retrieve()
                    .body(String.class);
            return reply != null ? reply : "";
        } catch (com.fasterxml.jackson.core.JsonProcessingException serialize) {
            throw new RuntimeException("failed to serialize JSON-RPC frame for '" + frame.method() + "'", serialize);
        } catch (RuntimeException http) {
            throw new RuntimeException("HTTP/SSE MCP request '" + frame.method() + "' to " + url
                    + " failed: " + http.getMessage(), http);
        }
    }

    /**
     * Pull the JSON payload out of an SSE body. An SSE stream is line-oriented;
     * the JSON-RPC response rides on {@code data:} line(s), which are concatenated
     * (per the SSE spec, multiple {@code data:} lines join with newlines). If the
     * body is not SSE-framed (a plain JSON reply), it is returned as-is.
     *
     * @param body raw HTTP response body, possibly SSE-framed
     * @return the extracted JSON payload — empty for a blank body
     */
    private static String extractSseData(String body) {
        if (body == null || body.isBlank()) {
            return "";
        }
        if (!body.contains("data:")) {
            // Not SSE-framed — treat the whole body as the JSON reply.
            return body.trim();
        }
        StringBuilder data = new StringBuilder();
        for (String raw : body.split("\n", -1)) {
            String line = raw.endsWith("\r") ? raw.substring(0, raw.length() - 1) : raw;
            if (line.startsWith("data:")) {
                if (data.length() > 0) {
                    data.append('\n');
                }
                // Strip "data:" and a single optional leading space.
                String value = line.substring("data:".length());
                if (value.startsWith(" ")) {
                    value = value.substring(1);
                }
                data.append(value);
            }
        }
        return data.toString();
    }

    /**
     * MCP {@code tools/call} returns {@code content: [{ type, text }, ...]}. Join the
     * text of the text blocks; fall back to the raw result JSON if the shape is unexpected.
     * (Mirrors {@link StdioTransport}'s extraction so both transports behave identically.)
     *
     * @param result the JSON-RPC {@code result} member of a {@code tools/call}
     * @return joined text blocks, or the raw result JSON when no text block exists
     */
    private static String extractText(JsonNode result) {
        JsonNode content = result.path("content");
        if (content.isArray() && !content.isEmpty()) {
            StringBuilder sb = new StringBuilder();
            for (JsonNode block : content) {
                if ("text".equals(block.path("type").asText())) {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append(block.path("text").asText());
                }
            }
            if (sb.length() > 0) {
                return sb.toString();
            }
        }
        return result.toString();
    }
}
