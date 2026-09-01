package dev.spectroscope.core.session;

import dev.spectroscope.core.Agent;
import dev.spectroscope.core.session.CompactionThreshold.Derived;
import dev.spectroscope.core.session.CompactionThreshold.Source;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 263: the pure half of the threshold — what number the harness compacts
 * at, and which fact produced it. Card 366 adds the third fact (a model's
 * PUBLISHED window) and moves the share from three quarters to 70 %.
 *
 * <p>The numbers in these tests are not remembered, they are derived from one
 * stated rule (70 % of the window) against windows this house has MEASURED. The
 * LM Studio figures come from {@code curl -s <lmstudio>/api/v1/models}, read on
 * 2026-08-18: {@code loaded_instances[0].config.context_length} was 204,288 and
 * {@code max_context_length} 1,048,576. The ollama figure comes from
 * {@code curl -s http://localhost:11434/api/ps} on ollama 0.24.0 with
 * qwen2.5:3b loaded: {@code models[0].context_length} 32,768.</p>
 */
class CompactionThresholdTest {

    @Test
    void anExplicitThresholdWinsOverAnythingTheBackendSays() {
        // AC 3 of card 263: the settings lever stays the lever. An operator who
        // typed a number gets that number, even when the backend offers ten
        // times more.
        Derived derived = CompactionThreshold.derive(50_000, 204_288);

        assertEquals(50_000, derived.tokens());
        assertEquals(Source.OVERRIDE, derived.source());
    }

    @Test
    void theLoadedWindowBecomesSeventyPercentOfItself() {
        // 204,288 measured on the owner's backend → 143,001, not 100,000.
        Derived derived = CompactionThreshold.derive(null, 204_288);

        assertEquals(143_001, derived.tokens());
        assertEquals(Source.WINDOW, derived.source());
        assertEquals(204_288, derived.window(),
                "and the window itself rides along, so the gauge can name it");
    }

    @Test
    void aSmallWindowCompactsEarlierThanTheOldConstantAndNotLater() {
        // The derivation is measured in BOTH directions. A model loaded with 8k
        // must compact at 5,734, not at 100,000 — the old constant would let the
        // harness fill an 8k window twelve times over before summarizing.
        Derived derived = CompactionThreshold.derive(null, 8_192);

        assertEquals(5_734, derived.tokens());
        assertEquals(Source.WINDOW, derived.source());
        assertTrue(derived.tokens() < CompactionThreshold.FALLBACK_THRESHOLD,
                "a window smaller than the constant must pull the threshold DOWN");
    }

    @Test
    void theReserveCoversTheDefaultCompletionBudgetAtTheSmallestCommonWindow() {
        // WHY 70 % and not 90 %: the moment the threshold trips, the very next
        // provider call is the compaction summarizer, which re-sends the same
        // history AND asks for a completion on top. 131,072 is the smallest
        // window in common use among the models this house runs (measured: three
        // of the sixteen installed LM Studio models report max_context_length
        // 131,072). The reserve there is 39,322 — still above the agent's
        // default completion budget, which is the whole argument card 366 was
        // asked to re-check when the share moved off three quarters. A tenth
        // would leave 13,107, and the request the trip exists to prevent would
        // be the one to burst.
        Derived derived = CompactionThreshold.derive(null, 131_072);

        assertEquals(91_750, derived.tokens());
        assertEquals(39_322, 131_072 - derived.tokens());
        assertTrue(131_072 - derived.tokens() >= Agent.DEFAULT_MAX_TOKENS,
                "the reserve must still hold one default completion budget");
    }

    @Test
    void anOllamaSizedWindowLandsWhereTheArithmeticSaysAndNotOnTheConstant() {
        // 32,768 measured off /api/ps with qwen2.5:3b loaded.
        assertEquals(new Derived(22_937, Source.WINDOW, 32_768),
                CompactionThreshold.derive(null, 32_768));
    }

    @Test
    void nothingLearnedKeepsTodaysHundredThousandAndSaysSo() {
        // No loaded instance, no published window, no setting: the constant.
        Derived derived = CompactionThreshold.derive(null, 0);

        assertEquals(100_000, derived.tokens());
        assertEquals(Source.FALLBACK, derived.source());
        assertEquals("fallback", derived.source().wireName());
        assertEquals(0, derived.window(), "a fallback names no window, and must not invent one");
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
        assertEquals(1_433, CompactionThreshold.derive(null, 2_048).tokens());
        assertEquals(1, CompactionThreshold.derive(null, 1).tokens());
    }

    @Test
    void anExplicitThresholdIsNeverPaidForWithARoundTrip() {
        // Review finding on card 263: `derive(override, provider.contextWindow())`
        // evaluates the argument eagerly — Java has no short circuit there — so an
        // operator who used the lever still paid the probe on every run and the
        // answer was thrown away. Measured against a black-holed host that is
        // 2,001 ms of dead air BEFORE run_start is emitted. The lazy form asks
        // nothing.
        java.util.concurrent.atomic.AtomicInteger asked =
                new java.util.concurrent.atomic.AtomicInteger();

        Derived derived = CompactionThreshold.derive(50_000, () -> {
            asked.incrementAndGet();
            return 204_288;
        }, "claude-opus-4-6");

        assertEquals(50_000, derived.tokens());
        assertEquals(Source.OVERRIDE, derived.source());
        assertEquals(0, asked.get(), "an override must not cost a capability round trip");
    }

    @Test
    void withoutAnOverrideTheBackendIsAskedExactlyOnce() {
        java.util.concurrent.atomic.AtomicInteger asked =
                new java.util.concurrent.atomic.AtomicInteger();

        Derived derived = CompactionThreshold.derive(null, () -> {
            asked.incrementAndGet();
            return 204_288;
        });

        assertEquals(143_001, derived.tokens());
        assertEquals(1, asked.get());
    }

    @Test
    void aZeroOverrideIsUnsetAndStillAsksTheBackend() {
        // The zero-is-unset rule lives in ONE place. If the lazy form kept its
        // own copy of it, the two could drift and a 0 would skip the probe and
        // then be refused, landing every such session on the fallback.
        java.util.concurrent.atomic.AtomicInteger asked =
                new java.util.concurrent.atomic.AtomicInteger();

        Derived derived = CompactionThreshold.derive(0, () -> {
            asked.incrementAndGet();
            return 8_192;
        });

        assertEquals(Source.WINDOW, derived.source());
        assertEquals(5_734, derived.tokens());
        assertEquals(1, asked.get());
    }

    @Test
    void theSummarizerIsGivenTheReserveItWasSizedFor() {
        // Review finding on card 263: the summarizer's request hardcoded 32,000
        // maxTokens. On a model loaded at 8,192 the derived threshold is 5,734
        // and the reserve is 2,458 — so the ONE call the reserve exists to hold
        // asked for thirteen times the room it has. The budget is the reserve,
        // and card 366 made it the MEASURED reserve (window minus threshold)
        // rather than a second expression of the share: 30 over 70 is not a
        // whole number, and a budget derived from the fraction a second time
        // would have drifted from the room actually left.
        assertEquals(2_458, CompactionThreshold.summaryBudget(
                CompactionThreshold.derive(null, 8_192)),
                "the budget is the reserve: 8,192 - 5,734");
        assertEquals(1_229, CompactionThreshold.summaryBudget(
                CompactionThreshold.derive(null, 4_096)),
                "and it tracks the window down: 4,096 - 2,867");
        // The floor, and it has to be measured where ONLY the floor can produce
        // the number: 30 % of 1,024 is 308, so a green 512 here is the floor and
        // nothing else. (Biting this the first time found the trap — written
        // against a 2,048 window the assertion passed with the floor removed,
        // because a quarter of 2,048 IS 512.)
        assertEquals(512, CompactionThreshold.summaryBudget(
                CompactionThreshold.derive(null, 1_024)),
                "never below a floor a summary can be written in at all");
    }

    @Test
    void aBigWindowKeepsTheFullCompletionBudgetAndDoesNotGrowPastIt() {
        // The clamp only ever takes budget AWAY. 204,288 has a 61,287 reserve;
        // handing the summarizer more than the run's own turns may spend would
        // be a second, unrelated change.
        assertEquals(Agent.DEFAULT_MAX_TOKENS, CompactionThreshold.summaryBudget(
                CompactionThreshold.derive(null, 204_288)));
        assertEquals(Agent.DEFAULT_MAX_TOKENS, CompactionThreshold.summaryBudget(
                CompactionThreshold.derive(null, 0)),
                "nothing known about the window means nothing to clamp against");
        assertEquals(Agent.DEFAULT_MAX_TOKENS, CompactionThreshold.summaryBudget(
                CompactionThreshold.derive(5_000, 0)),
                "an operator's threshold says nothing about the window either");
    }

    @Test
    void aHugeWindowDoesNotOverflowIntoANegativeThreshold() {
        // max_context_length on the owner's backend is 1,048,576 today, and a
        // window times seven overflows a signed int above 306 million. The
        // multiplication must be done in long.
        Derived derived = CompactionThreshold.derive(null, Integer.MAX_VALUE);

        assertTrue(derived.tokens() > 0, "the arithmetic must not wrap");
        assertEquals(1_503_238_552, derived.tokens());
    }

    // ---- card 366: the published window, and the order of the four facts ----

    @Test
    void aCloudModelDerivesFromItsPublishedWindowInsteadOfTheConstant() {
        // AC 1, and the whole reason the card exists. AnthropicProvider does not
        // override contextWindow() — there is no endpoint to ask and, more to
        // the point, no loaded instance to overrun — so it answers 0. Before
        // this card that landed a 1,000,000-token model on the 100,000 constant:
        // 10 % of the window the operator is paying for.
        Derived derived = CompactionThreshold.derive(null, 0, "claude-opus-4-6");

        assertEquals(700_000, derived.tokens());
        assertEquals(Source.MODEL, derived.source());
        assertEquals("model", derived.source().wireName());
        assertEquals(1_000_000, derived.window());
        assertNotEquals(CompactionThreshold.FALLBACK_THRESHOLD, derived.tokens(),
                "the case this card was written for is exactly the one that used to fall back");
    }

    @Test
    void aLoadedInstanceOutranksWhatTheModelPublishes() {
        // AC 4, and the direction that matters: the SERVER can serve less than
        // the model can hold, and it can never serve more. A gateway that speaks
        // the OpenAI wire for claude-opus while holding only 32,768 tokens of KV
        // cache must compact against the 32,768 — taking the published million
        // would push compaction past the window actually held, the one direction
        // OpenAiCompatProvider.loadedWindow calls worse than the constant.
        Derived derived = CompactionThreshold.derive(null, 32_768, "claude-opus-4-6");

        assertEquals(22_937, derived.tokens());
        assertEquals(Source.WINDOW, derived.source());
        assertEquals(32_768, derived.window());
    }

    @Test
    void anExplicitSettingOutranksThePublishedWindowToo() {
        // AC 4's top rung. A number the operator typed is knowledge the harness
        // does not have, whatever any table says.
        Derived derived = CompactionThreshold.derive(50_000, 0, "claude-opus-4-6");

        assertEquals(50_000, derived.tokens());
        assertEquals(Source.OVERRIDE, derived.source());
        assertEquals(1_000_000, derived.window(),
                "the override decides the THRESHOLD; the window is still known and still named");
    }

    @Test
    void theWholeOrderOfPrecedenceInOneRun() {
        // AC 4 stated as one sequence rather than four separate cases: setting,
        // then loaded instance, then published window, then the constant. Each
        // line removes the tier above it and nothing else.
        assertEquals(Source.OVERRIDE,
                CompactionThreshold.derive(50_000, 32_768, "claude-opus-4-6").source());
        assertEquals(Source.WINDOW,
                CompactionThreshold.derive(null, 32_768, "claude-opus-4-6").source());
        assertEquals(Source.MODEL,
                CompactionThreshold.derive(null, 0, "claude-opus-4-6").source());
        assertEquals(Source.FALLBACK,
                CompactionThreshold.derive(null, 0, "qwen3.8-flash-next@q4_k_xl").source());
    }

    @Test
    void theFallbackIsOnlyReachedWhenNothingAtAllIsKnown() {
        // AC 5. After this card the constant means "a custom or unrecognised
        // backend", and it must NOT be where a known hosted model lands.
        assertEquals(Source.FALLBACK, CompactionThreshold.derive(null, 0, null).source());
        assertEquals(Source.FALLBACK,
                CompactionThreshold.derive(null, 0, "deepseek-v4-flash-0731@iq1_m").source());
        for (String hosted : new String[] {"claude-opus-4-6", "claude-haiku-4-5",
                                           "gpt-4o", "gpt-5-5", "gemini-2.5-pro"}) {
            assertNotEquals(Source.FALLBACK, CompactionThreshold.derive(null, 0, hosted).source(),
                    hosted + " publishes its window — the constant is not its answer");
            assertNotEquals(CompactionThreshold.FALLBACK_THRESHOLD,
                    CompactionThreshold.derive(null, 0, hosted).tokens(), hosted);
        }
    }

    @Test
    void aPublishedWindowIsNeverPaidForWithARoundTripEither() {
        // The lazy form's contract, with the third tier under it: the probe is
        // spent because the loaded instance outranks the table, but a model the
        // table knows must not turn the probe into a second call.
        java.util.concurrent.atomic.AtomicInteger asked =
                new java.util.concurrent.atomic.AtomicInteger();

        Derived derived = CompactionThreshold.derive(null, () -> {
            asked.incrementAndGet();
            return 0;
        }, "claude-opus-4-6");

        assertEquals(700_000, derived.tokens());
        assertEquals(Source.MODEL, derived.source());
        assertEquals(1, asked.get(), "asked once, and only once");
    }

    @Test
    void thePublishedWindowFeedsTheSummarizersBudgetLikeAMeasuredOne() {
        // FOUND BY A BITE THAT CAME BACK GREEN. The first version of this test
        // asserted DEFAULT_MAX_TOKENS for claude-opus and claude-haiku, and
        // removing MODEL from the clamp changed neither: the smallest window in
        // the published table is 128,000, whose 30 % reserve is 38,400 — above
        // the 32,000 budget, so every row clamps to nothing. The test could not
        // fail, which is the same shape as no test at all.
        //
        // So the case is CONSTRUCTED rather than derived: a published window
        // small enough for the reserve to matter. No vendor in ModelWindows
        // publishes one today, and the branch is what stops a 40,000-token model
        // added tomorrow from asking its summarizer for 32,000 tokens of a
        // 12,000-token gap.
        assertEquals(12_000, CompactionThreshold.summaryBudget(
                new Derived(28_000, Source.MODEL, 40_000)),
                "a published window is a window: the budget is the room it leaves");
        // And the no-op the first version measured, kept as what it really is —
        // a statement about today's table, not about the branch.
        assertEquals(Agent.DEFAULT_MAX_TOKENS, CompactionThreshold.summaryBudget(
                CompactionThreshold.derive(null, 0, "claude-opus-4-6")));
        assertEquals(Agent.DEFAULT_MAX_TOKENS, CompactionThreshold.summaryBudget(
                CompactionThreshold.derive(null, 0, "gpt-4o")),
                "no row in today's table is small enough for the clamp to bite");
    }
}
