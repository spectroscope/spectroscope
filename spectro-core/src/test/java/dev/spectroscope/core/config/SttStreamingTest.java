package dev.spectroscope.core.config;

import dev.spectroscope.core.config.governing.GoverningNumber;
import dev.spectroscope.core.config.governing.GoverningNumbers;
import dev.spectroscope.core.config.governing.Governs;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 527: the numbers that pace local live text are on the registry and
 * hold together.
 */
class SttStreamingTest {

    @Test
    void theChunkStepFitsInsideOneWindowAndAPauseFitsInsideOneStep() {
        assertTrue(SttStreaming.STT_LOCAL_CHUNK_MS > 0);
        assertTrue(SttStreaming.STT_LOCAL_CHUNK_MS < SttStreaming.STT_LOCAL_WINDOW_MS,
                "a window that closes before its first run would never show a word");
        assertTrue(SttStreaming.STT_LOCAL_PAUSE_MS < SttStreaming.STT_LOCAL_CHUNK_MS,
                "a pause longer than a step would need audio a run does not have yet");
    }

    @Test
    void theWarmUpGetsLongerThanOneStep() {
        assertTrue(SttStreaming.STT_WARMUP_TIMEOUT_MS > SttStreaming.STT_LOCAL_CHUNK_MS,
                "a cold model takes longer to load than one warm run");
    }

    @Test
    void theChunkStepIsOnTheRegistryInMilliseconds() {
        GoverningNumber step = GoverningNumbers.all().stream()
                .filter(n -> n.field().equals("STT_LOCAL_CHUNK_MS"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("STT_LOCAL_CHUNK_MS is not on the registry"));
        assertEquals(Governs.Unit.MILLISECONDS, step.unit());
        assertEquals(String.valueOf(SttStreaming.STT_LOCAL_CHUNK_MS), step.value());
        assertTrue(step.explanation().contains("whisper-cli"), step.explanation());
    }
}
