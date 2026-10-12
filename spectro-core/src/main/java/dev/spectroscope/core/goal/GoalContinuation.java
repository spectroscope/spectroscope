package dev.spectroscope.core.goal;

/**
 * The goal's own counter (card 504, criterion 2, concept decision 11).
 *
 * <p>A failed goal check at an {@code end_turn} below the turn cap starts the
 * next turn with the check's output. It does not spend the leash's
 * {@code continuationBudget}: the owner's sentence is that max turns is not
 * raised and an early stop is restarted. Two things bound it. The loop's
 * {@code turn < maxTurns} guard stays the ceiling, and the same failure
 * fingerprint twice in a row ends the run ({@code no_progress}). The
 * fingerprint is {@code ContinuationLeash.checkSignature}: the check's exit
 * code and output plus the count of clean tool calls.</p>
 *
 * <p>The brake is narrow (fix round 2 of card 504 says so instead of hiding
 * it): it fires only when the output is byte for byte the same and no tool
 * call came back clean in between. A check that prints its own duration
 * never repeats, so such a goal runs until it passes or the turn cap ends
 * the run, 1000 turns by default ({@code Agent.DEFAULT_MAX_TURNS}).</p>
 *
 * <p>One instance belongs to one run of one agent; {@link #startRun()} resets
 * it.</p>
 */
public final class GoalContinuation {

    /** {@code continuation.decision} for a turn the goal counter started. */
    public static final String CONTINUED = "goal_continued";

    /** {@code continuation.decision} when the same failure came back unchanged. */
    public static final String NO_PROGRESS = "no_progress";

    /**
     * One decision.
     *
     * @param decision     {@link #CONTINUED} or {@link #NO_PROGRESS}
     * @param continuation the count of goal continuations of this run, 1-based
     *                     for a continuation, the count spent so far for a stop
     * @param ceiling      the run's turn cap, the bound the line names
     * @param evidence     one sentence for the operator
     */
    public record Decision(String decision, int continuation, int ceiling, String evidence) {

        /** @return true when the run goes on */
        public boolean continues() {
            return CONTINUED.equals(decision);
        }
    }

    private int spent;
    private String lastSignature;

    /** Forgets the last run. */
    public void startRun() {
        spent = 0;
        lastSignature = null;
    }

    /** @return the goal continuations this run has started */
    public int continuations() {
        return spent;
    }

    /**
     * Decides what a failed check at an {@code end_turn} below the cap does.
     *
     * @param signature the failure's fingerprint
     * @param maxTurns  the run's turn cap, named on the line
     * @return the decision
     */
    public Decision consider(String signature, int maxTurns) {
        if (signature != null && signature.equals(lastSignature)) {
            return new Decision(NO_PROGRESS, spent, maxTurns,
                    "not continued: the goal's check failed the same way as before, and nothing the"
                            + " model did moved it");
        }
        spent++;
        lastSignature = signature;
        return new Decision(CONTINUED, spent, maxTurns,
                "continued: the goal's check did not pass, goal continuation " + spent
                        + "; the turn cap of " + maxTurns + " stays the ceiling");
    }
}
