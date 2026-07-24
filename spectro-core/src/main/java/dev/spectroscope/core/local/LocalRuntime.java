package dev.spectroscope.core.local;

import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Optional;

/**
 * Supervises one {@code llama-server} subprocess on a free localhost port. Lazy
 * and idempotent: {@link #ensureRunning} starts it once, later calls return the
 * live endpoint. The binary launch is a seam ({@link Launcher}) so tests drive a
 * stub without a real binary or a multi-GB model.
 *
 * <p>The health budget is generous by default (a real llama-server loading a
 * multi-GB model into memory + Metal can take tens of seconds before it answers)
 * but injectable, so tests for the never-healthy path stay fast.</p>
 */
public final class LocalRuntime {

    /** Starts the runtime on {@code port} for {@code model}; the returned handle
     *  is closed on shutdown. Production execs the bundled binary; tests bind a
     *  stub HTTP server. */
    public interface Launcher {
        AutoCloseable start(Path model, int port) throws Exception;
    }

    /** A running local endpoint: the OpenAI-compatible base url and the model id. */
    public record LocalEndpoint(String baseUrl, String model) {}

    private static final Duration DEFAULT_HEALTH_BUDGET = Duration.ofSeconds(60);

    private final Launcher launcher;
    private final String model;
    private final Duration healthBudget;

    private AutoCloseable process;
    private LocalEndpoint endpoint;

    /** Production wiring — a 60s health budget for a cold multi-GB model load. */
    public LocalRuntime(Launcher launcher, String model) {
        this(launcher, model, DEFAULT_HEALTH_BUDGET);
    }

    /** Seam constructor — tests pass a short budget for the never-healthy path. */
    LocalRuntime(Launcher launcher, String model, Duration healthBudget) {
        this.launcher = launcher;
        this.model = model;
        this.healthBudget = healthBudget;
    }

    /**
     * Ensure the runtime is up and return its endpoint. Idempotent — a second
     * call returns the live endpoint without re-launching.
     *
     * @param modelFile the resolved GGUF path
     * @return the endpoint, or empty when the server never became healthy (the
     *         caller surfaces a readable message; nothing hangs)
     */
    public synchronized Optional<LocalEndpoint> ensureRunning(Path modelFile) {
        if (endpoint != null) {
            return Optional.of(endpoint);
        }
        try {
            int port;
            try (ServerSocket probe = new ServerSocket(0)) {
                port = probe.getLocalPort();
            }
            process = launcher.start(modelFile, port);
            String base = "http://127.0.0.1:" + port;
            if (!healthy(base)) {
                shutdown();
                return Optional.empty();
            }
            endpoint = new LocalEndpoint(base, model);
            return Optional.of(endpoint);
        } catch (Exception failed) {
            shutdown();
            return Optional.empty();
        }
    }

    /** Poll {@code /v1/models} until 200 or the health budget elapses. */
    private boolean healthy(String base) {
        HttpClient client = HttpClient.newHttpClient();
        long deadline = System.nanoTime() + healthBudget.toNanos();
        while (System.nanoTime() < deadline) {
            try {
                HttpResponse<Void> resp = client.send(
                        HttpRequest.newBuilder(URI.create(base + "/v1/models"))
                                .timeout(Duration.ofMillis(500)).GET().build(),
                        HttpResponse.BodyHandlers.discarding());
                if (resp.statusCode() == 200) {
                    return true;
                }
            } catch (Exception notUpYet) {
                // keep polling
            }
            try {
                Thread.sleep(100);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return false;
    }

    /** Reap the subprocess and forget the endpoint. Safe to call repeatedly. */
    public synchronized void shutdown() {
        endpoint = null;
        if (process != null) {
            try {
                process.close();
            } catch (Exception ignore) {
                // best-effort reap
            }
            process = null;
        }
    }
}
