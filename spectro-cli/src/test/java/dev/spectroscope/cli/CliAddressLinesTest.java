package dev.spectroscope.cli;

import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 193 in the terminal: the two REPL faces that print an address.
 *
 * <p>The banner's "unreachable at …" and {@code /model} both read
 * {@code config.baseUrl()} while the provider beside them had been built from
 * {@code endpointFor} — so the CLI named localhost about a probe that had gone
 * to another machine, which is the exact defect this card exists to remove one
 * surface at a time.</p>
 *
 * <p>Both are pinned through the REAL provider the run holds, decorators and
 * all: {@code providerFromConfig} wraps the concrete provider in a logging
 * proxy and (with retries configured) a retry decorator, so an address that
 * does not survive those wrappers is not an address any face can print.</p>
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class CliAddressLinesTest {

    private HttpServer server;

    @AfterEach
    void cleanUp() throws IOException {
        if (server != null) {
            server.stop(0);
        }
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
    }

    private static SpectroConfig loadWith(String json) throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, json);
        return SpectroConfig.load(SpectroConfig.Overrides.none());
    }

    /** A listener answering ollama's {@code /api/version} — returns its root. */
    private String fakeOllama(String version) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/version", exchange -> {
            byte[] body = ("{\"version\":\"" + version + "\"}").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    // ---- the banner ---------------------------------------------------------

    @Test
    void theBannerProbesThePerProviderOllamaAddressAndNotTheLegacyOne() throws IOException {
        String remote = fakeOllama("0.14.2");
        SpectroConfig config = loadWith("""
                { "provider": "ollama", "model": "qwen3",
                  "baseUrl": "http://127.0.0.1:1",
                  "ollamaBaseUrl": "%s" }
                """.formatted(remote));

        String suffix = SpectroCli.ollamaBannerSuffix(
                config, config.providerFromConfig(), Ansi.forced(false));

        assertTrue(suffix.contains("ollama 0.14.2"),
                "the ONLY server that answers is the per-provider one; the banner probed"
                        + " something else and reported it down: " + suffix);
    }

    @Test
    void anUnreachableBannerNamesTheAddressItReallyTried() throws IOException {
        // Two closed ports, far apart in text so no substring accident can pass.
        SpectroConfig config = loadWith("""
                { "provider": "ollama", "model": "qwen3",
                  "baseUrl": "http://127.0.0.1:5111",
                  "ollamaBaseUrl": "http://127.0.0.1:5222" }
                """);

        String suffix = SpectroCli.ollamaBannerSuffix(
                config, config.providerFromConfig(), Ansi.forced(false));

        assertTrue(suffix.contains("unreachable at http://127.0.0.1:5222"),
                "the sentence must name the address the probe used: " + suffix);
        assertFalse(suffix.contains("5111"),
                "the legacy baseUrl was not dialled and must not be blamed: " + suffix);
    }

    @Test
    void thereIsNoOllamaSegmentForAProviderThatIsNotOllama() throws IOException {
        SpectroConfig config = loadWith("""
                { "provider": "lmstudio", "model": "local-model",
                  "lmstudioBaseUrl": "http://127.0.0.1:5222" }
                """);
        assertEquals("", SpectroCli.ollamaBannerSuffix(
                config, config.providerFromConfig(), Ansi.forced(false)));
    }

    // ---- /model -------------------------------------------------------------

    @Test
    void theModelCommandPrintsTheAddressTheActiveProviderDials() throws IOException {
        SpectroConfig lmstudio = loadWith("""
                { "provider": "lmstudio", "model": "qwen3-coder",
                  "baseUrl": "http://127.0.0.1:5111",
                  "lmstudioBaseUrl": "http://gpu-box:1234" }
                """);
        String line = SpectroCli.modelLine(lmstudio, lmstudio.providerFromConfig());
        assertTrue(line.contains("http://gpu-box:1234"),
                "/model advertises the ACTIVE base URL and LM Studio has its own: " + line);
        assertFalse(line.contains("5111"),
                "the legacy baseUrl is not what this run dials: " + line);
        assertTrue(line.startsWith("lmstudio · qwen3-coder"), line);

        SpectroConfig ollama = loadWith("""
                { "provider": "ollama", "model": "qwen3",
                  "baseUrl": "http://127.0.0.1:5111",
                  "ollamaBaseUrl": "http://gpu-box:11434" }
                """);
        String ollamaLine = SpectroCli.modelLine(ollama, ollama.providerFromConfig());
        assertTrue(ollamaLine.contains("http://gpu-box:11434"), ollamaLine);
        assertFalse(ollamaLine.contains("5111"), ollamaLine);
    }

    @Test
    void aProviderWithNoAddressToNamePrintsNone() throws IOException {
        // anthropic's endpoint is fixed in the SDK, and spectro-local is a
        // subprocess: both used to have ollama's :11434 printed at them, which
        // is a string neither one has ever dialled.
        SpectroConfig config = loadWith("""
                { "provider": "spectro-local", "model": "qwen3-4b",
                  "baseUrl": "http://127.0.0.1:5111" }
                """);
        LlmProvider addressless = request -> java.util.List.<LlmProvider.ProviderEvent>of();
        String line = SpectroCli.modelLine(config, addressless);
        assertEquals("spectro-local · qwen3-4b", line,
                "no address is better than the wrong one: " + line);
    }
}
