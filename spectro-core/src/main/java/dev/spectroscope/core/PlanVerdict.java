package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent;

/**
 * What the run's own plan ledger says about the run that just ended — the first
 * reader the ledger ever had (card 264).
 *
 * <p>The plan was write-only: {@code update_plan} wrote a {@link RunEvent.Plan}
 * onto the wire, the Plan panel drew it, and nothing on the loop's exit path
 * ever looked at it again. So a run that stopped with four of six steps open
 * ended exactly like a run that finished all six — {@code end_turn}, the one
 * stop reason that claims the model stopped because it was done — and every
 * surface downstream reported a clean finish.</p>
 *
 * <p>Three verdicts, computed from state the loop already holds:</p>
 * <ul>
 *   <li>{@link #FINISHED} — a ledger exists and every step is {@code completed}.</li>
 *   <li>{@link #UNFINISHED} — a ledger exists and at least one step is not.</li>
 *   <li>{@link #UNKNOWN} — no ledger was ever written. On the house backend
 *       (a model whose profile says {@code nativeTools:false} is handed no tool
 *       belt at all, {@code Agent.java:292-296}) this is the common case, and
 *       it is deliberately NOT the same answer as "finished": nobody can grade
 *       a run that never said what it was doing.</li>
 * </ul>
 *
 * <p>The verdict does not guess WHY a run stopped. "The model gave up" and "the
 * model thought it was done" are the same bytes on this wire, and this class
 * refuses to invent the difference.</p>
 */
public enum PlanVerdict {

    /** Every step of the last plan is {@code completed}. */
    FINISHED("finished"),
    /** At least one step of the last plan is still open. */
    UNFINISHED("unfinished"),
    /** No plan was ever written, so the run cannot be graded either way. */
    UNKNOWN("unknown");

    /**
     * The one new value this card puts on {@code run_end.stopReason}, beside
     * {@code end_turn}, {@code max_tokens}, {@code tool_use}, {@code aborted},
     * {@code max_turns} and {@code error}.
     *
     * <p>A value and not a field: {@code RunEnd} keeps the exact three keys it
     * has always had, so a line written today is shape-identical to one written
     * by v0.1.0 and an older reader survives it through
     * {@code @JsonIgnoreProperties(ignoreUnknown = true)} — see
     * {@code RunEndVerdictAdditivityTest}. Old readers that switch on the value
     * fall through to their "not a clean finish" branch, which is the honest
     * default; the ones that had to change are named in card 264.</p>
     */
    public static final String UNFINISHED_STOP_REASON = "unfinished";

    /** The canonical wire spelling of the {@code completed} step status. */
    private static final String COMPLETED = "completed";

    private final String wireName;

    PlanVerdict(String wireName) {
        this.wireName = wireName;
    }

    /** The verdict's stable lowercase name — for logs and for anything that reports it.
     *  @return {@code finished}, {@code unfinished} or {@code unknown} */
    public String wireName() {
        return wireName;
    }

    /**
     * Grades the last plan a run wrote.
     *
     * <p>A status the tool would have rejected ({@code UpdatePlanTool.java:25}
     * enforces the three canonical values) can still arrive from an imported
     * file, and anything that is not {@code completed} counts as open — the
     * safe direction, because the failure this card fixes is a run being called
     * done when it was not.</p>
     *
     * @param plan the latest {@code plan} event of the run, or null when none was written
     * @return the verdict; {@link #UNKNOWN} for a missing or empty ledger
     */
    public static PlanVerdict of(RunEvent.Plan plan) {
        if (plan == null || plan.steps() == null || plan.steps().isEmpty()) {
            return UNKNOWN;
        }
        return openSteps(plan) == 0 ? FINISHED : UNFINISHED;
    }

    /**
     * How many steps are still open — the number the footer says out loud.
     *
     * @param plan the latest plan event, or null
     * @return the count of steps whose status is not {@code completed}; 0 without a ledger
     */
    public static int openSteps(RunEvent.Plan plan) {
        if (plan == null || plan.steps() == null) {
            return 0;
        }
        return (int) plan.steps().stream()
                .filter(step -> !COMPLETED.equals(step.status()))
                .count();
    }

    /**
     * How many steps the plan has at all — the denominator beside the open count.
     *
     * @param plan the latest plan event, or null
     * @return the step count; 0 without a ledger
     */
    public static int totalSteps(RunEvent.Plan plan) {
        return plan == null || plan.steps() == null ? 0 : plan.steps().size();
    }

    /**
     * Projects the verdict onto the stop reason the run is about to record.
     *
     * <p><b>Only {@code end_turn} is displaced.</b> It is the single value that
     * asserts the run finished on its own terms, so it is the only one that can
     * be a lie about an abandoned plan. {@code max_tokens}, {@code max_turns},
     * {@code aborted} and {@code error} all already say that something else
     * ended the run, and overwriting them would trade this card's silence for a
     * new one — the operator would lose the brake, the cap or the failure and
     * gain nothing the file does not already show. Whether a braked run still
     * counts as completed for the ladder is the owner's open call on card 264
     * and is deliberately not answered here.</p>
     *
     * @param stopReason the wire name the exit would have written
     * @param verdict    what the ledger says about the same run
     * @return the stop reason to record — {@link #UNFINISHED_STOP_REASON} only
     *         for an abandoned plan at a voluntary exit, otherwise unchanged
     */
    public static String stopReasonFor(String stopReason, PlanVerdict verdict) {
        return verdict == UNFINISHED && "end_turn".equals(stopReason)
                ? UNFINISHED_STOP_REASON : stopReason;
    }
}
