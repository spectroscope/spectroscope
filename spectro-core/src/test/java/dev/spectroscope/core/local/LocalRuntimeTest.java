package dev.spectroscope.core.local;

import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.net.LoopbackPorts;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** LocalRuntime supervises one llama-server on a free localhost port. The binary
 *  launch is a seam, so a stub HTTP server stands in for the real llama-server —
 *  no binary, no model, just the spawn → health-check → endpoint → reap cycle. */
class LocalRuntimeTest {

    /** A stub "llama-server": binds the given port, answers /v1/models 200. */
    private LocalRuntime.Launcher stub() {
        return (model, port, __key) -> {
            HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
            s.createContext("/v1/models", ex -> {
                byte[] b = "{\"data\":[{\"id\":\"vibethinker-3b\"}]}".getBytes(StandardCharsets.UTF_8);
                ex.sendResponseHeaders(200, b.length);
                ex.getResponseBody().write(b);
                ex.close();
            });
            s.start();
            return (AutoCloseable) () -> s.stop(0);
        };
    }

    @Test
    void startsHealthChecksAndIsIdempotent(@TempDir Path dir) throws Exception {
        Path model = Files.writeString(dir.resolve("m.gguf"), "gguf");
        LocalRuntime rt = new LocalRuntime(stub(), "vibethinker-3b");

        Optional<LocalRuntime.LocalEndpoint> a = rt.ensureRunning(model);
        assertTrue(a.isPresent());
        assertTrue(a.get().baseUrl().startsWith("http://127.0.0.1:"));
        assertEquals("vibethinker-3b", a.get().model());

        Optional<LocalRuntime.LocalEndpoint> b = rt.ensureRunning(model);
        assertEquals(a.get().baseUrl(), b.get().baseUrl(), "idempotent — same live endpoint");

        rt.shutdown();
    }

    /** A SIGTERM'd host must never orphan its llama-server: while the
     *  subprocess lives, a JVM shutdown hook reaps it; a normal shutdown()
     *  deregisters the hook again. (The end-to-end kill is pinned the
     *  process-proof way in LocalRuntimeReaperProofTest.) */
    @Test
    void reaperHookIsRegisteredWhileLiveAndDeregisteredOnShutdown(@TempDir Path dir) throws Exception {
        Path model = Files.writeString(dir.resolve("m.gguf"), "gguf");
        LocalRuntime rt = new LocalRuntime(stub(), "vibethinker-3b");
        rt.ensureRunning(model).orElseThrow();

        Thread reaper = rt.reaper;
        assertNotNull(reaper, "a live subprocess has a reaper");
        assertTrue(Runtime.getRuntime().removeShutdownHook(reaper),
                "the reaper is a registered JVM shutdown hook");
        Runtime.getRuntime().addShutdownHook(reaper); // put it back — shutdown() deregisters for real

        rt.shutdown();
        assertNull(rt.reaper, "shutdown forgets the reaper");
        assertFalse(Runtime.getRuntime().removeShutdownHook(reaper),
                "shutdown deregistered the hook — a dead runtime keeps no grip on the JVM");
    }

    /** Card 582: the launch port must be free at 127.0.0.1, the address the
     *  launcher binds. macOS hands out ports in sequence, and a wildcard bind
     *  does not see a 127.0.0.1 listener, so holding the next ports on
     *  127.0.0.1 puts a held port exactly where a wildcard probe lands. The
     *  stub's bind then fails and ensureRunning returns empty at once: the
     *  "No value present" of the 0.15.3 gate. */
    @Test
    void theLaunchPortIsNeverOneALoopbackListenerHolds(@TempDir Path dir) throws Exception {
        Path model = Files.writeString(dir.resolve("m.gguf"), "gguf");
        LocalRuntime.Launcher stub = stub();
        int[] handed = {-1};
        LocalRuntime rt = new LocalRuntime((m, port, key) -> {
            handed[0] = port;
            return stub.start(m, port, key);
        }, "vibethinker-3b");
        try (LoopbackPorts.Held held = LoopbackPorts.holdNext(64)) {
            assumeTrue(held.blindsAWildcardProbe(),
                    "this kernel did not hand a wildcard bind a held port, so it cannot show the defect");

            Optional<LocalRuntime.LocalEndpoint> endpoint = rt.ensureRunning(model);

            assertFalse(held.contains(handed[0]),
                    "the runtime handed its launcher port " + handed[0] + ", which a 127.0.0.1 listener holds");
            assertTrue(endpoint.isPresent(), "the stub on a free port answers its health check");
        } finally {
            rt.shutdown();
        }
    }

    @Test
    void aLauncherThatNeverBecomesHealthyReturnsEmpty(@TempDir Path dir) throws Exception {
        Path model = Files.writeString(dir.resolve("m.gguf"), "gguf");
        // a launcher that starts nothing on the port — health-check never goes green.
        // A short budget (the seam constructor) keeps this test fast.
        LocalRuntime rt = new LocalRuntime(
                (m, port, key) -> (AutoCloseable) () -> {}, "vibethinker-3b", Duration.ofMillis(600));
        assertFalse(rt.ensureRunning(model).isPresent(), "no server on the port -> empty, never a hang");
        assertNull(rt.reaper, "the never-healthy path reaps and deregisters too");
        rt.shutdown();
    }
}
