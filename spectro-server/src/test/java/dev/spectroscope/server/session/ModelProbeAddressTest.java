package dev.spectroscope.server.session;

import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 193: the settings page grew an address PER local-model provider, and the
 * reachability probe (the live model list behind the picker and the settings
 * chooser) must dial exactly that address — not the legacy shared baseUrl, and
 * not a preset. Pinned against a real HTTP listener on an ephemeral port, so a
 * regression to the old one-url-for-everyone road cannot answer.
 */
class ModelProbeAddressTest {

    /** Tests write the user settings ({@code user.home} points into the build
     *  directory) — start and end clean so no other suite inherits them. */
    @AfterEach
    void removeUserSettings() throws IOException {
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
    }

    private static void writeUserSettings(String json) throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, json);
    }

    private static HttpServer serve(String path, String body) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext(path, exchange -> {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        });
        server.start();
        return server;
    }

    @Test
    void ollamaModelProbeDialsThePerProviderAddress() throws IOException {
        HttpServer fakeOllama = serve("/api/tags",
                "{\"models\":[{\"name\":\"qwen3:remote\"}]}");
        try {
            int port = fakeOllama.getAddress().getPort();
            // The legacy baseUrl points somewhere ELSE on purpose — only the
            // per-provider address knows the fake server. The old road fails here.
            writeUserSettings("""
                    { "baseUrl": "http://127.0.0.1:1",
                      "ollamaBaseUrl": "http://127.0.0.1:%d" }
                    """.formatted(port));
            List<String> models = new SessionsController().models("ollama");
            assertEquals(List.of("qwen3:remote"), models,
                    "the probe answers from the per-provider address");
        } finally {
            fakeOllama.stop(0);
        }
    }

    @Test
    void lmstudioModelProbeDialsThePerProviderAddress() throws IOException {
        HttpServer fakeLmStudio = serve("/v1/models",
                "{\"data\":[{\"id\":\"qwen/qwen3-coder\",\"created\":1}]}");
        try {
            int port = fakeLmStudio.getAddress().getPort();
            writeUserSettings("""
                    { "baseUrl": "http://127.0.0.1:1",
                      "lmstudioBaseUrl": "http://127.0.0.1:%d" }
                    """.formatted(port));
            List<String> models = new SessionsController().models("lmstudio");
            assertEquals(List.of("qwen/qwen3-coder"), models,
                    "the probe answers from the per-provider address");
        } finally {
            fakeLmStudio.stop(0);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void apiConfigNamesTheAddressEachLocalProviderWouldDial() throws IOException {
        // The probe's failure sentence must NAME the address it tried — the
        // client reads it from here, the same endpointFor the probe itself uses.
        writeUserSettings("""
                { "ollamaBaseUrl": "http://gpu-box:11434",
                  "lmstudioBaseUrl": "http://gpu-box:1234" }
                """);
        Map<String, Object> config = new SessionsController().config();
        Map<String, String> address = (Map<String, String>) config.get("providerAddress");
        assertNotNull(address, "/api/config carries the per-provider addresses");
        assertEquals("http://gpu-box:11434", address.get("ollama"));
        assertEquals("http://gpu-box:1234", address.get("lmstudio"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void apiConfigAddressesFallBackToThePresetsWhenNothingIsConfigured() throws IOException {
        // No per-provider field, no legacy baseUrl: each provider names its own
        // preset — never one shared string for both.
        writeUserSettings("{ }");
        Map<String, Object> config = new SessionsController().config();
        Map<String, String> address = (Map<String, String>) config.get("providerAddress");
        assertNotNull(address);
        assertTrue(address.get("ollama").endsWith(":11434"),
                "ollama names its own preset, got: " + address.get("ollama"));
        assertTrue(address.get("lmstudio").endsWith(":1234"),
                "lmstudio names its own preset, got: " + address.get("lmstudio"));
    }
}
