package dev.spectroscope.core.session;

import dev.spectroscope.core.Agent;
import dev.spectroscope.core.session.CompactionThreshold.Derived;
import dev.spectroscope.core.session.CompactionThreshold.Source;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 488: the completion budget of a turn is
 * {@code min(maxTokens, window minus compaction threshold)}, from the window
 * the run already uses for compaction.
 *
 * <p>The rule lives in {@link CompactionThreshold#completionBudget}; the turn
 * loop and the compaction summarizer both read it, so no provider adapter
 * computes it on its own.</p>
 */
class CompletionBudgetTest {

    @Test
    void anEightKiloWindowLeavesTheReserveAndNotTheConfiguredBudget() {
        // 8,192 x 7 / 10 = 5,734 (integer); the reserve is 2,458.
        Derived derived = CompactionThreshold.derive(null, 8_192);
        assertEquals(5_734, derived.tokens(), "premise: the threshold on an 8,192 window");

        assertEquals(2_458, CompactionThreshold.completionBudget(derived, Agent.DEFAULT_MAX_TOKENS),
                "32,000 on an 8,192 window asks for more than the whole window");
        assertEquals(2_458, CompactionThreshold.completionBudget(derived, 16_000),
                "the OpenAI-compatible path's 16,000 is above the window too");
        assertEquals(1_000, CompactionThreshold.completionBudget(derived, 1_000),
                "a budget below the reserve is sent as it is");
    }

    @Test
    void everyWindowSourceIsClamped() {
        assertEquals(2_458, CompactionThreshold.completionBudget(
                CompactionThreshold.derive(null, 0, null, 8_192), Agent.DEFAULT_MAX_TOKENS),
                "a session window set from the ring (window_override)");
        assertEquals(12_000, CompactionThreshold.completionBudget(
                new Derived(28_000, Source.MODEL, 40_000), Agent.DEFAULT_MAX_TOKENS),
                "a published window");
        assertEquals(2_458, CompactionThreshold.completionBudget(
                new Derived(5_734, Source.WINDOW, 8_192), Agent.DEFAULT_MAX_TOKENS),
                "a loaded window");
    }

    @Test
    void aLargeWindowKeepsTheConfiguredBudget() {
        // 200,000 leaves a reserve of 60,000, above both budgets in the tree.
        Derived derived = CompactionThreshold.derive(null, 200_000);
        assertEquals(Agent.DEFAULT_MAX_TOKENS,
                CompactionThreshold.completionBudget(derived, Agent.DEFAULT_MAX_TOKENS));
        assertEquals(64_000, CompactionThreshold.completionBudget(
                CompactionThreshold.derive(null, 1_000_000), 64_000),
                "the clamp only takes budget away and never raises it to the reserve");
    }

    @Test
    void noKnownWindowAndAnOperatorThresholdLeaveTheBudgetAlone() {
        assertEquals(Agent.DEFAULT_MAX_TOKENS, CompactionThreshold.completionBudget(
                CompactionThreshold.derive(null, 0), Agent.DEFAULT_MAX_TOKENS),
                "fallback: nothing is known about the window");
        // Decided on card 488: under an explicit compactionThreshold the window
        // is the published one and never a loaded instance, and the operator may
        // set the threshold at or above it on purpose. The summarizer has made
        // the same call since card 263.
        assertEquals(Agent.DEFAULT_MAX_TOKENS, CompactionThreshold.completionBudget(
                new Derived(190_000, Source.OVERRIDE, 200_000), Agent.DEFAULT_MAX_TOKENS));
        assertEquals(Agent.DEFAULT_MAX_TOKENS, CompactionThreshold.completionBudget(
                new Derived(300_000, Source.OVERRIDE, 200_000), Agent.DEFAULT_MAX_TOKENS));
    }

    @Test
    void aReserveOfZeroOrLessIsSentAsTheFloor() {
        // A window of 1 has a threshold of 1 (the share never rounds to zero),
        // so the difference is 0.
        Derived one = CompactionThreshold.derive(null, 1);
        assertEquals(0, one.window() - one.tokens(), "premise: a difference of zero");
        assertEquals(CompactionThreshold.MIN_COMPLETION_TOKENS,
                CompactionThreshold.completionBudget(one, Agent.DEFAULT_MAX_TOKENS));
        assertEquals(CompactionThreshold.MIN_COMPLETION_TOKENS,
                CompactionThreshold.completionBudget(
                        new Derived(9_000, Source.WINDOW_OVERRIDE, 8_192), Agent.DEFAULT_MAX_TOKENS),
                "a negative difference");
        assertEquals(100, CompactionThreshold.completionBudget(one, 100),
                "the floor never raises a budget the operator set below it");
        assertEquals(512, CompactionThreshold.MIN_COMPLETION_TOKENS, "the floor's value");
    }

    @Test
    void theFloorDecidesUpToAWindowOf1703Tokens() {
        // The measurement the card names: the largest window whose reserve is
        // below the floor, found by walking every window up to 20,000.
        int largest = 0;
        for (int window = 1; window <= 20_000; window++) {
            Derived derived = CompactionThreshold.derive(null, window);
            if (window - derived.tokens() < CompactionThreshold.MIN_COMPLETION_TOKENS) {
                largest = window;
            }
        }
        assertEquals(1_703, largest);
    }

    @Test
    void theSummarizerReadsTheSameRule() {
        Derived[] cases = {
            CompactionThreshold.derive(null, 0),
            CompactionThreshold.derive(null, 1),
            CompactionThreshold.derive(null, 1_024),
            CompactionThreshold.derive(null, 8_192),
            CompactionThreshold.derive(null, 200_000),
            CompactionThreshold.derive(5_000, 0),
            new Derived(190_000, Source.OVERRIDE, 200_000),
            new Derived(7_000, Source.WINDOW_OVERRIDE, 10_000),
            new Derived(28_000, Source.MODEL, 40_000),
        };
        for (Derived derived : cases) {
            assertEquals(CompactionThreshold.completionBudget(derived, Agent.DEFAULT_MAX_TOKENS),
                    CompactionThreshold.summaryBudget(derived), derived.toString());
        }
    }
}
