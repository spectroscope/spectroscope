package dev.spectroscope.server.shell;

import dev.spectroscope.core.config.WorkspaceResolver;
import dev.spectroscope.server.session.SessionWorkspaces;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * Where a shell starts. The card's promise is that "the shell shares the agent's
 * world", so this reads the folder the run actually resolved, which is the same
 * record {@link dev.spectroscope.server.workspace.WorkspaceController} serves the Files tree from.
 *
 * <p>It used to recompute the rule instead: picked pin, then configured
 * workspace, then per-session auto folder, with the config read fresh on every
 * shell. Recomputing agreed with the tree until the configured workspace
 * changed under a running session, and then the tree and the terminal inside
 * the same pane pointed at different directories, while the settings copy
 * promises "a running session keeps its own workspace". Reading one record
 * cannot disagree with itself.</p>
 *
 * <p>The old rule survives as the fallback, and has to: a shell can be opened
 * before the first run, when nothing has been resolved yet, and naming that
 * folder in advance is what makes the tab usable at all.</p>
 *
 * <p>The session id is the only thing a client contributes to a path here, and it
 * is shape-checked first — the same guard the sessions DELETE wears. A missing
 * session is refused outright: a shell in the wrong folder is worse than no
 * shell, and {@code /api/files} answers the same request with 409.</p>
 */
final class ShellCwd {

    private static final Pattern ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]*");

    private ShellCwd() {
    }

    /**
     * Name the directory without creating anything.
     *
     * @param sessionId           the session the tab belongs to
     * @param configuredWorkspace supplies the config's workspace key (nullable),
     *                            consulted only before a run has resolved one
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
        String resolved = SessionWorkspaces.resolvedPath(sessionId);
        if (resolved != null) {
            return Path.of(resolved).toAbsolutePath().normalize();
        }
        // Nothing resolved yet: name the folder the first run would use.
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
