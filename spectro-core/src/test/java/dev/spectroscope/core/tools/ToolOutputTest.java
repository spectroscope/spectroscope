package dev.spectroscope.core.tools;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;

class ToolOutputTest {

    @Test
    void shortStringsPassThroughUntouched() {
        assertSame("abc", ToolOutput.clip("abc", 10));
    }

    @Test
    void longStringsAreCutAtTheCap() {
        assertEquals("abcde", ToolOutput.clip("abcdefgh", 5));
    }

    @Test
    void aSurrogatePairIsNeverSplit() {
        String s = "ab😀rest"; // an emoji occupies indices 2-3
        String clipped = ToolOutput.clip(s, 3); // a naive cut would split the pair
        assertEquals("ab", clipped);
    }
}
