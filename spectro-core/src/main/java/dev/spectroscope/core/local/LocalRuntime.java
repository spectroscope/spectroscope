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
 * stub without a real binary or a multi-GB model. While a subprocess is live, a
 * JVM shutdown hook reaps it — a SIGTERM'd host never orphans its llama-server;
 * a normal {@link #shutdown} deregisters the hook again.
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
        AutoCloseable start(Path model, int port, String apiKey) throws Exception;
    }

    /** A running local endpoint: the base url, the model id, and the key that
     *  this launch requires. The key is minted per launch and never persisted —
     *  it exists only to make a loopback port that anything on the machine can
     *  reach into one that only this process can use. */
    public record LocalEndpoint(String baseUrl, String model, String apiKey) {}

    private static final Duration DEFAULT_HEALTH_BUDGET = Duration.ofSeconds(60);

    private final Launcher launcher;
    private final String model;
    private final Duration healthBudget;

    private AutoCloseable process;
    private LocalEndpoint endpoint;
    Thread reaper; // JVM shutdown hook while a subprocess is live (package-visible for tests)

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
            // A fresh secret per launch. llama.cpp answers every origin with
            // `Access-Control-Allow-Origin: *`, so without this any page the
            // operator has open can sweep loopback, call the model and read the
            // reply. Never written to disk, never logged, dies with the process.
            String key = mintKey();
            process = launcher.start(modelFile, port, key);
            reaper = new Thread(this::shutdown, "spectro-local-reaper");
            Runtime.getRuntime().addShutdownHook(reaper);
            String base = "http://127.0.0.1:" + port;
            if (!healthy(base, key)) {
                shutdown();
                return Optional.empty();
            }
            endpoint = new LocalEndpoint(base, model, key);
            return Optional.of(endpoint);
        } catch (Exception failed) {
            shutdown();
            return Optional.empty();
        }
    }

    /** Poll {@code /v1/models} until 200 or the health budget elapses. */
    private static String mintKey() {
        byte[] raw = new byte[24];
        new java.security.SecureRandom().nextBytes(raw);
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    }

    private boolean healthy(String base, String apiKey) {
        HttpClient client = HttpClient.newHttpClient();
        long deadline = System.nanoTime() + healthBudget.toNanos();
        while (System.nanoTime() < deadline) {
            try {
                HttpResponse<Void> resp = client.send(
                        HttpRequest.newBuilder(URI.create(base + "/v1/models"))
                                .header("Authorization", "Bearer " + apiKey)
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

    /** Reap the subprocess, drop the reaper hook and forget the endpoint. Safe
     *  to call repeatedly — and it is what the reaper itself runs at JVM
     *  shutdown, so a SIGTERM'd host never orphans its llama-server. */
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
        if (reaper != null) {
            try {
                Runtime.getRuntime().removeShutdownHook(reaper);
            } catch (IllegalStateException jvmAlreadyShuttingDown) {
                // the reaper itself invoked us — nothing left to deregister
            }
            reaper = null;
        }
    }
}
