package dev.spectroscope.core.goal;

import dev.spectroscope.core.loop.ContinuationLeash;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 504, criterion 2 (concept decision 11): a failing check continues the
 * run from the goal's own counter. Card 267 criterion 6 had the goal spend
 * card 266's budget; the owner's sentence replaced that premise, so this
 * class replaces the tests that pinned it ({@code ContinuationLeashGoalTest}).
 * The bound is the turn cap, which the loop holds, and the same failure twice
 * in a row.
 */
class GoalContinuationTest {

    @Test
    void aFailingCheckContinuesWithNoBudgetToSpend() {
        GoalContinuation counter = new GoalContinuation();
        counter.startRun();
        for (int i = 1; i <= 20; i++) {
            GoalContinuation.Decision decision = counter.consider("failure " + i, 50);
            assertEquals(GoalContinuation.CONTINUED, decision.decision());
            assertEquals(i, decision.continuation());
        }
        assertEquals(20, counter.continuations());
    }

    @Test
    void anUnchangedFailureIsTheNoProgressBrake() {
        GoalContinuation counter = new GoalContinuation();
        counter.startRun();
        assertEquals(GoalContinuation.CONTINUED, counter.consider("same", 10).decision());
        GoalContinuation.Decision stop = counter.consider("same", 10);
        assertEquals(GoalContinuation.NO_PROGRESS, stop.decision());
        assertEquals(1, stop.continuation(), "a stop names how many were spent");
    }

    @Test
    void theLineNamesTheTurnCapAsItsCeiling() {
        GoalContinuation counter = new GoalContinuation();
        counter.startRun();
        GoalContinuation.Decision decision = counter.consider("a", 15);
        assertEquals(15, decision.ceiling());
        assertTrue(decision.evidence().contains("turn cap of 15"), decision.evidence());
    }

    @Test
    void theSignatureSeparatesAMovedWorldFromAStandingOne() {
        // The exit code and the output are what the world says; the clean-call
        // count is what the model did. Only when neither moved is it the spin.
        String still = ContinuationLeash.checkSignature(1, "expected 0.2, got 0.18432", 0);
        assertEquals(still, ContinuationLeash.checkSignature(1, "expected 0.2, got 0.18432", 0));
        assertTrue(!still.equals(ContinuationLeash.checkSignature(1, "expected 0.2, got 0.19", 0)));
        assertTrue(!still.equals(ContinuationLeash.checkSignature(1, "expected 0.2, got 0.18432", 1)));
        assertTrue(!still.equals(ContinuationLeash.checkSignature(2, "expected 0.2, got 0.18432", 0)));
    }

    @Test
    void aFailureThatDiffersOnlyByItsElapsedTimeIsNotTheBrake() {
        // Fix round 2, stating the behaviour concept decision 11 chose: the
        // brake compares the output byte for byte, so a test runner that
        // prints its own duration never repeats, and the turn cap is the only
        // bound left. Normalising the output is an owner question (card 504).
        GoalContinuation counter = new GoalContinuation();
        counter.startRun();
        String first = ContinuationLeash.checkSignature(1, "Tests: 1 failed, 41 passed\nTime: 0.83 s", 0);
        String second = ContinuationLeash.checkSignature(1, "Tests: 1 failed, 41 passed\nTime: 0.91 s", 0);
        assertEquals(GoalContinuation.CONTINUED, counter.consider(first, 1000).decision());
        assertEquals(GoalContinuation.CONTINUED, counter.consider(second, 1000).decision());
        assertEquals(GoalContinuation.NO_PROGRESS, counter.consider(second, 1000).decision(),
                "the same bytes twice in a row still stop it");
    }

    @Test
    void aNewRunGetsAFreshCountAndAFreshMemory() {
        GoalContinuation counter = new GoalContinuation();
        counter.startRun();
        counter.consider("a", 10);
        counter.startRun();
        assertEquals(0, counter.continuations());
        assertEquals(GoalContinuation.CONTINUED, counter.consider("a", 10).decision());
    }
}
