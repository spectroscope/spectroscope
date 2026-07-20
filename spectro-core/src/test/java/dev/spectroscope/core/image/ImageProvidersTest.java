package dev.spectroscope.core.image;

import org.junit.jupiter.api.Test;

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
}
