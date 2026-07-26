package dev.spectroscope.server;

import dev.spectroscope.core.local.LocalCatalog;
import dev.spectroscope.core.local.LocalModel;
import dev.spectroscope.core.local.LocalProviderFactory;
import dev.spectroscope.core.local.LocalRuntime;
import dev.spectroscope.core.local.ModelResolution;
import dev.spectroscope.core.provider.LlmProvider;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * The one {@code llama-server} for this server process, shared across sessions.
 * Lazy: it spawns only when the built-in provider is first used, and it runs
 * whichever catalogue model the operator selected. Switching models shuts the
 * old subprocess down and starts a fresh one — a llama-server keeps serving the
 * weights it was started with, so a live runtime is only ever reused for the
 * SAME model. The binary comes from the packaged app ({@code spectro.bundle.bin})
 * or, in dev, from {@code PATH} (a brew-installed {@code llama-server}); the
 * model file from {@link LocalModel}'s roots (bundled or downloaded).
 */
public final class ServerLocalRuntime {

    private ServerLocalRuntime() {
    }

    private static LocalRuntime runtime;
    private static String runningModelId;

    /**
     * The built-in provider for the selected catalogue model, or empty when that
     * model's file isn't present yet (the picker shows the chooser dialog).
     * Idempotent per model — the runtime starts once and is reused until the
     * selection changes.
     *
     * @param modelId the catalogue id from the session's config; null or a stale
     *                id resolve to the catalogue default, the same fallback the
     *                capability profile uses, so what runs and what is advertised
     *                never disagree
     * @return the OpenAI-compatible provider driving the local llama-server, or
     *         empty
     */
    public static synchronized Optional<LlmProvider> provider(String modelId) {
        LocalCatalog.Model entry = LocalCatalog.bundled().resolve(modelId);
        ModelResolution.Resolved model = ModelResolution.locate(
                LocalModel.bundleDir(), LocalModel.userModelsDir(), entry.file());
        if (model.source() == ModelResolution.Source.ABSENT) {
            return Optional.empty();
        }
        if (runtime != null && needsRestart(runningModelId, entry.id())) {
            runtime.shutdown();
            runtime = null;
        }
        if (runtime == null) {
            int contextTokens = entry.contextTokens();
            runtime = new LocalRuntime(
                    (file, port) -> launch(file, port, contextTokens), entry.id());
            runningModelId = entry.id();
        }
        return LocalProviderFactory.build(runtime, model.path());
    }

    /**
     * Whether a live runtime must be replaced for the requested model.
     *
     * @param running   the model the runtime was started with, or null when none runs
     * @param requested the model the operator wants now
     * @return true only when a DIFFERENT model is requested while one runs
     */
    static boolean needsRestart(String running, String requested) {
        return running != null && !Objects.equals(running, requested);
    }

    /**
     * The llama-server invocation, assembled pure so the flags are testable.
     *
     * @param binary        the llama-server executable
     * @param model         the GGUF path
     * @param port          the loopback port
     * @param contextTokens the catalogue model's context window
     * @return the full command line
     */
    static List<String> buildCommand(String binary, Path model, int port, int contextTokens) {
        return List.of(binary,
                "-m", model.toString(),
                "--host", "127.0.0.1",
                "--port", String.valueOf(port),
                "-c", String.valueOf(contextTokens),
                "--jinja");
    }

    /** Exec {@code llama-server} on the model + port; the runtime's JVM
     *  shutdown-hook reaper closes the handle, so the child dies with the JVM. */
    private static AutoCloseable launch(Path model, int port, int contextTokens) throws Exception {
        ProcessBuilder pb = new ProcessBuilder(
                buildCommand(binary(), model, port, contextTokens));
        pb.redirectErrorStream(true);
        pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
        Process process = pb.start();
        return process::destroy;
    }

    /** The llama-server binary: bundled next to the app if packaged, else PATH. */
    private static String binary() {
        Path bundled = bundledBinary();
        return bundled != null ? bundled.toString() : "llama-server"; // dev / brew: on PATH
    }

    /** @return the bundled binary when the packaged app set and shipped one, else null */
    private static Path bundledBinary() {
        String dir = System.getProperty("spectro.bundle.bin");
        if (dir == null || dir.isBlank()) {
            return null;
        }
        Path b = Path.of(dir, "llama-server");
        return Files.isExecutable(b) ? b : null;
    }

    /**
     * Whether a {@code llama-server} exists for this install at all. The desktop
     * run kit bundles one, so the built-in path needs nothing installed; the bare
     * server jar and the CLI do not, and there the operator supplies it
     * ({@code brew install llama.cpp}). The chooser asks this before promising a
     * model will run, because a missing binary otherwise surfaces as a spawn that
     * fails after a multi-gigabyte download.
     *
     * @return true when a bundled or PATH llama-server is executable
     */
    public static boolean binaryAvailable() {
        if (bundledBinary() != null) {
            return true;
        }
        String path = System.getenv("PATH");
        if (path == null || path.isBlank()) {
            return false;
        }
        for (String entry : path.split(java.io.File.pathSeparator)) {
            if (entry.isBlank()) {
                continue;
            }
            try {
                if (Files.isExecutable(Path.of(entry, "llama-server"))) {
                    return true;
                }
            } catch (RuntimeException malformedEntry) {
                // a junk PATH entry is not an answer either way — keep looking
            }
        }
        return false;
    }
}
