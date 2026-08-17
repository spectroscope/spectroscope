package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 264: the plan ledger's first reader. A run that stopped with steps open
 * is not a finished run, and a run that never wrote a plan is not a finished run
 * either — it is a run nobody can grade. Both used to arrive on the wire as
 * {@code end_turn}, which is the one value that claims the model chose to stop
 * because it was done.
 *
 * <p>The table below is the whole rule, computed from a fabricated ledger with
 * no provider and no backend.</p>
 */
class PlanVerdictTest {

    private static RunEvent.Plan plan(String... statuses) {
        List<RunEvent.PlanStep> steps = new java.util.ArrayList<>();
        for (int i = 0; i < statuses.length; i++) {
            steps.add(new RunEvent.PlanStep("step " + (i + 1), statuses[i]));
        }
        return new RunEvent.Plan("main", List.copyOf(steps), 1000L);
    }

    // ── the three verdicts ─────────────────────────────────────────────────

    @Test
    void everyStepCompletedIsAFinishedPlan() {
        assertEquals(PlanVerdict.FINISHED, PlanVerdict.of(plan("completed", "completed")));
    }

    @Test
    void anyStepNotCompletedLeavesThePlanUnfinished() {
        assertEquals(PlanVerdict.UNFINISHED, PlanVerdict.of(plan("completed", "in_progress")));
        assertEquals(PlanVerdict.UNFINISHED, PlanVerdict.of(plan("completed", "pending")));
        assertEquals(PlanVerdict.UNFINISHED, PlanVerdict.of(plan("pending")));
    }

    @Test
    void noPlanAtAllIsUnknownAndNeverFinished() {
        // The house backend's common case (card 264, context): a model that
        // cannot call update_plan writes no ledger, and silence must not be
        // read as success.
        assertEquals(PlanVerdict.UNKNOWN, PlanVerdict.of(null));
        assertEquals(PlanVerdict.UNKNOWN, PlanVerdict.of(new RunEvent.Plan("main", List.of(), 1000L)));
    }

    /** A status the enum does not know is not "completed", so it counts as open —
     *  the tool rejects those values, and an IMPORTED file can still carry one. */
    @Test
    void anUnknownStatusCountsAsOpen() {
        assertEquals(PlanVerdict.UNFINISHED, PlanVerdict.of(plan("completed", "done")));
    }

    // ── the counts the footer says out loud ────────────────────────────────

    @Test
    void theOpenCountAndTheTotalComeFromTheLedger() {
        RunEvent.Plan six = plan("completed", "completed", "in_progress", "pending", "pending", "pending");
        assertEquals(4, PlanVerdict.openSteps(six));
        assertEquals(6, PlanVerdict.totalSteps(six));
    }

    @Test
    void anAbsentLedgerCountsNothing() {
        assertEquals(0, PlanVerdict.openSteps(null));
        assertEquals(0, PlanVerdict.totalSteps(null));
    }

    // ── the wire projection ───────────────────────────────────────────────

    @Test
    void onlyEndTurnIsDisplacedByTheVerdict() {
        // end_turn is the only stop reason that claims the run finished on its
        // own terms, so it is the only one the verdict may overwrite. Every
        // other value already says a limit or a failure intervened, and losing
        // that would trade one silence for another.
        assertEquals("unfinished", PlanVerdict.stopReasonFor("end_turn", PlanVerdict.UNFINISHED));
        assertEquals("max_turns", PlanVerdict.stopReasonFor("max_turns", PlanVerdict.UNFINISHED));
        assertEquals("max_tokens", PlanVerdict.stopReasonFor("max_tokens", PlanVerdict.UNFINISHED));
        assertEquals("aborted", PlanVerdict.stopReasonFor("aborted", PlanVerdict.UNFINISHED));
        assertEquals("error", PlanVerdict.stopReasonFor("error", PlanVerdict.UNFINISHED));
    }

    @Test
    void aFinishedOrUngradableRunKeepsTheStopReasonItAlwaysHad() {
        // Old files and old readers: nothing changes for either of these, which
        // is why a session recorded before this card replays byte-identically.
        assertEquals("end_turn", PlanVerdict.stopReasonFor("end_turn", PlanVerdict.FINISHED));
        assertEquals("end_turn", PlanVerdict.stopReasonFor("end_turn", PlanVerdict.UNKNOWN));
    }

    // ── the sentence every reader states (fix pass, verifier finding 1) ────

    /**
     * The verdict was a fact only inside an slf4j format string: deleting that
     * one line left the whole suite green, and a reader who wanted to know
     * which of the three a run reached had to re-derive it. The sentence is a
     * pure function now, and the three readers that say it out loud
     * ({@code Agent}'s exit log, the CLI's run-end line, the HTML export) all
     * call this.
     */
    @Test
    void theVerdictSaysWhichOfTheThreeItIsAndWithWhatCount() {
        assertEquals("unfinished (4 of 6 steps open)",
                PlanVerdict.report(plan("completed", "completed", "in_progress", "pending", "pending", "pending")));
        assertEquals("finished (all 2 steps completed)", PlanVerdict.report(plan("completed", "completed")));
        assertEquals("unknown (no plan on record)", PlanVerdict.report(null));
        assertEquals("unknown (no plan on record)",
                PlanVerdict.report(new RunEvent.Plan("main", List.of(), 1000L)));
    }

    /**
     * The half a reader appends to a line it already has — the CLI's run-end
     * line and the exported document's foot both put this behind the stop
     * reason, so the two faces cannot drift into two different sentences.
     */
    @Test
    void theDetailIsTheHalfAReaderAppendsToItsOwnLine() {
        assertEquals("4 of 6 steps open",
                PlanVerdict.detail(plan("completed", "completed", "in_progress", "pending", "pending", "pending")));
        assertEquals("all 2 steps completed", PlanVerdict.detail(plan("completed", "completed")));
        assertEquals("no plan on record", PlanVerdict.detail(null));
    }

    /** The same sentence from parts, for a reader that already counted. */
    @Test
    void theSentenceIsBuiltFromTheVerdictAndTheTwoCounts() {
        assertEquals("unfinished (1 of 3 steps open)", PlanVerdict.report(PlanVerdict.UNFINISHED, 1, 3));
        assertEquals("finished (all 3 steps completed)", PlanVerdict.report(PlanVerdict.FINISHED, 0, 3));
        assertEquals("unknown (no plan on record)", PlanVerdict.report(PlanVerdict.UNKNOWN, 0, 0));
    }

    @Test
    void everyVerdictHasAWireName() {
        assertEquals("finished", PlanVerdict.FINISHED.wireName());
        assertEquals("unfinished", PlanVerdict.UNFINISHED.wireName());
        assertEquals("unknown", PlanVerdict.UNKNOWN.wireName());
        assertEquals("unfinished", PlanVerdict.UNFINISHED_STOP_REASON);
    }
}
