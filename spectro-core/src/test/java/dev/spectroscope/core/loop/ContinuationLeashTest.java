package dev.spectroscope.core.loop;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The leash on its own (card 266) — the arithmetic and the wording, without the
 * loop around it. What the loop then does with the verdict is
 * {@code AgentContinuationTest}'s business.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class ContinuationLeashTest {

    private static RunEvent.Plan plan(String... statuses) {
        List<RunEvent.PlanStep> steps = new ArrayList<>();
        for (int i = 0; i < statuses.length; i++) {
            steps.add(new RunEvent.PlanStep("step " + (i + 1), statuses[i]));
        }
        return new RunEvent.Plan("main", steps, 1L);
    }

    /** The signature of a run that has done nothing at all with that plan. */
    private static String idle(RunEvent.Plan plan) {
        return ContinuationLeash.signature(plan, 0);
    }

    // ── the bound ──────────────────────────────────────────────────────────

    @Test
    void aBudgetOfZeroIsTheOffSwitch() {
        ContinuationLeash leash = new ContinuationLeash(0);
        leash.startRun();
        assertTrue(leash.consider(plan("pending"), idle(plan("pending"))).isEmpty(),
                "zero means the leash does not apply at all — not even a refusal line,"
                        + " because a face that was never asked to continue has nothing to say");
    }

    @Test
    void theBudgetIsSpentOneContinuationAtATimeAndThenRefuses() {
        ContinuationLeash leash = new ContinuationLeash(2);
        leash.startRun();

        ContinuationLeash.Verdict first = leash.consider(plan("pending"), "run 1").orElseThrow();
        assertEquals(ContinuationLeash.Decision.CONTINUED, first.decision());
        assertEquals(1, first.continuation());
        assertEquals(2, first.budget());

        ContinuationLeash.Verdict second = leash.consider(plan("pending"), "run 2").orElseThrow();
        assertEquals(ContinuationLeash.Decision.CONTINUED, second.decision());
        assertEquals(2, second.continuation());

        ContinuationLeash.Verdict third = leash.consider(plan("pending"), "run 3").orElseThrow();
        assertEquals(ContinuationLeash.Decision.BUDGET_EXHAUSTED, third.decision(),
                "the bound is real: the third stop is not continued, and it says so");
        assertNull(third.message(), "a refusal has nothing to tell the model");
        assertEquals(2, leash.continuations());
    }

    @Test
    void theBudgetIsSettableAtRuntimeWithoutARebuild() {
        ContinuationLeash leash = new ContinuationLeash(1);
        leash.setBudget(0);
        leash.startRun();
        assertTrue(leash.consider(plan("pending"), "run 1").isEmpty(),
                "an operator turning it off mid-session is the whole of criterion 7");

        leash.setBudget(2);
        leash.startRun();
        assertEquals(ContinuationLeash.Decision.CONTINUED,
                leash.consider(plan("pending"), "run 1").orElseThrow().decision());
    }

    @Test
    void aFreshRunGetsTheWholeBudgetBack() {
        // One leash belongs to one agent and one agent serves every prompt of a
        // browser session — the exact shape that made card 262 add startRun().
        ContinuationLeash leash = new ContinuationLeash(1);
        leash.startRun();
        assertEquals(ContinuationLeash.Decision.CONTINUED,
                leash.consider(plan("pending"), "a").orElseThrow().decision());
        assertEquals(ContinuationLeash.Decision.BUDGET_EXHAUSTED,
                leash.consider(plan("pending"), "b").orElseThrow().decision());

        leash.startRun();
        assertEquals(0, leash.continuations(), "the count is a sentence about ONE run");
        assertEquals(ContinuationLeash.Decision.CONTINUED,
                leash.consider(plan("pending"), "c").orElseThrow().decision());
    }

    // ── the verdict it listens to is card 264's, not a second one ──────────

    @Test
    void aFinishedPlanIsNeverContinued() {
        ContinuationLeash leash = new ContinuationLeash(3);
        leash.startRun();
        assertTrue(leash.consider(plan("completed", "completed"), "x").isEmpty(),
                "FINISHED is card 264's word for it, and this card does not invent a second");
    }

    @Test
    void aRunWithNoLedgerAtAllIsNeverContinued() {
        ContinuationLeash leash = new ContinuationLeash(3);
        leash.startRun();
        assertTrue(leash.consider(null, "x").isEmpty(),
                "UNKNOWN is not UNFINISHED: nobody can grade a run that never said what it"
                        + " was doing, and a harness that continues one is guessing");
        assertTrue(leash.consider(new RunEvent.Plan("main", List.of(), 1L), "x").isEmpty());
    }

    // ── it cannot spin (criterion 5) ───────────────────────────────────────

    @Test
    void aSecondStopWithNothingChangedIsRefused() {
        ContinuationLeash leash = new ContinuationLeash(5);
        leash.startRun();
        RunEvent.Plan stuck = plan("pending", "pending");

        assertEquals(ContinuationLeash.Decision.CONTINUED,
                leash.consider(stuck, idle(stuck)).orElseThrow().decision());
        ContinuationLeash.Verdict again = leash.consider(stuck, idle(stuck)).orElseThrow();
        assertEquals(ContinuationLeash.Decision.NO_PROGRESS, again.decision(),
                "same plan, nothing done — a third turn would be the spin card 262 measured");
        assertEquals(1, again.continuation(), "it says how far it had got");
        assertEquals(1, leash.continuations(), "a refusal does not spend budget");
    }

    @Test
    void aPlanThatAdvancedEarnsAnotherContinuation() {
        ContinuationLeash leash = new ContinuationLeash(5);
        leash.startRun();
        RunEvent.Plan before = plan("pending", "pending");
        RunEvent.Plan after = plan("completed", "pending");

        assertEquals(ContinuationLeash.Decision.CONTINUED,
                leash.consider(before, idle(before)).orElseThrow().decision());
        assertEquals(ContinuationLeash.Decision.CONTINUED,
                leash.consider(after, idle(after)).orElseThrow().decision());
    }

    @Test
    void workDoneWithoutTouchingThePlanStillCountsAsProgress() {
        ContinuationLeash leash = new ContinuationLeash(5);
        leash.startRun();
        RunEvent.Plan same = plan("pending", "pending");

        assertEquals(ContinuationLeash.Decision.CONTINUED,
                leash.consider(same, ContinuationLeash.signature(same, 0)).orElseThrow().decision());
        assertEquals(ContinuationLeash.Decision.CONTINUED,
                leash.consider(same, ContinuationLeash.signature(same, 2)).orElseThrow().decision(),
                "two clean tool calls happened; a model that forgets to tick its own boxes"
                        + " is not a model that is stuck");
    }

    @Test
    void theSignatureIsTheHousesOneDefinitionOfAPlanThatDidNotMove() {
        // Shared with card 262's stalled-plan detector through
        // PlanVerdict.planSignature. Two spellings of "unchanged" would mean a
        // run the guard calls stalled and the leash calls progress, in the same
        // turn, off the same ledger.
        assertEquals(ContinuationLeash.signature(plan("pending"), 0),
                ContinuationLeash.signature(plan("pending"), 0));
        assertFalse(ContinuationLeash.signature(plan("pending"), 0)
                        .equals(ContinuationLeash.signature(plan("in_progress"), 0)),
                "a status change is a plan that moved");
        assertFalse(ContinuationLeash.signature(plan("pending"), 0)
                        .equals(ContinuationLeash.signature(plan("pending", "pending"), 0)),
                "a step added is a plan that moved");
    }

    // ── what the model is told (criterion 1) ───────────────────────────────

    @Test
    void theContinuationNamesTheOpenStepsInThePlansOwnWords() {
        ContinuationLeash leash = new ContinuationLeash(3);
        leash.startRun();
        RunEvent.Plan ledger = new RunEvent.Plan("main", List.of(
                new RunEvent.PlanStep("read the reference", "completed"),
                new RunEvent.PlanStep("wire the exporter", "in_progress"),
                new RunEvent.PlanStep("add the test", "pending")), 1L);

        String message = leash.consider(ledger, idle(ledger)).orElseThrow().message();

        assertNotNull(message);
        assertTrue(message.contains("wire the exporter"), message);
        assertTrue(message.contains("add the test"), message);
        assertTrue(message.contains("in_progress"), message);
        assertFalse(message.contains("read the reference"),
                "a step that is done is not something still open, and naming it invites"
                        + " the model to redo it: " + message);
        assertTrue(message.contains("2 of 3"), message);
    }

    @Test
    void theSentenceSaysWhichContinuationOfHowMany() {
        // Criterion 3 quotes the wording it wants a reader to be able to count
        // from: "continued: 4 of 6 steps open, continuation 2 of 3".
        ContinuationLeash leash = new ContinuationLeash(3);
        leash.startRun();
        RunEvent.Plan ledger = plan("completed", "completed", "pending", "pending",
                "pending", "pending");

        leash.consider(ledger, "a");
        ContinuationLeash.Verdict second = leash.consider(ledger, "b").orElseThrow();

        assertEquals("continued: 4 of 6 steps open, continuation 2 of 3", second.evidence());
    }

    @Test
    void aRefusalSaysWhyItRefused() {
        ContinuationLeash leash = new ContinuationLeash(1);
        leash.startRun();
        RunEvent.Plan ledger = plan("pending", "pending");

        leash.consider(ledger, "a");
        String exhausted = leash.consider(ledger, "b").orElseThrow().evidence();
        assertTrue(exhausted.contains("budget"), exhausted);
        assertTrue(exhausted.contains("2 of 2 steps open"), exhausted);

        ContinuationLeash spinner = new ContinuationLeash(5);
        spinner.startRun();
        spinner.consider(ledger, "same");
        String stuck = spinner.consider(ledger, "same").orElseThrow().evidence();
        assertTrue(stuck.contains("nothing"), stuck);
    }

    @Test
    void aVeryLongPlanDoesNotTurnTheContinuationIntoAWallOfText() {
        // The message is spent from the same context pool as the work
        // (ORCHESTRATION.md A1: "every added paragraph is spent from the same
        // pool"). A 200-step plan must not eat the window it is trying to save.
        ContinuationLeash leash = new ContinuationLeash(3);
        leash.startRun();
        List<RunEvent.PlanStep> many = new ArrayList<>();
        for (int i = 0; i < 200; i++) {
            many.add(new RunEvent.PlanStep("step number " + i + " of a very long list", "pending"));
        }
        Optional<ContinuationLeash.Verdict> verdict =
                leash.consider(new RunEvent.Plan("main", many, 1L), "a");

        assertTrue(verdict.orElseThrow().message().length() < 2_000,
                "the continuation is a nudge, not a second system prompt");
        assertTrue(verdict.orElseThrow().evidence().contains("200 of 200"),
                "the COUNT is never clipped, only the list");
    }
}
