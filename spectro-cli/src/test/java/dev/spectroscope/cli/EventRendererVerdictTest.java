package dev.spectroscope.cli;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.permission.Allowlist;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 264, fix pass: the terminal is the face where {@code update_plan} really
 * is on the belt ({@code SpectroCli:466}), and its run-end line used to print
 * the stop reason alone — so a run that never wrote a plan and a run that closed
 * every step both ended as {@code ◆ end_turn} and neither could be told from the
 * other. The verdict is now stated where the operator is looking, from the
 * ledger the renderer already prints.
 *
 * <p>Fed with a fabricated event sequence: no provider, no backend, no tool.</p>
 */
class EventRendererVerdictTest {

    private static final String MAIN = "main";

    private static RunEvent.Plan plan(String... statuses) {
        List<RunEvent.PlanStep> steps = new java.util.ArrayList<>();
        for (int i = 0; i < statuses.length; i++) {
            steps.add(new RunEvent.PlanStep("step " + (i + 1), statuses[i]));
        }
        return new RunEvent.Plan(MAIN, List.copyOf(steps), 1000L);
    }

    /** Renders the given events through the real renderer and returns stdout. */
    private static String rendered(RunEvent... events) {
        PrintStream original = System.out;
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        System.setOut(new PrintStream(captured, true, StandardCharsets.UTF_8));
        try {
            Ansi ansi = Ansi.forced(false); // plain text, and the spinner never draws
            EventRenderer renderer = new EventRenderer(ansi, new Spinner(ansi), MAIN,
                    () -> Allowlist.fromEntries(List.of()));
            for (RunEvent event : events) {
                renderer.render(event);
            }
        } finally {
            System.setOut(original);
        }
        return captured.toString(StandardCharsets.UTF_8);
    }

    @Test
    void theRunEndLineNamesWhatTheRunLeftOpen() {
        String out = rendered(plan("completed", "pending"),
                new RunEvent.RunEnd("run-1", "unfinished", 2000L));

        assertTrue(out.contains("◆ unfinished · 1 of 2 steps open"),
                "the count is the point — 'unfinished' alone does not say how much. Got: " + out);
    }

    @Test
    void aRunThatNeverWroteAPlanSaysSoInsteadOfLookingClean() {
        // The house backend's normal case: end_turn on the wire, because the
        // absence of a ledger is the fact and no fifth value was invented for
        // it. The terminal states the fact instead of implying a finish.
        String out = rendered(new RunEvent.RunEnd("run-1", "end_turn", 2000L));

        assertTrue(out.contains("◆ end_turn · no plan on record"), "got: " + out);
    }

    /**
     * The quiet side, and it is deliberate: {@code end_turn} with every step
     * closed is the one case where the stop reason and the ledger say the same
     * thing, so the line stays exactly what it has always been. Same rule as the
     * footer's "ready" — a reader only speaks up where the value would mislead.
     */
    @Test
    void aFinishedPlanAddsNothingBecauseTheStopReasonAlreadySaysIt() {
        String out = rendered(plan("completed", "completed"),
                new RunEvent.RunEnd("run-1", "end_turn", 2000L));

        assertTrue(out.contains("◆ end_turn · run "), "got: " + out);
        assertFalse(out.contains("steps open"), "nothing was left open");
        assertFalse(out.contains("no plan on record"), "there was a plan, and it was finished");
    }

    /**
     * When the wire and this ledger disagree, the wire wins and the line stays
     * quiet: a plan left over from before {@code /clear} must never print a
     * count next to a verdict the loop computed from a ledger it no longer has.
     * A second opinion beside the verdict is the app contradicting itself.
     */
    @Test
    void aLedgerThatContradictsTheWireIsNotPrinted() {
        String out = rendered(plan("completed", "pending"),
                new RunEvent.RunEnd("run-1", "end_turn", 2000L));

        assertTrue(out.contains("◆ end_turn · run "), "got: " + out);
        assertFalse(out.contains("steps open"), "the loop graded this run end_turn; the line defers");
        assertFalse(out.contains("no plan on record"), "there IS a plan here, just not this run's");
    }

    /** And the ledger is dropped when the REPL starts over, so nothing stale
     *  survives a {@code /clear}. */
    @Test
    void aClearedSessionStartsWithoutALedger() {
        PrintStream original = System.out;
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        System.setOut(new PrintStream(captured, true, StandardCharsets.UTF_8));
        try {
            Ansi ansi = Ansi.forced(false);
            EventRenderer renderer = new EventRenderer(ansi, new Spinner(ansi), MAIN,
                    () -> Allowlist.fromEntries(List.of()));
            renderer.render(plan("completed", "completed"));
            renderer.forgetPlan();
            renderer.render(new RunEvent.RunEnd("run-2", "end_turn", 2000L));
        } finally {
            System.setOut(original);
        }
        assertTrue(captured.toString(StandardCharsets.UTF_8).contains("◆ end_turn · no plan on record"),
                "after /clear the new agent has no ledger, and the line says so");
    }

    /** The ledger is latest-wins here for the same reason it is in the loop and
     *  in the reducer: the last plan the model wrote is the plan. */
    @Test
    void theLastPlanWinsWhenTheModelRewritesIt() {
        String out = rendered(plan("completed", "completed"),
                plan("completed", "pending"),
                new RunEvent.RunEnd("run-1", "unfinished", 2000L));

        assertTrue(out.contains("◆ unfinished · 1 of 2 steps open"), "got: " + out);
    }
}
