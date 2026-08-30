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
 * Card 312: what the three provider lists in this controller actually answer
 * for llamacpp — the model-list route, {@code providerStatus} and
 * {@code providerAddress}. A name missing from the model switch answers an
 * empty list (the picker renders "not reachable" whatever the backend does),
 * one missing from {@code providerStatus} gets no onboarding line, and one
 * missing from {@code providerAddress} makes the unreachable sentence fall
 * back to the addressless wording card 193 removed.
 *
 * <p><b>Round 3.</b> Two of the three were hand-written lists when this file
 * was first written, and this javadoc said so and left it there. They are now
 * walked off {@link SpectroConfig#knownProviders()} and
 * {@link SpectroConfig#keylessLocalServers()}, and the two tests at the bottom
 * hold them to it — so the last two tests here are about llamacpp and the two
 * below them are about the class llamacpp was the third instance of. The
 * model-list route stays a switch: its arms are four different wire
 * protocols, not a list. <b>Round 5</b> gave that one a behavioural guard too —
 * every provider {@link SpectroConfig#openAiCompatProviders()} names must reach
 * a server that answers, rather than fall through to the empty list — because
 * until then the arm was a hand-typed copy of a package-private switch that
 * nothing could compare it to.
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

    /**
     * Every backend that speaks the OpenAI wire gets served by this route.
     *
     * <p>Round 5. The arm was a hand-typed copy of
     * {@code SpectroConfig.isOpenAiCompat}'s switch, and the javadoc over the
     * route said so — pointing at a symbol that is package-private in
     * {@code dev.spectroscope.core.config}, so the controller could not name it
     * in code and no test could hold the two together. Measured: a ninth
     * provider added to {@code KNOWN_PROVIDERS}, {@code endpointFor} and
     * {@code isOpenAiCompat} and nothing else left the ENTIRE spectro-server
     * suite green (exit 0, zero FAILED lines) while this route answered an
     * empty list for it — the picker showing no models for a backend the config
     * accepts and that speaks the wire.
     *
     * <p>One listener for the whole set, because one line of settings reaches
     * all of it: the legacy shared {@code baseUrl} IS the address for the
     * openai-compatible providers without a per-provider field, and the two
     * that have one fall back to it while theirs is unset. So a provider that
     * never dials is the only way to fail here, which is exactly the defect.</p>
     */
    @Test
    void everyProviderThatSpeaksTheOpenAiWireIsServedByTheModelListRoute() throws IOException {
        HttpServer fakeCompatServer = serve("/v1/models",
                "{\"data\":[{\"id\":\"a-model-the-picker-can-show\",\"created\":1}]}");
        try {
            int port = fakeCompatServer.getAddress().getPort();
            writeUserSettings("{ \"baseUrl\": \"http://127.0.0.1:%d\" }".formatted(port));
            assertTrue(SpectroConfig.openAiCompatProviders().size() >= 2,
                    "no openai-compatible providers left to serve: "
                            + SpectroConfig.openAiCompatProviders());
            for (String provider : new java.util.TreeSet<>(SpectroConfig.openAiCompatProviders())) {
                assertEquals(List.of("a-model-the-picker-can-show"),
                        new SessionsController().models(provider),
                        "\"" + provider + "\" speaks the OpenAI wire and the config gives it"
                                + " an endpoint, but /api/models never dialled it — it is"
                                + " missing from the switch's openai-compatible arm, so the"
                                + " picker shows an empty model list for a backend"
                                + " spectroscope can actually talk to. The arm is held to"
                                + " SpectroConfig.openAiCompatProviders(); add the name"
                                + " there and here in one edit.");
            }
        } finally {
            fakeCompatServer.stop(0);
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

    // ---- the class llamacpp was the third instance of --------------------

    /**
     * Every provider the config accepts has an onboarding line. The loop behind
     * {@code providerStatus} used to carry its own list of seven names; a
     * provider added to {@link SpectroConfig#knownProviders()} was then offered
     * by the picker with no status at all, and the picker's needs-key branch
     * reads that map. Derived on both sides now, so the pin is that the
     * derivation EXISTS: bitten by putting the literal list back with llamacpp
     * missing, which reds this and the address test below.
     */
    @Test
    void everyProviderTheConfigAcceptsGetsAnOnboardingStatus() throws IOException {
        writeUserSettings("{ }");
        @SuppressWarnings("unchecked")
        Map<String, String> status =
                (Map<String, String>) new SessionsController().config().get("providerStatus");
        assertNotNull(status, "/api/config carries the onboarding status per provider");
        for (String provider : SpectroConfig.knownProviders()) {
            String line = status.get(provider);
            assertNotNull(line,
                    "\"" + provider + "\" is a selectable backend with no onboarding line,"
                            + " so the picker offers it and says nothing about it: " + status);
            if ("spectro-local".equals(provider)) {
                // The bundled runtime answers a download question, never a key one.
                assertTrue(List.of("ready", "needs-download").contains(line),
                        "the built-in runtime cannot be \"" + line + "\": it has no key to check");
                continue;
            }
            assertEquals(SpectroConfig.onboardingStatus(provider,
                            SpectroConfig.keyEnvFor(provider) != null
                                    && System.getenv(SpectroConfig.keyEnvFor(provider)) != null),
                    line,
                    "the controller's status for \"" + provider + "\" is not the one"
                            + " SpectroConfig computes — a second rule written in the"
                            + " controller is the defect card 203 removed from the doctor");
        }
    }

    /**
     * Every keyless local server names the address it would be dialled at.
     * {@code providerAddress} used to be three literal puts, so a fourth free
     * local backend would have got its address on the day somebody noticed the
     * unreachable sentence had gone vague, not on the day it was declared.
     */
    @Test
    void everyKeylessLocalServerNamesTheAddressItWouldBeDialledAt() throws IOException {
        writeUserSettings("{ }");
        @SuppressWarnings("unchecked")
        Map<String, String> address =
                (Map<String, String>) new SessionsController().config().get("providerAddress");
        assertNotNull(address, "/api/config carries the per-provider addresses");
        assertTrue(SpectroConfig.keylessLocalServers().size() >= 2,
                "no keyless local servers left to address: " + SpectroConfig.keylessLocalServers());
        for (String provider : SpectroConfig.keylessLocalServers()) {
            assertEquals(SpectroConfig.presetEndpointFor(provider), address.get(provider),
                    "\"" + provider + "\" has no address here, or not its own preset — the"
                            + " client then falls back to the addressless \"start it\""
                            + " sentence card 193 removed: " + address);
        }
        assertEquals(SpectroConfig.keylessLocalServers(), address.keySet(),
                "the address map is not the keyless-local-server set — a cloud provider"
                            + " listed here would get a local down-note it cannot act on");
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
