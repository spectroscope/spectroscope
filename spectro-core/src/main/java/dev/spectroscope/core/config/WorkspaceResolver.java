package dev.spectroscope.core.config;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Resolves the agent's <b>workspace</b> — the directory the agent works in
 * (file-tool sandbox root, glob/grep search root and run_command working
 * directory). A configured directory wins; without one, every session gets a
 * deterministic folder under the OS temp dir keyed by its session id, so a
 * resume of the same session finds its files again. The project (config
 * layers, skills, MCP servers, SPECTRO.md) stays anchored at the process CWD —
 * only the agent's working world moves.
 */
public final class WorkspaceResolver {

    /** The parent folder for auto workspaces under the OS temp dir. */
    private static final String AUTO_WORKSPACE_DIR = "spectroscope-ws";

    private WorkspaceResolver() {
    }

    /**
     * Resolves the workspace and ensures it exists.
     *
     * @param configured the configured workspace path ({@code ~} expands to the
     *                   user home), or {@code null}/blank for the per-session
     *                   temp folder
     * @param sessionId  the session the auto workspace is keyed by; required
     *                   when no workspace is configured
     * @return the absolute, normalized workspace directory (created if absent)
     * @throws IllegalStateException when the resolved path exists but is not a
     *                               directory
     */
    public static Path resolve(String configured, String sessionId) {
        Path workspace = locate(configured, sessionId);
        if (Files.exists(workspace) && !Files.isDirectory(workspace)) {
            throw new IllegalStateException(
                    "Workspace path exists but is not a directory: " + workspace);
        }
        try {
            Files.createDirectories(workspace);
        } catch (IOException cannotCreate) {
            throw new UncheckedIOException("Cannot create workspace " + workspace, cannotCreate);
        }
        return workspace;
    }

    /**
     * Names the workspace WITHOUT creating anything — the read-only twin of
     * {@link #resolve} for REST lookups (the caller answers 404 when the
     * folder does not exist).
     *
     * @param configured the configured workspace path or {@code null}/blank
     * @param sessionId  the session key for the auto workspace
     * @return the absolute, normalized path the workspace would live at
     */
    public static Path locate(String configured, String sessionId) {
        if (configured != null && !configured.isBlank()) {
            return expandHome(configured.strip()).toAbsolutePath().normalize();
        }
        if (sessionId == null || sessionId.isBlank()) {
            throw new IllegalArgumentException(
                    "A session id is required when no workspace is configured.");
        }
        return Path.of(System.getProperty("java.io.tmpdir"), AUTO_WORKSPACE_DIR, sessionId)
                .toAbsolutePath().normalize();
    }

    /**
     * Expands a leading {@code ~} to the user home — the same convention the
     * MCP server configs use.
     *
     * @param path the raw configured path
     * @return the expanded path
     */
    private static Path expandHome(String path) {
        if (path.equals("~")) {
            return Path.of(System.getProperty("user.home"));
        }
        if (path.startsWith("~/")) {
            return Path.of(System.getProperty("user.home"), path.substring(2));
        }
        return Path.of(path);
    }
}
