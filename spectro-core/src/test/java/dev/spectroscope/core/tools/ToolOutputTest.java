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

    /** Card 489: 25 % of 8,192 tokens at 3 characters per token. */
    @Test
    void onAnEightKilotokenWindowTheClampIsTheReadShare() {
        assertEquals(6_144, ToolOutput.maxOutputChars(8_192));
    }

    @Test
    void onALargeWindowTheClampStaysAtTenThousand() {
        assertEquals(10_000, ToolOutput.maxOutputChars(200_000));
        assertEquals(10_000, ToolOutput.maxOutputChars(250_368));
    }

    /** The smallest window whose read share covers the old clamp: 3,334
     *  tokens of allowance times 3 is 10,002. One token less stays below it. */
    @Test
    void theWindowWhereTheOldClampTakesOverIsThirteenThousandThreeHundredThirtySix() {
        assertEquals(9_999, ToolOutput.maxOutputChars(13_335));
        assertEquals(10_000, ToolOutput.maxOutputChars(13_336));
    }

    /** No window known: the compaction fallback of 100,000 tokens, as for read_file. */
    @Test
    void anUnknownWindowKeepsTheOldClamp() {
        assertEquals(10_000, ToolOutput.maxOutputChars(0));
    }

    /** The share comes from the same source read_file uses, at every window. */
    @Test
    void theClampIsTheReadAllowanceCappedAtTheFixedValue() {
        for (int window : new int[] {1, 2, 4, 100, 2_048, 4_096, 8_192, 13_336, 32_768, 1_000_000}) {
            long share = ReadBudget.tokenAllowance(window) * ReadBudget.BYTES_PER_TOKEN;
            assertEquals(Math.max(1, Math.min(ToolOutput.MAX_OUTPUT_CHARS, share)),
                    ToolOutput.maxOutputChars(window), "window " + window);
        }
    }

    /** A window too small for one character still leaves a clamp a clip can use. */
    @Test
    void aTinyWindowStillClipsWithoutFailing() {
        assertEquals(1, ToolOutput.maxOutputChars(1));
        assertEquals("a", ToolOutput.clip("abc", ToolOutput.maxOutputChars(1)));
        assertEquals("\u2026", ToolOutput.clipTail("abc", ToolOutput.maxOutputChars(1)));
    }

    /** Card 489, round three: a notice that fits beside the output is joined as it is. */
    @Test
    void clipBeforeJoinsANoticeThatFits() {
        assertEquals("abc(n)", ToolOutput.clipBefore("abc", "(n)", 6));
        assertEquals("abc(n)", ToolOutput.clipBefore("abc", "(n)", 10_000));
    }

    /** Card 489, round three: over the bound the output gives way and the notice stays whole. */
    @Test
    void clipBeforeKeepsTheNoticeWholeAndCutsTheOutput() {
        String kept = ToolOutput.clipBefore("abcdefgh", "(n)", 6);
        assertEquals("abc(n)", kept);
        assertEquals(6, kept.length(), "the result is the bound");
        // A cut never splits a surrogate pair in front of the notice.
        assertEquals("a(n)", ToolOutput.clipBefore("a\uD83D\uDE00b", "(n)", 5));
    }

    /** Card 489, round three: a notice that alone fills the bound is cut like any text. */
    @Test
    void clipBeforeCutsANoticeThatDoesNotFitAlone() {
        assertEquals("ab(n", ToolOutput.clipBefore("ab", "(notice)", 4));
        assertEquals("(not", ToolOutput.clipBefore("", "(notice)", 4));
    }
}
