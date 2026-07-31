package dev.spectroscope.server;

import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.local.LocalRuntime;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;

/**
 * The cost side of card 107's switch fix. Binding a session to a MODEL instead
 * of a port means the delegate is resolved on every stream call — and every
 * resolve used to CONSTRUCT one, i.e. a fresh {@code OpenAiCompatProvider}, a
 * fresh Spring {@code RestClient} and a fresh {@code java.net.http.HttpClient}
 * with its own selector thread, once per agent TURN. An agentic run is many
 * turns (every tool round trip is one), so a single local run leaked a thread
 * per turn, reclaimed only whenever GC got around to it.
 *
 * <p>The check that makes the fix work is the model comparison, not the
 * construction: while the same runtime serves the same model, the delegate is
 * the same object. A handover must still invalidate it — a cached delegate
 * pointing at the superseded port is the very wedge this card closed.</p>
 */
class ServerLocalRuntimeDelegateReuseTest {

    /** A stub llama-server that answers the health probe; no completion needed —
     *  these assertions are about delegate lifetime, not about the wire. */
    private static LocalRuntime.Launcher stub() {
        return (model, port, apiKey) -> {
            HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
            s.createContext("/v1/models", ex -> {
                byte[] b = "{\"data\":[{\"id\":\"stub\"}]}".getBytes(StandardCharsets.UTF_8);
                ex.sendResponseHeaders(200, b.length);
                ex.getResponseBody().write(b);
                ex.close();
            });
            s.start();
            return () -> s.stop(0);
        };
    }

    private static ServerLocalRuntime runtimeOver(Map<String, LocalRuntime.Launcher> launchers,
                                                  Path modelFile) {
        return new ServerLocalRuntime(
                entry -> new LocalRuntime(launchers.get(entry.id()), entry.id()),
                entry -> modelFile);
    }

    @Test
    void aLiveRuntimeHandsOutTheSameDelegateEveryTurn(@TempDir Path dir) throws Exception {
        Path file = Files.writeString(dir.resolve("m.gguf"), "gguf");
        ServerLocalRuntime local = runtimeOver(Map.of("qwen3-1-7b", stub()), file);
        local.providerFor("qwen3-1-7b").orElseThrow();

        LlmProvider first = local.liveDelegate("qwen3-1-7b");
        LlmProvider second = local.liveDelegate("qwen3-1-7b");
        assertSame(first, second,
                "the same runtime serving the same model must reuse one delegate — "
                        + "rebuilding it per turn mints an HttpClient (and its selector "
                        + "thread) for every tool round trip");
    }

    @Test
    void aHandoverInvalidatesTheCachedDelegate(@TempDir Path dir) throws Exception {
        Path file = Files.writeString(dir.resolve("m.gguf"), "gguf");
        ServerLocalRuntime local = runtimeOver(
                Map.of("qwen3-1-7b", stub(), "qwen3-4b", stub()), file);

        local.providerFor("qwen3-1-7b").orElseThrow();
        LlmProvider onOld = local.liveDelegate("qwen3-1-7b");

        local.providerFor("qwen3-4b").orElseThrow();
        LlmProvider onNew = local.liveDelegate("qwen3-4b");

        assertNotSame(onOld, onNew,
                "the delegate must not survive a handover — the old one points at the "
                        + "port the shutdown released");
    }
}
