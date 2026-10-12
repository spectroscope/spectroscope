package dev.spectroscope.core.loop;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 504, criterion 6: {@code /loop [interval] <prompt>} as the REPL and the server read it. */
class LoopCommandTest {

    @Test
    void aLeadingIntervalIsReadInSecondsMinutesAndHours() {
        assertEquals(new LoopCommand(120, "check the CI"), LoopCommand.parse("/loop 2m check the CI"));
        assertEquals(new LoopCommand(90, "x"), LoopCommand.parse("/loop 90s x"));
        assertEquals(new LoopCommand(3_600, "x"), LoopCommand.parse("/loop 1h x"));
        assertEquals(new LoopCommand(172_800, "x"), LoopCommand.parse("/loop 2d x"), "clamped by the loop, not here");
    }

    @Test
    void withoutAnIntervalThePromptIsTheRest() {
        assertEquals(new LoopCommand(null, "watch the build"), LoopCommand.parse("/loop watch the build"));
        assertEquals(new LoopCommand(null, "2 minutes from now check"), LoopCommand.parse("/loop 2 minutes from now check"));
    }

    @Test
    void anEmptyPromptIsNotALoop() {
        assertNull(LoopCommand.parse("/loop"));
        assertNull(LoopCommand.parse("/loop   "));
        assertNull(LoopCommand.parse("/loop 5m"));
        assertTrue(LoopCommand.USAGE.startsWith("Usage: /loop [interval] <prompt>"), LoopCommand.USAGE);
    }

    @Test
    void onlyADraftThatOpensWithTheCommandIsOne() {
        assertTrue(LoopCommand.isLoop("/loop x"));
        assertTrue(LoopCommand.isLoop("/loop"));
        assertFalse(LoopCommand.isLoop("/looping x"));
        assertFalse(LoopCommand.isLoop("please /loop x"));
    }
}
