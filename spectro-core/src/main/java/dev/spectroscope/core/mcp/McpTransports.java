package dev.spectroscope.core.mcp;

import java.nio.file.Path;
import java.util.function.Function;

/**
 * The default transport factory: given the project working directory, hand back a
 * {@code Function<McpServerConfig, McpTransport>} that {@link McpServerRegistry}
 * uses to connect. STDIO configs (a {@code command}) spawn a {@link StdioTransport};
 * HTTP/SSE configs (a {@code url}, optionally {@code type:"sse"}) get an
 * {@link HttpSseTransport} — the optional secondary transport.
 */
public final class McpTransports {

    /** Static factory only — never instantiated. */
    private McpTransports() {}

    /**
     * The production wiring: pick the transport by {@link McpServerConfig#transportKind()}.
     *
     * @param cwd project directory a spawned stdio server runs in
     * @return the factory handed to {@link McpServerRegistry#load}
     */
    public static Function<McpServerConfig, McpTransport> defaultFactory(Path cwd) {
        return config -> switch (config.transportKind()) {
            case STDIO -> new StdioTransport(config, cwd);
            case HTTP_SSE -> new HttpSseTransport(config);
        };
    }
}
