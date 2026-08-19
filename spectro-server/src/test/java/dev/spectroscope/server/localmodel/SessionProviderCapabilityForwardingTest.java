package dev.spectroscope.server.localmodel;

import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.local.LocalCatalog;
import dev.spectroscope.core.local.LocalRuntime;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.CompactionThreshold;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * What the provider a BUILT-IN-MODEL session really holds answers about itself.
 *
 * <p>Card 263's review found the fourth wrapper. {@code SessionProvider}
 * forwards {@code modelName()}, {@code providerName()} and {@code vision()} and
 * forwarded nothing else, so it inherited the interface default 0 for the
 * context window and every spectro-local session landed on the 100,000
 * fallback. That is the worst place for it to land: every model in the bundled
 * catalogue is loaded with 8,192 tokens or fewer, so those sessions never
 * compacted at all — the exact defect AC 4 exists for, in the one configuration
 * the app ships with.</p>
 *
 * <p>The window is taken from the CATALOGUE and not from the delegate on
 * purpose. {@code llama-server} is started with {@code -c <contextTokens>} by
 * this very class, so the catalogue entry is not a guess about the window, it
 * is the instruction that created it — and llama.cpp serves no capability
 * listing to ask instead, so a forward to the delegate would cost a request and
 * answer 0.</p>
 */
class SessionProviderCapabilityForwardingTest {

    /** A stub llama-server answering only the health probe. */
    private static LocalRuntime.Launcher stub() {
        return (model, port, apiKey) -> {
            HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
            server.createContext("/v1/models", exchange -> {
                byte[] body = "{\"data\":[{\"id\":\"stub\"}]}".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
                exchange.close();
            });
            server.start();
            return () -> server.stop(0);
        };
    }

    private static ServerLocalRuntime runtimeOver(String modelId, Path modelFile) {
        return new ServerLocalRuntime(
                entry -> new LocalRuntime(Map.of(modelId, stub()).get(entry.id()), entry.id()),
                entry -> modelFile);
    }

    @Test
    void aBuiltInModelSessionKnowsTheWindowItsOwnLlamaServerWasStartedWith(@TempDir Path dir)
            throws Exception {
        Path file = Files.writeString(dir.resolve("m.gguf"), "gguf");
        LlmProvider session = runtimeOver("qwen3-4b", file).providerFor("qwen3-4b").orElseThrow();

        int catalogueWindow = LocalCatalog.bundled().resolve("qwen3-4b").contextTokens();

        assertEquals(catalogueWindow, session.contextWindow(),
                "the -c flag this class passes to llama-server IS the window");
        assertEquals(8_192, catalogueWindow,
                "and it is small — which is why inheriting the 100,000 fallback here "
                        + "meant the bundled model never compacted");
    }

    @Test
    void thatWindowIsWhatTheHarnessThenCompactsAt(@TempDir Path dir) throws Exception {
        // The consequence, spelled out rather than left to arithmetic elsewhere:
        // a spectro-local session compacts at 6,144 and not at 100,000.
        Path file = Files.writeString(dir.resolve("m.gguf"), "gguf");
        LlmProvider session = runtimeOver("qwen3-4b", file).providerFor("qwen3-4b").orElseThrow();

        CompactionThreshold.Derived derived =
                CompactionThreshold.derive(null, session.contextWindow());

        assertEquals(6_144, derived.tokens());
        assertEquals(CompactionThreshold.Source.WINDOW, derived.source());
        assertEquals(2_048, CompactionThreshold.summaryBudget(derived),
                "and the summarizer gets the reserve, not a 32,000-token request "
                        + "against an 8,192-token server");
    }

    @Test
    void theSmallestCatalogueEntryIsCarriedThroughToo(@TempDir Path dir) throws Exception {
        // vibethinker-3b is loaded with 4,096 — half of what the rest get. A
        // forwarding that happened to hardcode one number would pass the test
        // above and fail here.
        Path file = Files.writeString(dir.resolve("m.gguf"), "gguf");
        LlmProvider session =
                runtimeOver("vibethinker-3b", file).providerFor("vibethinker-3b").orElseThrow();

        assertEquals(4_096, session.contextWindow());
    }
}
