package dev.spectroscope.server;

import dev.spectroscope.core.local.LocalModel;
import dev.spectroscope.core.local.LocalProviderFactory;
import dev.spectroscope.core.local.LocalRuntime;
import dev.spectroscope.core.local.ModelResolution;
import dev.spectroscope.core.provider.LlmProvider;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;

/**
 * The one bundled {@code llama-server} for this server process, shared across
 * sessions. Lazy: it spawns only when the built-in provider is first used. The
 * binary comes from the packaged app ({@code spectro.bundle.bin}) or, in dev,
 * from {@code PATH} (a brew-installed {@code llama-server}); the model from
 * {@link LocalModel} (bundled or downloaded).
 */
public final class ServerLocalRuntime {

    private ServerLocalRuntime() {
    }

    private static LocalRuntime runtime;

    /**
     * The built-in provider, or empty when the model isn't present yet (the
     * picker shows the download modal). Idempotent — the runtime starts once.
     *
     * @return the OpenAI-compatible provider driving the local llama-server, or
     *         empty
     */
    public static synchronized Optional<LlmProvider> provider() {
        ModelResolution.Resolved model = ModelResolution.locate(
                LocalModel.bundleDir(), LocalModel.userModelsDir(), LocalModel.FILE);
        if (model.source() == ModelResolution.Source.ABSENT) {
            return Optional.empty();
        }
        if (runtime == null) {
            runtime = new LocalRuntime(ServerLocalRuntime::launch, LocalModel.MODEL_ID);
        }
        return LocalProviderFactory.build(runtime, model.path());
    }

    /** Exec {@code llama-server} on the model + port; the handle destroys it on shutdown. */
    private static AutoCloseable launch(Path model, int port) throws Exception {
        ProcessBuilder pb = new ProcessBuilder(binary(),
                "-m", model.toString(),
                "--host", "127.0.0.1",
                "--port", String.valueOf(port),
                "-c", "4096",
                "--jinja");
        pb.redirectErrorStream(true);
        pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
        Process process = pb.start();
        return process::destroy;
    }

    /** The llama-server binary: bundled next to the app if packaged, else PATH. */
    private static String binary() {
        String bundled = System.getProperty("spectro.bundle.bin");
        if (bundled != null && !bundled.isBlank()) {
            Path b = Path.of(bundled, "llama-server");
            if (Files.isExecutable(b)) {
                return b.toString();
            }
        }
        return "llama-server"; // dev / brew: on PATH
    }
}
