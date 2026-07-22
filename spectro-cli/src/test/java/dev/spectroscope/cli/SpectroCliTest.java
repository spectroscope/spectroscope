package dev.spectroscope.cli;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class SpectroCliTest {

    @Test
    void firstRunHintNamesTheFreeLocalPathsAndTheProvidersOwnKey() {
        String hint = SpectroCli.firstRunHint("openrouter");
        // The two zero-cost local options a newcomer can take right now.
        assertTrue(hint.contains("ollama"), hint);
        assertTrue(hint.toLowerCase().contains("lm studio") || hint.contains("lmstudio"), hint);
        // The exact env var for THIS provider's key — not a generic message.
        assertTrue(hint.contains("OPENROUTER_API_KEY"), hint);
        // Keys go in .env (owner decision), not settings.json.
        assertTrue(hint.contains(".env"), hint);
    }

    @Test
    void firstRunHintUsesTheRightKeyPerProvider() {
        assertTrue(SpectroCli.firstRunHint("anthropic").contains("ANTHROPIC_API_KEY"));
        assertTrue(SpectroCli.firstRunHint("openai").contains("OPENAI_API_KEY"));
    }
}
