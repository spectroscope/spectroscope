package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * The primary MCP transport: spawn the server as a child process and speak
 * JSON-RPC 2.0 over its stdin/stdout. MCP stdio reserves <b>stdout for the
 * protocol</b> and <b>stderr for logs</b>, so the process's stderr is redirected
 * to a per-server log file — never mixed into the JSON stream — and only stdout
 * is wrapped by the {@link JsonRpcChannel}.
 *
 * <p>The handshake is {@code initialize} → {@code notifications/initialized} →
 * (later) {@code tools/list} / {@code tools/call}. Follows the process patterns of
 * {@code StandardTools.runCommand}: {@link ProcessBuilder}, and on {@link #close()}
 * a graceful {@code destroy} escalating to {@code destroyForcibly}.
 */
public final class StdioTransport implements McpTransport {

    private static final Logger LOG = LoggerFactory.getLogger(StdioTransport.class);

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Duration DEFAULT_READ_TIMEOUT = Duration.ofSeconds(20);
    private static final String PROTOCOL_VERSION = "2024-11-05";

    private final JsonRpcChannel channel;
    private final Runnable onClose;

    /**
     * Package-visible seam for tests: drive the MCP method mapping over an
     * arbitrary channel (in-memory pipes) with no process. {@code onClose} lets a
     * test observe teardown; production wraps process destruction here.
     *
     * @param channel the JSON-RPC framing to speak over
     * @param onClose teardown hook, run after the channel is closed
     */
    StdioTransport(JsonRpcChannel channel, Runnable onClose) {
        this.channel = channel;
        this.onClose = onClose;
    }

    /**
     * Spawn the configured command and wire a channel to its stdio.
     *
     * @param config command, args, and env of the server to spawn
     * @param cwd    working directory for the child process, or {@code null} to inherit
     */
    public StdioTransport(McpServerConfig config, Path cwd) {
        this(config, cwd, DEFAULT_READ_TIMEOUT);
    }

    /**
     * Spawn with an explicit per-request read timeout — tests shorten it to keep
     * dead-server cases fast.
     *
     * @param config      command, args, and env of the server to spawn
     * @param cwd         working directory for the child process, or {@code null} to inherit
     * @param readTimeout upper bound a single request waits for its response line
     */
    public StdioTransport(McpServerConfig config, Path cwd, Duration readTimeout) {
        Process process = spawn(config, cwd);
        BufferedReader in = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
        BufferedWriter out = new BufferedWriter(
                new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
        this.channel = new JsonRpcChannel(in, out, readTimeout);
        this.onClose = () -> destroy(process);
    }

    /**
     * Start the child process with stdout reserved for JSON-RPC — stderr is redirected
     * away so server logs can never pollute the protocol stream.
     *
     * @param config command, args, and env to launch with
     * @param cwd    working directory, or {@code null} to inherit the parent's
     * @return the running process
     */
    private static Process spawn(McpServerConfig config, Path cwd) {
        List<String> command = new ArrayList<>();
        command.add(config.command());
        command.addAll(config.argsOrEmpty());

        ProcessBuilder builder = new ProcessBuilder(command);
        if (cwd != null) {
            builder.directory(cwd.toFile());
        }
        builder.environment().putAll(config.envOrEmpty());
        // stdout is the JSON-RPC channel; stderr is server logs, kept out of the protocol stream.
        builder.redirectError(stderrLogFor(config));
        try {
            return builder.start();
        } catch (IOException failed) {
            throw new UncheckedIOException("failed to spawn MCP server '" + config.name()
                    + "' (" + config.command() + ")", failed);
        }
    }

    /**
     * Per-server stderr log under the temp dir; keeps server chatter out of the JSON-RPC stdout.
     *
     * @param config names the log file, one per server
     * @return an append redirect to the log, or the null device if it cannot be opened
     */
    private static ProcessBuilder.Redirect stderrLogFor(McpServerConfig config) {
        try {
            Path log = Path.of(System.getProperty("java.io.tmpdir"),
                    "spectroscope-mcp-" + config.name() + ".log");
            return ProcessBuilder.Redirect.appendTo(log.toFile());
        } catch (RuntimeException ignored) {
            // If we cannot open a log file, discard stderr rather than risk it polluting stdout.
            return ProcessBuilder.Redirect.to(new File(nullDevice()));
        }
    }

    /** The platform's discard device: {@code NUL} on Windows, {@code /dev/null} elsewhere. */
    private static String nullDevice() {
        return File.separatorChar == '\\' ? "NUL" : "/dev/null";
    }

    /**
     * The stdio handshake: sends {@code initialize}, follows up with the mandatory
     * {@code notifications/initialized}, and pulls out the fields spectroscope keeps.
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

        JsonNode result = channel.request("initialize", params);
        // Per MCP, the client must send an 'initialized' notification after the handshake.
        channel.notify("notifications/initialized", null);

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
        JsonNode result = channel.request("tools/list", null);
        JsonNode tools = result.path("tools");
        List<McpToolDescriptor> descriptors = new ArrayList<>();
        if (tools.isArray()) {
            for (JsonNode tool : tools) {
                try {
                    descriptors.add(JSON.treeToValue(tool, McpToolDescriptor.class));
                } catch (IOException malformed) {
                    // Skip a single malformed descriptor rather than fail the whole list.
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

        JsonNode result = channel.request("tools/call", params);
        return extractText(result);
    }

    /**
     * MCP {@code tools/call} returns {@code content: [{ type, text }, ...]}. Join the
     * text of the text blocks; fall back to the raw result JSON if the shape is unexpected.
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
        // Unexpected shape (or a non-text content type): hand back the raw result verbatim.
        return result.toString();
    }

    /**
     * Close the channel first (releasing the streams), then run the process teardown —
     * both defensively, because {@code close()} must never throw.
     */
    @Override
    public void close() {
        try {
            channel.close();
        } catch (RuntimeException ignored) {
            // channel.close is contractually quiet; be defensive anyway.
        }
        try {
            onClose.run();
        } catch (RuntimeException ignored) {
            // teardown must never throw out of close().
        }
    }

    /**
     * Graceful destroy escalating to force, mirroring StandardTools.runCommand's kill path.
     *
     * @param process the spawned server, may be {@code null} or already dead
     */
    private static void destroy(Process process) {
        if (process == null || !process.isAlive()) {
            return;
        }
        process.destroy();
        try {
            if (!process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) {
                process.destroyForcibly();
            }
        } catch (InterruptedException interrupted) {
            process.destroyForcibly();
            Thread.currentThread().interrupt();
        }
    }
}
