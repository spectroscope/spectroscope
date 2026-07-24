package dev.spectroscope.core.local;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The per-model capability flags the agent loop reads. */
class ModelProfileTest {

    @Test
    void builtInIsReasoningNotTools() {
        ModelProfile p = ModelProfile.forProvider("spectro-local");
        assertFalse(p.nativeTools(), "the bundled reasoner does not do native tool_calls");
        assertTrue(p.reasoning());
    }

    @Test
    void cloudProvidersAssumeNativeTools() {
        assertTrue(ModelProfile.forProvider("anthropic").nativeTools());
        assertTrue(ModelProfile.forProvider("openai").nativeTools());
        assertTrue(ModelProfile.forProvider("ollama").nativeTools());
    }
}
