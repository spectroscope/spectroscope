package dev.spectroscope.core.local;

import com.sun.net.httpserver.HttpServer;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

/**
 * The child half of the reaper proof: a separate JVM whose {@link LocalRuntime}
 * launches a real long-running OS process ({@code sleep}, standing in for
 * {@code llama-server}) through the launch seam, then blocks forever. The
 * parent SIGTERMs this JVM — exactly how a supervised spectro-server dies —
 * and the grandchild must die with it, not orphan.
 */
final class LocalReaperProofChild {

    private LocalReaperProofChild() {
    }

    public static void main(String[] args) throws Exception {
        LocalRuntime runtime = new LocalRuntime((model, port) -> {
            HttpServer health = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
            health.createContext("/v1/models", ex -> {
                byte[] body = "{\"data\":[]}".getBytes(StandardCharsets.UTF_8);
                ex.sendResponseHeaders(200, body.length);
                ex.getResponseBody().write(body);
                ex.close();
            });
            health.start();
            Process sleeper = new ProcessBuilder("sleep", "3600").start();
            System.out.println("sleeper-pid:" + sleeper.pid());
            return () -> {
                sleeper.destroy();
                health.stop(0);
            };
        }, "proof-model");
        runtime.ensureRunning(Path.of("proof.gguf")).orElseThrow();
        System.out.println("ready");
        Thread.sleep(Long.MAX_VALUE);
    }
}
