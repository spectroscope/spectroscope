package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 312: llama.cpp as a first-class connector, threaded exactly the way
 * lmstudio is (card 193) — its own name, its own address, its own preset, and
 * no API key.
 *
 * <p>Every branch is bitten SEPARATELY on purpose. The house rule exists
 * because a test named for one branch has passed on its neighbour's code
 * before; a single "llamacpp works" assertion would go green with the address
 * chain still broken.</p>
 */
class LlamaCppConnectorTest {

    // ---- the name -------------------------------------------------------

    @Test
    void llamacppIsAKnownProvider() {
        assertTrue(SpectroConfig.isKnownProvider("llamacpp"),
                "a provider the picker offers must be a provider config accepts");
    }

    @Test
    void theHumanReadableListNamesLlamacpp() {
        assertTrue(SpectroConfig.KNOWN_PROVIDERS_DISPLAY.contains("llamacpp"),
                "the display list is what an error message shows; a name missing "
                        + "there is a name the operator is told does not exist");
    }

    // ---- the address ----------------------------------------------------

    @Test
    void thePresetIsLlamaServersDocumentedDefaultPort() {
        // Measured against the bundled binary (b10107): `--port PORT  port to
        // listen (default: 8080)`.
        assertEquals("http://localhost:8080", SpectroConfig.openAiCompatPreset("llamacpp"));
    }

    @Test
    void withNothingConfiguredTheAddressIsThePreset(@TempDir Path projectDir) {
        assertEquals("http://localhost:8080",
                load(projectDir, "{ \"provider\": \"llamacpp\" }").endpointFor("llamacpp"));
    }

    @Test
    void itsOwnAddressIsTakenVerbatim(@TempDir Path projectDir) throws IOException {
        // No sentinel, exactly as card 193 decided for ollama/lmstudio: a
        // deliberately typed value is never silently rerouted, even when it
        // equals some other provider's preset.
        SpectroConfig config = load(projectDir, """
                { "provider": "llamacpp", "llamacppBaseUrl": "http://localhost:9191" }
                """);
        assertEquals("http://localhost:9191", config.endpointFor("llamacpp"));
    }

    @Test
    void itsOwnAddressOutranksTheLegacySharedBaseUrl(@TempDir Path projectDir) throws IOException {
        SpectroConfig config = load(projectDir, """
                { "provider": "llamacpp",
                  "baseUrl": "http://localhost:7000",
                  "llamacppBaseUrl": "http://localhost:9191" }
                """);
        assertEquals("http://localhost:9191", config.endpointFor("llamacpp"));
    }

    @Test
    void theLegacySharedBaseUrlStillReachesLlamacppWhenItIsTheOnlyThingSet(@TempDir Path projectDir)
            throws IOException {
        SpectroConfig config = load(projectDir, """
                { "provider": "llamacpp", "baseUrl": "http://localhost:7000" }
                """);
        assertEquals("http://localhost:7000", config.endpointFor("llamacpp"));
    }

    @Test
    void theAddressSurvivesAProviderSwitch(@TempDir Path projectDir) throws IOException {
        // withProvider() exists so record growth cannot silently drop a field.
        // A new component that nobody threads through it resolves fine at boot
        // and then vanishes the first time somebody switches backend.
        SpectroConfig config = load(projectDir, """
                { "provider": "llamacpp", "llamacppBaseUrl": "http://localhost:9191" }
                """);
        assertEquals("http://localhost:9191",
                config.withProvider("llamacpp", "whatever").endpointFor("llamacpp"));
    }

    // ---- the key --------------------------------------------------------

    @Test
    void llamacppAuthenticatesWithNothing() {
        assertNull(SpectroConfig.keyEnvFor("llamacpp"),
                "llama-server has no key to check, exactly like lmstudio");
    }

    @Test
    void aLiveSwitchToLlamacppNeedsNoKey() {
        assertTrue(SpectroConfig.isKnownProvider("llamacpp"));
        assertNull(SpectroConfig.keyEnvFor("llamacpp"));
    }

    // ---- the wire -------------------------------------------------------

    @Test
    void llamacppSpeaksTheOpenAiCompatibleWire() {
        assertTrue(SpectroConfig.isOpenAiCompat("llamacpp"),
                "one llama-server serves one model over /v1/chat/completions");
    }

    @Test
    void theDefaultModelIsNeverAClaudeId() {
        // The "opus for lmstudio" bug: a live switch carried the previous
        // model id to an endpoint that has never heard of it.
        String model = SpectroConfig.defaultModelFor("llamacpp");
        assertEquals("local-model", model,
                "the id is decorative — llama-server serves the one model it was "
                        + "started with and ignores the field (measured: a request "
                        + "naming a model that does not exist still completes)");
    }

    // ---- the wire the CONFIGURED provider actually posts ----------------

    @Test
    void aConfiguredLlamacppSwitchesThinkingOffOnTheWire(@TempDir Path projectDir)
            throws IOException {
        // The card's central claim, end to end and not in pieces: choosing
        // llamacpp in the picker must reach llama.cpp's MEASURED off switch.
        // Under the lmstudio label the honest answer to "off" is NOTHING (per-
        // request reasoning control does not exist there, upstream #988/#1250),
        // so a connector that borrows lmstudio's wiring turns the toggle into a
        // silent no-op: the switch reads off and the model keeps thinking. This
        // pins the whole chain — provider name to dialect to posted body —
        // against a listener that records what left the machine.
        AtomicReference<String> posted = new AtomicReference<>();
        HttpServer server = scriptedCompletions(posted);
        try {
            SpectroConfig config = load(projectDir, """
                    { "provider": "llamacpp", "model": "qwen3-4b-instruct",
                      "llamacppBaseUrl": "http://127.0.0.1:%d" }
                    """.formatted(server.getAddress().getPort()));
            for (LlmProvider.ProviderEvent ignored : config.providerFromConfig().stream(
                    new LlmProvider.ProviderRequest("sys", oneUser("hi"), List.of(), 512,
                            LlmProvider.ProviderRequest.Reasoning.OFF, null, new CancelSignal()))) {
                // drain — the request body is the subject
            }
            JsonNode sent = new ObjectMapper().readTree(posted.get());
            JsonNode kwargs = sent.get("chat_template_kwargs");
            assertNotNull(kwargs, "off never reached the template gate: " + sent);
            assertFalse(kwargs.get("enable_thinking").asBoolean(),
                    "the measured off switch must say false: " + sent);
        } finally {
            server.stop(0);
        }
    }

    private static List<LlmProvider.ProviderMessage> oneUser(String text) {
        return List.of(new LlmProvider.ProviderMessage(LlmProvider.ProviderMessage.Role.USER,
                List.of(new LlmProvider.TextContent(text))));
    }

    /** A loopback chat/completions that records the body and answers one SSE
     *  chunk — the {@code ReasoningWireTest} idiom.
     *  @param body where the received request body is stored
     *  @return the started server; the caller stops it */
    private static HttpServer scriptedCompletions(AtomicReference<String> body) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            body.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] sse = ("""
                    data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}

                    data: [DONE]

                    """).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, sse.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(sse);
            }
        });
        server.start();
        return server;
    }

    private static SpectroConfig load(Path projectDir, String json) {
        try {
            Path file = projectDir.resolve(SpectroConfig.PROJECT_SETTINGS);
            Files.createDirectories(file.getParent());
            Files.writeString(file, json);
        } catch (IOException failed) {
            throw new IllegalStateException(failed);
        }
        return SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, java.util.Map.of());
    }
}
