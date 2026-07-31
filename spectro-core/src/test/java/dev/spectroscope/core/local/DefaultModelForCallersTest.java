package dev.spectroscope.core.local;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * What {@code defaultModelFor("spectro-local")} actually answers, and whether
 * every caller of that answer survives it. Two sources for one fact is the drift
 * the catalogue was built to end, so this pins the whole chain, not just the
 * string: the id has to exist in the catalogue, resolve to itself, be able to
 * drive the runtime, and pass config validation on the boot path.
 */
class DefaultModelForCallersTest {

    @Test
    void theAnswerIsACatalogueIdThatResolvesToItself() {
        String answer = SpectroConfig.defaultModelFor("spectro-local");
        assertNotNull(answer, "the built-in provider must have an honest default");
        assertEquals(LocalCatalog.bundled().defaultId(), answer, "one source for one fact");
        assertEquals(answer, LocalCatalog.bundled().resolve(answer).id(),
                "the id must round-trip through the catalogue, not fall back to the default");
    }

    /** Caller 1 is the boot path (finishResolve substitutes this id when no layer
     *  set a model); it is verified live against a booted server, since the
     *  env-injectable loader is package-private to the config package.
     *
     *  Caller 2: the live picker switch (SessionConnection resolves a blank model
     *  through the same method, then hands it to ServerLocalRuntime). What the
     *  runtime would run for that id must be the same model, and it must be one
     *  the capability profile calls tool-capable — otherwise the switch silently
     *  disarms the tool belt. */
    @Test
    void theLiveSwitchWouldRunTheSameModelAndKeepItsTools() {
        String answer = SpectroConfig.defaultModelFor("spectro-local");
        LocalCatalog.Model entry = LocalCatalog.bundled().resolve(answer);
        assertEquals(answer, entry.id());
        ModelProfile profile = ModelProfile.forModel("spectro-local", answer);
        assertTrue(profile.nativeTools(), "the default a blank switch lands on must drive tools");
        assertTrue(profile.reasoning(), "and it must have the think channel the app is about");
    }

    /** The neighbours of the same switch: the other providers' defaults are what
     *  the picker relies on to never carry a foreign model id across a switch. */
    @Test
    void theOtherProvidersDefaultsAreUnchangedByTheCatalogueLookup() {
        assertEquals("qwen3", SpectroConfig.defaultModelFor("ollama"));
        assertEquals("local-model", SpectroConfig.defaultModelFor("lmstudio"));
        assertEquals("local-model", SpectroConfig.defaultModelFor("openai"));
        assertEquals(null, SpectroConfig.defaultModelFor("gemini"));
        assertEquals(null, SpectroConfig.defaultModelFor("openrouter"));
    }
}
