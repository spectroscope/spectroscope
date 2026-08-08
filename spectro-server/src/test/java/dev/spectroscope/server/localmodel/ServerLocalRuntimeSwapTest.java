package dev.spectroscope.server.localmodel;

import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.local.LocalRuntime;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The model-switch state machine (card 107, the switch-during-run race). One
 * llama-server serves every session, so a switch is a handover — and a handover
 * has two honest obligations this test pins:
 *
 * <ul>
 *   <li><b>Prove the new model before killing the old.</b> A switch to a model
 *       that cannot start must leave the running model untouched and say WHICH
 *       model failed and which keeps serving — not tear the working runtime
 *       down first and blame the download.</li>
 *   <li><b>Never strand a session on a freed port.</b> A session built on the
 *       old model must not keep POSTing to the loopback port the shutdown
 *       released (anything on the machine can bind it next). Its next turn
 *       fails loudly, naming both models, without touching the port.</li>
 * </ul>
 */
class ServerLocalRuntimeSwapTest {

    /** A stub llama-server: healthy {@code /v1/models}, and a one-chunk SSE
     *  completion stamped with its marker so a reader can tell WHO answered. */
    private static final class StubModel implements LocalRuntime.Launcher {
        final String marker;
        final AtomicInteger starts = new AtomicInteger();
        final AtomicBoolean closed = new AtomicBoolean();
        final AtomicReference<Integer> port = new AtomicReference<>();

        StubModel(String marker) {
            this.marker = marker;
        }

        @Override
        public AutoCloseable start(Path model, int p, String apiKey) throws Exception {
            starts.incrementAndGet();
            HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", p), 0);
            port.set(p);
            s.createContext("/v1/models", ex -> {
                byte[] b = "{\"data\":[{\"id\":\"stub\"}]}".getBytes(StandardCharsets.UTF_8);
                ex.sendResponseHeaders(200, b.length);
                ex.getResponseBody().write(b);
                ex.close();
            });
            s.createContext("/v1/chat/completions", ex -> {
                ex.getResponseHeaders().add("Content-Type", "text/event-stream");
                ex.sendResponseHeaders(200, 0);
                try (OutputStream out = ex.getResponseBody()) {
                    out.write(("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\""
                            + marker + "\"}}]}\n\ndata: [DONE]\n\n")
                            .getBytes(StandardCharsets.UTF_8));
                } finally {
                    ex.close();
                }
            });
            s.start();
            return () -> {
                closed.set(true);
                s.stop(0);
            };
        }
    }

    private static ServerLocalRuntime runtimeOver(Map<String, LocalRuntime.Launcher> launchers,
                                                  Path modelFile) {
        return new ServerLocalRuntime(
                entry -> new LocalRuntime(launchers.get(entry.id()), entry.id()),
                entry -> modelFile);
    }

    private static LlmProvider.ProviderRequest ask() {
        return new LlmProvider.ProviderRequest(
                "sys", List.of(new LlmProvider.ProviderMessage(
                        LlmProvider.ProviderMessage.Role.USER,
                        List.of(new LlmProvider.TextContent("hi")))),
                List.of(), 64, LlmProvider.ProviderRequest.Reasoning.DEFAULT, null);
    }

    private static String textOf(LlmProvider provider) {
        StringBuilder text = new StringBuilder();
        for (LlmProvider.ProviderEvent e : provider.stream(ask())) {
            if (e instanceof LlmProvider.PTextDelta t) {
                text.append(t.text());
            }
        }
        return text.toString();
    }

    @Test
    void aRefusedSwitchKeepsTheOldModelServing(@TempDir Path dir) throws Exception {
        Path file = Files.writeString(dir.resolve("m.gguf"), "gguf");
        StubModel old = new StubModel("from-old");
        ServerLocalRuntime local = runtimeOver(Map.of(
                "qwen3-1-7b", old,
                "qwen3-4b", (model, port, key) -> {
                    throw new IllegalStateException("this model cannot start");
                }), file);

        LlmProvider first = local.providerFor("qwen3-1-7b").orElseThrow();
        assertEquals("from-old", textOf(first), "the first model must serve");

        IllegalStateException refused = assertThrows(IllegalStateException.class,
                () -> local.providerFor("qwen3-4b"),
                "a switch to a model that cannot start must be refused loudly");
        assertTrue(refused.getMessage().contains("qwen3-4b"),
                "the refusal must name the model that failed: " + refused.getMessage());
        assertTrue(refused.getMessage().contains("qwen3-1-7b"),
                "the refusal must say which model keeps serving: " + refused.getMessage());

        assertFalse(old.closed.get(),
                "the working runtime must survive a refused switch — killing it first "
                        + "leaves NO runtime at all");
        assertEquals("from-old", textOf(first),
                "the old provider must still answer after the refused switch");
    }

    @Test
    void aStaleSessionFailsLoudlyInsteadOfTouchingTheFreedPort(@TempDir Path dir) throws Exception {
        Path file = Files.writeString(dir.resolve("m.gguf"), "gguf");
        StubModel old = new StubModel("from-old");
        StubModel fresh = new StubModel("from-new");
        ServerLocalRuntime local = runtimeOver(Map.of(
                "qwen3-1-7b", old,
                "qwen3-4b", fresh), file);

        LlmProvider stale = local.providerFor("qwen3-1-7b").orElseThrow();
        assertEquals("from-old", textOf(stale));
        int freedPort = old.port.get();

        LlmProvider current = local.providerFor("qwen3-4b").orElseThrow();
        assertTrue(old.closed.get(), "the superseded runtime is shut down after the handover");
        assertEquals("from-new", textOf(current), "the new model serves after the switch");

        // A rogue local process binds the port the shutdown released — the exact
        // inheritance the stale session must never feed.
        AtomicInteger rogueHits = new AtomicInteger();
        HttpServer rogue = HttpServer.create(new InetSocketAddress("127.0.0.1", freedPort), 0);
        rogue.createContext("/", ex -> {
            rogueHits.incrementAndGet();
            ex.sendResponseHeaders(200, -1);
            ex.close();
        });
        rogue.start();
        try {
            IllegalStateException wedged = assertThrows(IllegalStateException.class,
                    () -> textOf(stale),
                    "a stale session's turn must fail with a readable message, not an I/O error");
            assertTrue(wedged.getMessage().contains("qwen3-1-7b"),
                    "the error must name the session's model: " + wedged.getMessage());
            assertTrue(wedged.getMessage().contains("qwen3-4b"),
                    "the error must name the model that runs now: " + wedged.getMessage());
            assertEquals(0, rogueHits.get(),
                    "the stale session must never contact the freed port again");
        } finally {
            rogue.stop(0);
        }

        assertEquals("qwen3-1-7b", stale.modelName(),
                "run_start keeps stamping the model this session actually selected");
    }

    @Test
    void theSameModelIsReusedWithoutARestart(@TempDir Path dir) throws Exception {
        Path file = Files.writeString(dir.resolve("m.gguf"), "gguf");
        StubModel only = new StubModel("from-only");
        ServerLocalRuntime local = runtimeOver(Map.of("qwen3-1-7b", only), file);

        local.providerFor("qwen3-1-7b").orElseThrow();
        LlmProvider again = local.providerFor("qwen3-1-7b").orElseThrow();
        assertEquals(1, only.starts.get(), "the same model must reuse the live runtime");
        assertFalse(only.closed.get());
        assertEquals("from-only", textOf(again));
    }
}
