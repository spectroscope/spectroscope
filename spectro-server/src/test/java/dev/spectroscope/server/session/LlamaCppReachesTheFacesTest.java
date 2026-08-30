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
 * Card 312: what the three hand-written provider lists in this controller
 * actually answer for llamacpp — the model-list route, {@code providerStatus}
 * and {@code providerAddress}. None of the three is derived from
 * {@link SpectroConfig#knownProviders()}, so each one can lose a provider on
 * its own: a name missing from the switch answers an empty model list (the
 * picker renders "not reachable" whatever the backend does), one missing from
 * {@code providerStatus} gets no onboarding line, and one missing from
 * {@code providerAddress} makes the unreachable sentence fall back to the
 * addressless wording card 193 removed.
 *
 * <p><b>Why every test here dials.</b> The first version of this file read
 * {@code SessionsController.java} off disk and grepped it for string literals.
 * The card's own review then deleted llamacpp from all three real places and
 * the file stayed GREEN, because the literals it matched also stand in the
 * comments beside those places. A source matcher wearing a behaviour pin's
 * name is worse than no pin at all: it reports green for a connector that no
 * longer reaches the faces. Everything below calls the route and reads the
 * answer, against a real listener on an ephemeral port where an address is
 * involved — the {@code ModelProbeAddressTest} pattern.</p>
 */
class LlamaCppReachesTheFacesTest {

    /** These tests write the user settings ({@code user.home} points into the
     *  build directory) — cleaned up so no other suite inherits them. */
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

    // ---- /api/models ----------------------------------------------------

    @Test
    void theModelListRouteAnswersWhatTheLlamaServerHasLoaded() throws IOException {
        // llama-server speaks the same keyless /v1/models wire as its
        // OpenAI-compatible neighbours and answers with the one model it was
        // started with. A provider that is not on that arm of the switch falls
        // through to the empty list instead of dialling at all.
        HttpServer fakeLlamaServer = serve("/v1/models",
                "{\"data\":[{\"id\":\"qwen3-4b-instruct-q4_k_m\",\"created\":1}]}");
        try {
            int port = fakeLlamaServer.getAddress().getPort();
            // The legacy shared baseUrl points somewhere ELSE on purpose: only
            // the per-provider address knows the fake server.
            writeUserSettings("""
                    { "baseUrl": "http://127.0.0.1:1",
                      "llamacppBaseUrl": "http://127.0.0.1:%d" }
                    """.formatted(port));
            assertEquals(List.of("qwen3-4b-instruct-q4_k_m"),
                    new SessionsController().models("llamacpp"),
                    "the picker's model list must come from the llama-server that was dialled");
        } finally {
            fakeLlamaServer.stop(0);
        }
    }

    // ---- /api/config: providerStatus ------------------------------------

    @Test
    void theOnboardingStatusListCallsLlamacppLocalRatherThanKeyed() throws IOException {
        // Bitten apart from the address below: a provider can be listed here
        // and still be classified as a keyed cloud service, which is the
        // "add a key to .env" line for a server that has no key to check.
        writeUserSettings("{ }");
        @SuppressWarnings("unchecked")
        Map<String, String> status =
                (Map<String, String>) new SessionsController().config().get("providerStatus");
        assertNotNull(status, "/api/config carries the onboarding status per provider");
        assertEquals("local", status.get("llamacpp"),
                "no status entry means no onboarding line at all; a keyed one is a lie: "
                        + status);
    }

    // ---- /api/config: providerAddress -----------------------------------

    @Test
    void theAddressMapNamesTheAddressLlamacppWouldBeDialledAt() throws IOException {
        // The unreachable sentence must be able to name the endpoint that was
        // actually tried — the same endpointFor the probe above uses.
        writeUserSettings("{ \"llamacppBaseUrl\": \"http://gpu-box:8080\" }");
        @SuppressWarnings("unchecked")
        Map<String, String> address =
                (Map<String, String>) new SessionsController().config().get("providerAddress");
        assertNotNull(address, "/api/config carries the per-provider addresses");
        assertEquals("http://gpu-box:8080", address.get("llamacpp"),
                "an absent entry drops the client back to the addressless wording: " + address);
    }

    @Test
    void theAddressMapFallsBackToLlamaServersOwnPreset() throws IOException {
        // Nothing configured: llamacpp names ITS preset (llama-server's
        // documented default port), never a neighbour's.
        writeUserSettings("{ }");
        @SuppressWarnings("unchecked")
        Map<String, String> address =
                (Map<String, String>) new SessionsController().config().get("providerAddress");
        assertNotNull(address);
        String llamacpp = address.get("llamacpp");
        assertNotNull(llamacpp, "llamacpp has no address to show: " + address);
        assertTrue(llamacpp.endsWith(":8080"),
                "llamacpp names its own preset, got: " + llamacpp);
    }
}
