package dev.spectroscope.core.goal;

import dev.spectroscope.core.tools.ToolOutput;

/**
 * What the check said, and what produced it (card 267, criterion 4).
 *
 * <p>A verdict is never a claim. Every field here exists so that nobody has to
 * take the word "done" on faith: the command that ran, the exit code it
 * returned, the output it printed, and — for the opt-in evaluator — the name of
 * the model that judged. A verdict without its evidence is the thing
 * {@code .spectro/skills/verification/SKILL.md} calls banned: "Never claim a
 * state you have not observed in THIS run".</p>
 *
 * @param outcome    met, failed, or untested
 * @param command    the command that ran, or null when the judge was a model
 * @param exitCode   the exit code, or null when nothing ran to completion
 * @param output     what the check printed, clipped; never null (empty at worst)
 * @param durationMs how long the check itself took — the non-functional
 *                   criterion's split, kept apart from the model's work the same
 *                   way card 111 kept the gate's wait out of a tool's duration
 * @param gateWaitMs how long the check waited on a person at the permission
 *                   gate, or null when it never parked
 * @param judge      the evaluator's model name, or null for a command check
 * @param evidence   the same verdict as one English sentence, for the surfaces
 *                   with no dictionary — and written in a register the
 *                   verification skill permits: no "should", no "probably", no
 *                   "looks correct"
 */
public record GoalVerdict(Outcome outcome, String command, Integer exitCode, String output,
                          long durationMs, Long gateWaitMs, String judge, String evidence) {

    /** {@code run_end.stopReason} for a run whose check exited 0. A VALUE on the
     *  existing field, never a new field — the rule cards 262, 264 and 266
     *  followed. */
    public static final String MET_STOP_REASON = "goal_met";

    /** {@code run_end.stopReason} for a run whose check ran and did not pass,
     *  with no continuation left to spend on it. */
    public static final String UNMET_STOP_REASON = "goal_unmet";

    /** {@code run_end.stopReason} for a goal whose check could not be run at
     *  all. Deliberately its own value and never {@link #MET_STOP_REASON}:
     *  "nobody checked" is a different fact from "it passed", and collapsing
     *  them is the one failure criterion 3 names by name. */
    public static final String UNTESTED_STOP_REASON = "goal_untested";

    /** How much of the check's output is kept. Enough to see a failing
     *  assertion, small enough that a chatty test suite cannot eat the window
     *  the goal is trying to protect. */
    public static final int MAX_OUTPUT_CHARS = 4_000;

    /** The three ways a check can come back. */
    public enum Outcome {
        /** The check ran and passed. This is the ONLY value that ends a run
         *  as done. */
        MET("met"),
        /** The check ran and did not pass. */
        FAILED("failed"),
        /** The check could not be run — none was stated, the gate refused it,
         *  it could not start, or it never finished. Never met. */
        UNTESTED("untested");

        private final String wireName;

        Outcome(String wireName) {
            this.wireName = wireName;
        }

        /** The stable snake_case name that travels on the wire.
         *  @return {@code met}, {@code failed} or {@code untested} */
        public String wireName() {
            return wireName;
        }

        /** The {@code run_end.stopReason} this outcome writes.
         *  @return one of the three stop-reason constants on this record */
        public String stopReason() {
            return switch (this) {
                case MET -> MET_STOP_REASON;
                case FAILED -> UNMET_STOP_REASON;
                case UNTESTED -> UNTESTED_STOP_REASON;
            };
        }
    }

    /** Clips a check's output to {@link #MAX_OUTPUT_CHARS}, keeping the TAIL —
     *  a failing suite says what failed at the end, and the head is the part a
     *  reader can afford to lose.
     *
     *  <p>One implementation, in {@link ToolOutput#clipTail}, because the
     *  command path does its cut in the DRAIN and this one cuts a string that
     *  is already in hand: two copies of "which end survives" is exactly the
     *  drift the review found — this method documented the tail while the
     *  command check kept the head.</p>
     *
     *  @param text the raw output; null becomes ""
     *  @return the clipped text, never null */
    public static String clip(String text) {
        return text == null ? "" : ToolOutput.clipTail(text, MAX_OUTPUT_CHARS);
    }

    /** The message the harness hands the model when a failing check buys a
     *  continuation — the check's own output as the guidance, which is
     *  criterion 3's wording.
     *
     *  @return the continuation text, naming the command and what it printed */
    public String asGuidance() {
        return "The goal's check ran and did not pass.\n\n    " + command
                + "\n\nexit code " + exitCode + ", and it printed:\n\n"
                + output
                + "\n\nCarry on from what that output actually says. The same check runs again"
                + " when you stop.";
    }
}
