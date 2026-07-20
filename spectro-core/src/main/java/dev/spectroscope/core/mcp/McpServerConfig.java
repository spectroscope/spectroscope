package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.List;
import java.util.Map;

/**
 * One entry of the {@code mcpServers} config block — the same shape Claude
 * Desktop and Claude Code use, so a config written for those drops straight in.
 * A stdio server sets {@code command} (+ optional {@code args}/{@code env}); an
 * HTTP/SSE server sets {@code url} (+ optional {@code type}, e.g. {@code "sse"}).
 *
 * @param name    the entry's key in the {@code mcpServers} block — becomes the
 *                {@code <server>} segment of every {@code mcp__<server>__<tool>}
 * @param command executable to spawn for a stdio server, {@code null} for HTTP/SSE
 * @param args    extra command-line arguments, may be {@code null}
 * @param env     extra environment variables for the spawned process, may be {@code null}
 * @param url     endpoint of an HTTP/SSE server, {@code null} for stdio
 * @param type    optional transport hint, e.g. {@code "sse"} — informational only
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record McpServerConfig(
        String name,
        String command,
        List<String> args,
        Map<String, String> env,
        String url,
        String type) {

    /** How this server is reached; {@code command} takes precedence over {@code url}. */
    public enum TransportKind { STDIO, HTTP_SSE }

    /**
     * STDIO when a {@code command} is set, HTTP_SSE when only a {@code url} is
     * set. A config with neither is malformed — the registry skips it — so this
     * defaults to STDIO rather than throwing (kind is only read for a valid entry).
     */
    public TransportKind transportKind() {
        if (command != null && !command.isBlank()) {
            return TransportKind.STDIO;
        }
        if (url != null && !url.isBlank()) {
            return TransportKind.HTTP_SSE;
        }
        return TransportKind.STDIO;
    }

    /** Convenience null-safe args for callers that build a {@link ProcessBuilder}. */
    public List<String> argsOrEmpty() {
        return args == null ? List.of() : args;
    }

    /** Convenience null-safe env for callers that build a {@link ProcessBuilder}. */
    public Map<String, String> envOrEmpty() {
        return env == null ? Map.of() : env;
    }
}
