package dev.spectroscope.server;

import dev.spectroscope.core.config.WorkspaceResolver;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * Where a shell starts. The card's promise is that "the shell shares the agent's
 * world", so this resolves by exactly the rules {@link WorkspaceController} uses
 * for the Files tree: the folder the operator picked wins, then the configured
 * workspace, then the per-session auto folder.
 *
 * <p>The session id is the only thing a client contributes to a path here, and it
 * is shape-checked first — the same guard the sessions DELETE wears. Unlike
 * {@code /api/files}, a missing session is refused rather than falling back to the
 * server's own working directory: a shell in the wrong folder is worse than no
 * shell.</p>
 */
final class ShellCwd {

    private static final Pattern ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]*");

    private ShellCwd() {
    }

    /**
     * Name the directory without creating anything.
     *
     * @param sessionId           the session the tab belongs to
     * @param configuredWorkspace supplies the config's workspace key (nullable)
     * @return the absolute, normalized directory the shell should start in
     * @throws IllegalArgumentException for a missing or malformed session id
     */
    static Path locate(String sessionId, Supplier<String> configuredWorkspace) {
        if (sessionId == null || sessionId.isBlank()) {
            throw new IllegalArgumentException("a shell needs a session");
        }
        if (!ID.matcher(sessionId).matches()) {
            throw new IllegalArgumentException("malformed session id");
        }
        String pinned = SessionWorkspaces.pinned(sessionId);
        return WorkspaceResolver.locate(
                pinned != null ? pinned : configuredWorkspace.get(), sessionId);
    }

    /**
     * Name the directory and make sure it exists — a shell cannot start in a
     * folder that is not there, and the agent creates the same one on its first
     * run anyway.
     *
     * @param sessionId           the session the tab belongs to
     * @param configuredWorkspace supplies the config's workspace key (nullable)
     * @return the existing directory
     * @throws IllegalArgumentException for a missing or malformed session id
     * @throws IOException             when the directory cannot be created
     */
    static Path ensure(String sessionId, Supplier<String> configuredWorkspace) throws IOException {
        Path directory = locate(sessionId, configuredWorkspace);
        Files.createDirectories(directory);
        return directory;
    }
}
