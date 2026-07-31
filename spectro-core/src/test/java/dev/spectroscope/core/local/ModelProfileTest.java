package dev.spectroscope.core.local;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The per-model capability flags the agent loop reads. */
class ModelProfileTest {

    @Test
    @DisplayName("the built-in provider is no longer one answer: it depends on the model")
    void builtInDependsOnTheModel() {
        assertFalse(ModelProfile.forModel("spectro-local", "vibethinker-3b").nativeTools(),
                "the small reasoner still emits tool calls as text, so do not advertise tools");
        assertTrue(ModelProfile.forModel("spectro-local", "vibethinker-3b").reasoning());

        assertTrue(ModelProfile.forModel("spectro-local", "qwen3-4b").nativeTools(),
                "a tool-capable local model is the whole point of the chooser");
        assertTrue(ModelProfile.forModel("spectro-local", "qwen3-4b").reasoning());

        assertTrue(ModelProfile.forModel("spectro-local", "qwen2-5-coder-7b").nativeTools());
        assertFalse(ModelProfile.forModel("spectro-local", "qwen2-5-coder-7b").reasoning(),
                "the coder is instruction-tuned, not a reasoner; do not promise a think channel");
    }

    @Test
    @DisplayName("a stale local model id profiles as whatever the runtime will actually start")
    void staleIdMatchesWhatRuns() {
        LocalCatalog catalogue = LocalCatalog.bundled();
        ModelProfile expected = catalogue.defaultModel().profile();
        assertEquals(expected, ModelProfile.forModel("spectro-local", "retired-model"));
        assertEquals(expected, ModelProfile.forModel("spectro-local", null));
    }

    @Test
    void cloudProvidersAssumeNativeTools() {
        assertTrue(ModelProfile.forModel("anthropic", "claude-opus-5").nativeTools());
        assertTrue(ModelProfile.forModel("openai", "gpt-5").nativeTools());
        assertTrue(ModelProfile.forModel("ollama", "qwen3.5:27b").nativeTools());
        assertTrue(ModelProfile.forModel(null, null).nativeTools(),
                "an unknown provider keeps the old permissive default");
    }
}
