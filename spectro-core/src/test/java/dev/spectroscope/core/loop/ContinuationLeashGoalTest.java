package dev.spectroscope.core.loop;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 267 criterion 6: a failing check buys its continuation from card 266's
 * budget, and from no second budget of its own.
 *
 * <p>Two budgets would be the ceiling card 266's own javadoc refuses — "a
 * ceiling that is the product of two numbers, only one of which is visible, is
 * not a ceiling anybody can reason about". So the goal reaches into the same
 * counter, the same spin guard and the same three decisions.</p>
 */
class ContinuationLeashGoalTest {

    @Test
    void aFailingCheckSpendsTheSameBudgetAsAnOpenPlan() {
        ContinuationLeash leash = new ContinuationLeash(2);
        leash.startRun();
        assertEquals(ContinuationLeash.Decision.CONTINUED,
                leash.considerFailedCheck("a", "go on").orElseThrow().decision());
        assertEquals(ContinuationLeash.Decision.CONTINUED,
                leash.considerFailedCheck("b", "go on").orElseThrow().decision());
        assertEquals(ContinuationLeash.Decision.BUDGET_EXHAUSTED,
                leash.considerFailedCheck("c", "go on").orElseThrow().decision());
        assertEquals(2, leash.continuations());
    }

    @Test
    void anUnchangedCheckIsNotABuyableContinuation() {
        ContinuationLeash leash = new ContinuationLeash(5);
        leash.startRun();
        assertEquals(ContinuationLeash.Decision.CONTINUED,
                leash.considerFailedCheck("same", "go on").orElseThrow().decision());
        assertEquals(ContinuationLeash.Decision.NO_PROGRESS,
                leash.considerFailedCheck("same", "go on").orElseThrow().decision());
    }

    @Test
    void theHarnessHandsTheModelTheChecksOwnWordsAndNotItsOwn() {
        ContinuationLeash leash = new ContinuationLeash(1);
        leash.startRun();
        assertEquals("expected 0.2, got 0.18432",
                leash.considerFailedCheck("a", "expected 0.2, got 0.18432")
                        .orElseThrow().message());
    }

    @Test
    void aLeashTurnedOffSaysNothingAtAll() {
        ContinuationLeash leash = new ContinuationLeash(0);
        leash.startRun();
        assertTrue(leash.considerFailedCheck("a", "go on").isEmpty());
    }

    @Test
    void theSignatureSeparatesAMovedWorldFromAStandingOne() {
        // Both halves are load-bearing and both were argued on card 266. The
        // exit code and the output are what the world says; the clean-call count
        // is what the model did. A model that did nothing AND a check that says
        // the same thing is the spin — anything else is progress the leash must
        // not refuse.
        String still = ContinuationLeash.checkSignature(1, "expected 0.2, got 0.18432", 0);
        assertEquals(still, ContinuationLeash.checkSignature(1, "expected 0.2, got 0.18432", 0));
        assertTrue(!still.equals(ContinuationLeash.checkSignature(1, "expected 0.2, got 0.19", 0)));
        assertTrue(!still.equals(ContinuationLeash.checkSignature(1, "expected 0.2, got 0.18432",
                1)));
        assertTrue(!still.equals(ContinuationLeash.checkSignature(2, "expected 0.2, got 0.18432",
                0)));
    }

    @Test
    void theTwoContinuationReasonsShareOneCounterAndOneMemory() {
        // A run whose plan is open AND whose check fails must not be able to
        // spend the budget twice.
        ContinuationLeash leash = new ContinuationLeash(1);
        leash.startRun();
        assertEquals(ContinuationLeash.Decision.CONTINUED,
                leash.considerFailedCheck("a", "go on").orElseThrow().decision());
        assertEquals(ContinuationLeash.Decision.BUDGET_EXHAUSTED,
                leash.considerFailedCheck("b", "go on").orElseThrow().decision());
    }

    @Test
    void aNewRunGetsAFreshBudgetAndAFreshMemory() {
        ContinuationLeash leash = new ContinuationLeash(1);
        leash.startRun();
        leash.considerFailedCheck("a", "go on");
        leash.startRun();
        assertEquals(0, leash.continuations());
        assertEquals(ContinuationLeash.Decision.CONTINUED,
                leash.considerFailedCheck("a", "go on").orElseThrow().decision());
    }
}
