package dev.spectroscope.core.mcp;

import dev.spectroscope.core.tools.Tool;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/**
 * The façade the faces use: given the {@code mcpServers} config block, it
 * connects <b>eagerly</b> to each server, wraps every advertised remote tool as
 * an {@link McpTool}, and collects them for registration alongside the standard
 * tools. Modeled on {@link dev.spectroscope.core.skills.SkillLibrary}'s registry pattern —
 * <i>not</i> its progressive-disclosure model: MCP tools are advertised in full.
 *
 * <p>A server that fails to start or initialize is logged as a warning and
 * <b>skipped</b>; startup continues with the remaining servers, so one broken
 * entry never brings the harness down. The transport is injected as a factory so
 * tests drive it with an in-memory fake.
 */
public final class McpServerRegistry {

    private static final Logger LOG = LoggerFactory.getLogger(McpServerRegistry.class);

    private final List<McpClient> clients;
    private final List<Tool> tools;
    private final List<McpServerHandle> handles;

    /**
     * Built by {@link #load} only — the registry is immutable after construction.
     *
     * @param clients one connected client per reachable server
     * @param tools   the wrapped tools, ready for registration
     * @param handles one status row per configured server, reachable or not
     */
    private McpServerRegistry(List<McpClient> clients, List<Tool> tools, List<McpServerHandle> handles) {
        this.clients = clients;
        this.tools = tools;
        this.handles = handles;
    }

    /**
     * A small read-only view of one configured server, for {@code spectroscope doctor} and {@code /mcp}.
     *
     * @param name      configured server name
     * @param target    what spectroscope connects to — the command for stdio, the URL for HTTP/SSE
     * @param reachable whether spawn and handshake succeeded at load time
     * @param toolCount number of advertised tools, {@code 0} when unreachable
     */
    public record McpServerHandle(String name, String target, boolean reachable, int toolCount) {}

    /**
     * The convenience the faces call: connect with the real {@link McpTransports}
     * default factory (stdio spawns a process, HTTP/SSE arrives later). Delegates to
     * the factory-injecting overload used by the tests.
     *
     * @param servers the parsed {@code mcpServers} entries, may be {@code null}
     * @param cwd     project directory a spawned stdio server runs in
     * @return the registry over every server that started
     */
    public static McpServerRegistry load(List<McpServerConfig> servers, Path cwd) {
        return load(servers, cwd, McpTransports.defaultFactory(cwd));
    }

    /**
     * Connect to every configured server, skipping the ones that fail. {@code cwd}
     * is threaded through for a transport that needs the project directory (e.g. a
     * relative command); {@code transportFactory} builds a transport for a given
     * config — the seam that keeps this class testable without a process.
     *
     * @param servers          the parsed {@code mcpServers} entries, may be {@code null}
     * @param cwd              project directory, threaded to the transports
     * @param transportFactory builds a transport for one config — the test seam
     * @return the registry over every server that started
     */
    public static McpServerRegistry load(List<McpServerConfig> servers,
                                         Path cwd,
                                         Function<McpServerConfig, McpTransport> transportFactory) {
        List<McpClient> clients = new ArrayList<>();
        List<Tool> tools = new ArrayList<>();
        List<McpServerHandle> handles = new ArrayList<>();

        if (servers != null) {
            for (McpServerConfig config : servers) {
                if (config == null || config.name() == null || config.name().isBlank()) {
                    LOG.warn("skipping MCP server with no name");
                    continue;
                }
                McpClient client = new McpClient(config, () -> transportFactory.apply(config));
                try {
                    client.start();
                } catch (RuntimeException failed) {
                    LOG.warn("skipping MCP server '{}': {}", config.name(), message(failed));
                    handles.add(new McpServerHandle(config.name(), target(config), false, 0));
                    continue;
                }
                clients.add(client);
                List<McpToolDescriptor> descriptors = client.tools();
                for (McpToolDescriptor descriptor : descriptors) {
                    tools.add(new McpTool(config.name(), client, descriptor));
                }
                handles.add(new McpServerHandle(config.name(), target(config), true, descriptors.size()));
            }
        }
        return new McpServerRegistry(clients, List.copyOf(tools), List.copyOf(handles));
    }

    /** Every wrapped MCP tool across all reachable servers, in config order. */
    public List<Tool> tools() {
        return tools;
    }

    /** One handle per configured server (reachable or not), in config order. */
    public List<McpServerHandle> servers() {
        return handles;
    }

    /** Close every connection. Idempotent; never throws. */
    public void close() {
        clients.forEach(McpClient::close);
    }

    /**
     * What the handle reports as the connection target — command or URL, matching
     * the transport kind.
     *
     * @param config the server entry to describe
     * @return the stdio command, or the HTTP/SSE url
     */
    private static String target(McpServerConfig config) {
        return switch (config.transportKind()) {
            case STDIO -> config.command();
            case HTTP_SSE -> config.url();
        };
    }

    /**
     * A never-null description for the skip log line.
     *
     * @param t the startup failure
     * @return its message, or the class name when the message is {@code null}
     */
    private static String message(Throwable t) {
        return t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName();
    }
}
