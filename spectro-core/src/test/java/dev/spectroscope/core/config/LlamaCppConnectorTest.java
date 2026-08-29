package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
