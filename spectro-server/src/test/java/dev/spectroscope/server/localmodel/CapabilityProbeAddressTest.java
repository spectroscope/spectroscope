package dev.spectroscope.server.localmodel;

import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.ReasoningCapability;
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

/**
 * Card 193, one surface further than {@code ModelProbeAddressTest}: the
 * reasoning-capability probe ({@code POST /api/show}) must dial the SAME
 * address the model list and the run itself dial.
 *
 * <p>It did not. {@code configuredOllamaBase} kept reading the legacy shared
 * {@code baseUrl} after the model list had moved to {@code endpointFor}, so a
 * remote ollama with the per-provider address set answered the picker's model
 * list and then had its capabilities GUESSED from the family table: the probe
 * went to localhost, failed, and {@code catch (Exception apiDark)} returned the
 * fallback with no signal anywhere. A silent wrong answer is the worst kind,
 * which is why this is pinned against a real listener like its sibling.</p>
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS)
class CapabilityProbeAddressTest {

    private HttpServer server;

    /** Tests write the user settings ({@code user.home} points into the build
     *  directory) — leave none behind for the next suite. */
    @AfterEach
    void cleanUp() throws IOException {
        if (server != null) {
            server.stop(0);
        }
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
    }

    private static void writeUserSettings(String json) throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, json);
    }

    /** A listener answering {@code /api/show} — returns its own root. */
    private String fakeOllama(String showBody) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/show", exchange -> {
            byte[] body = showBody.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @Test
    void theReasoningProbeDialsThePerProviderOllamaAddress() throws IOException {
        // qwen3:8b's family row says "effort" with four levels. This ollama
        // answers that the loaded model cannot think at all — an answer only
        // reachable by dialling the per-provider address, because the legacy
        // baseUrl points at a closed port on purpose.
        String base = fakeOllama("{\"capabilities\":[\"completion\",\"tools\"]}");
        writeUserSettings("""
                { "baseUrl": "http://127.0.0.1:1",
                  "ollamaBaseUrl": "%s" }
                """.formatted(base));

        ReasoningCapability cap = new ModelCapabilityController().capabilities("ollama", "qwen3:8b");

        assertEquals("api", cap.source(),
                "the probe fell back to the family table — it dialled an address"
                        + " nobody configured for ollama");
        assertEquals("none", cap.control(),
                "/api/show without \"thinking\" outranks the family table, and the remote"
                        + " ollama IS the one that answered");
    }

    @Test
    void anOldConfigWithOnlyTheLegacyBaseUrlIsStillDialled() throws IOException {
        // The legacy road stays open: no per-provider field, baseUrl alone.
        String base = fakeOllama("{\"capabilities\":[\"completion\",\"tools\"]}");
        writeUserSettings("{ \"baseUrl\": \"%s\" }".formatted(base));

        ReasoningCapability cap = new ModelCapabilityController().capabilities("ollama", "qwen3:8b");

        assertEquals("api", cap.source(), "an existing config must keep working unchanged");
        assertEquals("none", cap.control());
    }
}
