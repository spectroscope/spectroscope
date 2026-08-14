package dev.spectroscope.core.image;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The image provider factory: name dispatch, key checks against an injected
 * environment map (never the real one — the suite stays key-free), and the
 * model default/override precedence.
 */
class ImageProvidersTest {

    @Test
    void anUnknownNameListsTheKnownProviders() {
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                () -> ImageProviders.create("dalle", null, Map.of()));
        assertTrue(failure.getMessage().contains("gemini, openai"),
                "the error must list the known providers, got: " + failure.getMessage());
    }

    @Test
    void geminiWithoutAKeyNamesTheExactVariable() {
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> ImageProviders.create("gemini", null, Map.of()));
        assertTrue(failure.getMessage().contains("GEMINI_API_KEY"),
                "the error must name GEMINI_API_KEY, got: " + failure.getMessage());
        assertTrue(failure.getMessage().contains(".env"),
                "the error should point at ./.env as the usual place");
    }

    @Test
    void openaiWithoutAKeyNamesTheExactVariable() {
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> ImageProviders.create("openai", null, Map.of()));
        assertTrue(failure.getMessage().contains("OPENAI_API_KEY"));
    }

    @Test
    void aNullModelFallsBackToTheProviderDefault() {
        ImageProvider provider = ImageProviders.create("gemini", null,
                Map.of("GEMINI_API_KEY", "test-key"));

        assertInstanceOf(GeminiImageProvider.class, provider);
        assertEquals("gemini", provider.providerName());
        assertEquals("gemini-2.5-flash-image", provider.model());
    }

    @Test
    void anExplicitModelWinsOverTheDefault() {
        ImageProvider provider = ImageProviders.create("openai", "gpt-image-1-mini",
                Map.of("OPENAI_API_KEY", "test-key"));

        assertInstanceOf(OpenAiImageProvider.class, provider);
        assertEquals("gpt-image-1-mini", provider.model());
    }

    @Test
    void defaultModelAnswersPerProvider() {
        assertEquals("gemini-2.5-flash-image", ImageProviders.defaultModel("gemini"));
        assertEquals("gpt-image-1", ImageProviders.defaultModel("openai"));
        assertThrows(IllegalArgumentException.class, () -> ImageProviders.defaultModel("dalle"));
    }

    // ---- card 222, review finding F5: the app's pick of a backend with a key ----

    /**
     * The twin of {@code spectro-web/src/components/imageBackend.test.ts}. Same
     * rows, same order, same expectations — the composer's dropdown pre-selects
     * with this rule and the belt resolves with it, and the two disagreeing is
     * the defect (the composer showing openai while the settings page shows
     * gemini and generate_image uses a third answer).
     *
     * @param named    the backend the settings name
     * @param gemini   whether GEMINI_API_KEY is set anywhere
     * @param openai   whether OPENAI_API_KEY is set anywhere
     * @param expected the backend a generation should actually run on
     */
    @ParameterizedTest(name = "{0} + gemini={1} openai={2} -> {3}")
    @CsvSource({
            "gemini, true,  true,  gemini",
            "gemini, true,  false, gemini",
            "gemini, false, true,  openai",
            "gemini, false, false, gemini",
            "openai, true,  true,  openai",
            "openai, false, true,  openai",
            "openai, true,  false, gemini",
            "openai, false, false, openai",
    })
    void theBackendWithAKeyIsPickedTheSameWayTheComposerPicksIt(
            String named, boolean gemini, boolean openai, String expected) {
        Map<String, String> env = new java.util.HashMap<>();
        if (gemini) {
            env.put("GEMINI_API_KEY", "test-key");
        }
        if (openai) {
            env.put("OPENAI_API_KEY", "test-key");
        }

        assertEquals(expected, ImageProviders.withAKey(named, env));
    }

    @Test
    void aBlankKeyIsNoKey() {
        // resolveApiKey and imageEnvFrom both treat blank as unset; a rule that
        // did not would hand a generation an empty Authorization header.
        assertEquals("openai", ImageProviders.withAKey("gemini",
                Map.of("GEMINI_API_KEY", "  ", "OPENAI_API_KEY", "test-key")));
    }

    @Test
    void anUnknownBackendIsHandedBackUntouchedSoCreateGivesTheRealError() {
        assertEquals("dalle", ImageProviders.withAKey("dalle",
                Map.of("OPENAI_API_KEY", "test-key")));
    }

    @Test
    void theKeyVariableIsTheOneCreateActuallyDemands() {
        // One spelling per backend. Two would drift the day a third backend
        // lands and the fallback would quietly stop seeing its key.
        assertEquals("GEMINI_API_KEY", ImageProviders.keyVariable("gemini"));
        assertEquals("OPENAI_API_KEY", ImageProviders.keyVariable("openai"));
        assertThrows(IllegalArgumentException.class, () -> ImageProviders.keyVariable("dalle"));
    }
}
