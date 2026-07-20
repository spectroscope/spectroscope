package dev.spectroscope.cli.speech;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * The production engine's availability check, proven WITHOUT installing piper: the
 * spectro-cli test task points {@code user.home} at a throwaway build directory (see
 * build.gradle.kts), so {@code ~/.spectro/models/piper} does not exist here. The engine
 * must report itself unavailable — which is what makes the renderer print its readable
 * "run bash scripts/setup-tts.sh" hint instead of crashing. No binary is downloaded or
 * run.
 */
class PiperSpeechEngineTest {

    @Test
    void reportsUnavailableWhenThePiperBinaryIsAbsent() {
        // The voice model file is likewise absent under the test home; isAvailable()
        // short-circuits on the missing binary either way.
        PiperSpeechEngine engine = new PiperSpeechEngine("en_US-lessac-medium");

        assertFalse(engine.isAvailable(),
                "with no piper binary under ~/.spectro/models, voice output must not claim to work");
    }
}
