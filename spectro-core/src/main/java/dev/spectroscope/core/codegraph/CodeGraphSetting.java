package dev.spectroscope.core.codegraph;

import dev.spectroscope.core.config.SpectroConfig;

import java.nio.file.Path;

/**
 * Card 587, fix round (I4): the one place that says which backend a folder
 * uses. It reads the {@code codeGraphBackend} key from the user's settings,
 * the start folder's and the folder's own settings, the chain a session adopts
 * for its folder. The session's {@code code_graph} tool, the offer of the
 * {@code code-graph} skill, {@code /graph ask}, the build endpoints and the
 * System context view all ask here, on every read, so no reader keeps a value
 * another reader no longer sees.
 *
 * <p>A settings file whose value is refused costs its own scope, as at the
 * session moment: a refused folder file leaves the start folder and the user,
 * and a refused start folder file leaves the shipped backend.</p>
 */
public final class CodeGraphSetting {

    private CodeGraphSetting() {
    }

    /**
     * @param folder the folder, or null for the start folder and the user alone
     * @return the backend it uses, the start folder being the server's working directory
     */
    public static CodeGraphBackend backendFor(Path folder) {
        return backendFor(Path.of(System.getProperty("user.dir")), folder);
    }

    /**
     * @param startFolder the folder the server started in, whose settings sit below the folder's own
     * @param folder      the folder, or null for the start folder and the user alone
     * @return the backend it uses
     */
    public static CodeGraphBackend backendFor(Path startFolder, Path folder) {
        try {
            return named(SpectroConfig.loadForWorkspace(SpectroConfig.Overrides.none(), startFolder, folder)
                    .codeGraphBackend());
        } catch (RuntimeException refusedFolder) {
            try {
                return named(SpectroConfig.load(SpectroConfig.Overrides.none(), startFolder).codeGraphBackend());
            } catch (RuntimeException refusedStart) {
                return CodeGraphBackend.GRAPHIFY;
            }
        }
    }

    private static CodeGraphBackend named(String name) {
        return CodeGraphBackend.named(name).orElse(CodeGraphBackend.GRAPHIFY);
    }
}
