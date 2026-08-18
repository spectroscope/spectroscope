package dev.spectroscope.core.session;

import dev.spectroscope.core.Agent;
import dev.spectroscope.core.session.CompactionThreshold.Derived;
import dev.spectroscope.core.session.CompactionThreshold.Source;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 263: the pure half of the threshold — what number the harness compacts
 * at, and which fact produced it.
 *
 * <p>The numbers in these tests are not remembered, they are derived from one
 * stated rule (three quarters of the window) against windows this house has
 * MEASURED. The LM Studio figures come from
 * {@code curl -s <lmstudio>/api/v1/models}, read on 2026-08-18:
 * {@code loaded_instances[0].config.context_length} was 204,288 and
 * {@code max_context_length} 1,048,576. The ollama figure comes from
 * {@code curl -s http://localhost:11434/api/ps} on ollama 0.24.0 with
 * qwen2.5:3b loaded: {@code models[0].context_length} 32,768.</p>
 */
class CompactionThresholdTest {

    @Test
    void anExplicitThresholdWinsOverAnythingTheBackendSays() {
        // AC 3: the settings lever stays the lever. An operator who typed a
        // number gets that number, even when the backend offers ten times more.
        Derived derived = CompactionThreshold.derive(50_000, 204_288);

        assertEquals(50_000, derived.tokens());
        assertEquals(Source.OVERRIDE, derived.source());
    }

    @Test
    void theLoadedWindowBecomesThreeQuartersOfItself() {
        // AC 1: 204,288 measured on the owner's backend → 153,216, not 100,000.
        Derived derived = CompactionThreshold.derive(null, 204_288);

        assertEquals(153_216, derived.tokens());
        assertEquals(Source.WINDOW, derived.source());
    }

    @Test
    void aSmallWindowCompactsEarlierThanTheOldConstantAndNotLater() {
        // AC 4: the derivation is measured in BOTH directions. A model loaded
        // with 8k must compact at 6k, not at 100k — the old constant would let
        // the harness fill a 8k window twelve times over before summarizing.
        Derived derived = CompactionThreshold.derive(null, 8_192);

        assertEquals(6_144, derived.tokens());
        assertEquals(Source.WINDOW, derived.source());
        assertTrue(derived.tokens() < CompactionThreshold.FALLBACK_THRESHOLD,
                "a window smaller than the constant must pull the threshold DOWN");
    }

    @Test
    void theReserveCoversTheDefaultCompletionBudgetAtTheSmallestCommonWindow() {
        // WHY three quarters and not nine tenths: the moment the threshold
        // trips, the very next provider call is the compaction summarizer,
        // which re-sends the same history AND asks for a completion on top.
        // 131,072 is the smallest window in common use among the models this
        // house runs (measured: three of the sixteen installed LM Studio models
        // report max_context_length 131,072). A quarter of it is 32,768 — just
        // over the agent's default completion budget. A tenth would be 13,107,
        // and the request the trip exists to prevent would be the one to burst.
        Derived derived = CompactionThreshold.derive(null, 131_072);

        assertEquals(98_304, derived.tokens());
        assertTrue(131_072 - derived.tokens() >= Agent.DEFAULT_MAX_TOKENS,
                "the reserve must still hold one default completion budget");
    }

    @Test
    void anOllamaSizedWindowLandsWhereTheArithmeticSaysAndNotOnTheConstant() {
        // 32,768 measured off /api/ps with qwen2.5:3b loaded.
        assertEquals(new Derived(24_576, Source.WINDOW),
                CompactionThreshold.derive(null, 32_768));
    }

    @Test
    void nothingLearnedKeepsTodaysHundredThousandAndSaysSo() {
        // AC 1's last clause: anthropic and every silent endpoint land here.
        Derived derived = CompactionThreshold.derive(null, 0);

        assertEquals(100_000, derived.tokens());
        assertEquals(Source.FALLBACK, derived.source());
        assertEquals("fallback", derived.source().wireName());
    }

    @Test
    void aNonsensicalWindowIsNotKnowledge() {
        // A backend that answers with a negative or absurd number has told us
        // nothing. Taking it literally would compact on turn one, forever.
        assertEquals(Source.FALLBACK, CompactionThreshold.derive(null, -1).source());
        assertEquals(Source.FALLBACK, CompactionThreshold.derive(null, 0).source());
    }

    @Test
    void anOverrideOfZeroIsUnsetAndNotAnInstructionToCompactEveryTurn() {
        // Compaction.maybeCompact returns early only while lastInputTokens <
        // threshold, so a threshold of 0 compacts on the empty first turn and
        // every turn after. The web's own popover refuses values below 1
        // (workspaceGear spec min: 1); the harness must refuse them too rather
        // than trust that the only writer is the popover.
        assertEquals(Source.WINDOW, CompactionThreshold.derive(0, 204_288).source());
        assertEquals(Source.FALLBACK, CompactionThreshold.derive(-5, 0).source());
    }

    @Test
    void aWindowTooSmallToHalveStillLeavesRoomForOneToken() {
        // The embedding model in the owner's LM Studio reports 2,048; nothing
        // stops a toy window either. Integer division must never reach 0 — a
        // zero threshold is the compact-every-turn defect above.
        assertEquals(1_536, CompactionThreshold.derive(null, 2_048).tokens());
        assertEquals(1, CompactionThreshold.derive(null, 1).tokens());
    }

    @Test
    void aHugeWindowDoesNotOverflowIntoANegativeThreshold() {
        // max_context_length on the owner's backend is 1,048,576 today, and a
        // window times three overflows a signed int above 715 million. The
        // multiplication must be done in long.
        Derived derived = CompactionThreshold.derive(null, Integer.MAX_VALUE);

        assertTrue(derived.tokens() > 0, "the arithmetic must not wrap");
        assertEquals(1_610_612_735, derived.tokens());
    }
}
