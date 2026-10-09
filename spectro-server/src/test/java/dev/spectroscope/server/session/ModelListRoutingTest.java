package dev.spectroscope.server.session;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Card 472: which wire {@code GET /api/models} asks a provider on. The code
 * graph sheet offers every provider the harness knows that graphify can dial,
 * and refuses a build when the provider lists no models. So the model list
 * must come from the same rule the provider list does
 * ({@link SpectroConfig#openAiCompatProviders()}), never from a second, typed
 * list of providers that a new one would be missing from.
 */
class ModelListRoutingTest {

    @Test
    void everyOpenAiCompatibleProviderTheHarnessKnowsIsAskedOnTheOpenAiWire() {
        for (String provider : SpectroConfig.openAiCompatProviders()) {
            assertEquals("openai", SessionsController.modelWire(provider,
                    SpectroConfig.openAiCompatProviders()::contains), provider);
        }
    }

    @Test
    void aProviderAddedToTheOpenAiCompatibleRuleIsAskedWithoutAnotherEdit() {
        Set<String> compat = Set.of("openai", "brand-new-compat");
        assertEquals("openai", SessionsController.modelWire("brand-new-compat", compat::contains));
    }

    @Test
    void anthropicAndOllamaKeepTheirOwnWiresAndAnythingElseListsNothing() {
        assertEquals("anthropic", SessionsController.modelWire("anthropic", p -> true));
        assertEquals("ollama", SessionsController.modelWire("ollama", p -> true));
        assertNull(SessionsController.modelWire("spectro-local", p -> false));
        assertNull(SessionsController.modelWire("", p -> false));
    }
}
