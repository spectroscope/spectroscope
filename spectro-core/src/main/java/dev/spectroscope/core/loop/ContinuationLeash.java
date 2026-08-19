package dev.spectroscope.core.loop;

import dev.spectroscope.core.PlanVerdict;
import dev.spectroscope.core.events.RunEvent;

import java.util.List;
import java.util.Optional;

/**
 * The harness keeps an unfinished run going, on a leash (card 266).
 *
 * <p>Card 264 taught the loop to read its own plan at the exit and say
 * {@code unfinished} instead of {@code end_turn}. This is what the harness then
 * DOES about it: it starts another turn, with a message it wrote itself, and it
 * counts.</p>
 *
 * <p><b>Why the harness authors the continuation and not the model.</b> Three
 * placements were weighed on the card and two lose on the same backend.
 * A system-prompt instruction ("do not stop until the plan is complete") fails
 * silently here — {@code konzept/ORCHESTRATION.md} §A1 already ran that
 * experiment: "All seven verbs stood in front of the model in 4,147 tokens of
 * schema, under a 30-skill catalogue inside a 1,985-token system prompt, and the
 * model's own reasoning shows it choosing 'or just plan myself' anyway", and
 * "the failure mode is silent. A prompt that does not work looks exactly like a
 * model that cannot comply". A tool the model calls to ask for its own next turn
 * is worse: a model whose profile says it cannot call tools is handed an empty
 * belt, so the mechanic would be missing exactly where it is needed, and it
 * hands the brake to the party that is failing. So the mechanic sits in the
 * loop, at the terminal exit, beside the two per-turn hooks already there —
 * and NOT beside the loop, which is the second control flow
 * {@code ORCHESTRATION.md} §A2 refuses ("two places a run can hang, two places a
 * cancel must reach, two places MAX_TURNS means something").</p>
 *
 * <p><b>Three ways this ends, and each one is a line on the wire.</b> A
 * continuation that nobody can count afterwards is the same silence card 264 was
 * cut to end, so a refusal is recorded exactly as loudly as a restart.</p>
 *
 * <p><b>It cannot spin.</b> A continuation aimed at a wedged model manufactures
 * precisely the loop card 262 guards against, so the two mechanics share one
 * progress signal rather than growing two. Progress is: the plan advanced —
 * {@link PlanVerdict#planSignature} is the house's one definition of that, used
 * by card 262's stalled-plan detector too — or at least one tool call ran and
 * came back without an error. A call the guard refused never ran and a call that
 * errored moved nothing, so neither buys another turn.</p>
 *
 * <p>Not thread-safe beyond the budget, and it does not need to be: one leash
 * belongs to one agent's loop, which is sequential by construction. The budget
 * is volatile because an operator may change it from another thread between
 * prompts (criterion 7).</p>
 */
public final class ContinuationLeash {

    /**
     * The shipped budget: three continuations per run.
     *
     * <p>Decided while building, because card 266's owner call 2 records that no
     * budget vocabulary exists anywhere in the owner's sixteen work orders — the
     * number is an addition to the house language rather than a recovery of it.
     * Three is the smallest count that can hold a run through a stumble, a
     * retry and a finish, and it sits in the same settings block as card 262's
     * thresholds because an operator tuning one will want the other.</p>
     */
    public static final int DEFAULT_BUDGET = 3;

    /**
     * {@code run_end.stopReason} for a run the harness held and that still ended
     * with steps open.
     *
     * <p>A VALUE on the existing field, never a new field — the same rule cards
     * 262 and 264 followed, so a line written today is shape-identical to one
     * written by v0.1.0. It is distinct from a clean {@code end_turn} AND from
     * card 264's plain {@code unfinished}, which is criterion 4: "the run says
     * it was continued N times and still ended with steps open" is a different
     * fact from "the run walked away from its plan once".</p>
     */
    public static final String STOP_REASON = "unfinished_after_continuations";

    /** How many open steps the continuation message names before it stops
     *  listing. The message is spent from the same context pool as the work, so
     *  a 200-step plan must not eat the window it is trying to save. The COUNT
     *  is never clipped, only the list. */
    private static final int MAX_LISTED_STEPS = 8;

    /** How long one listed step may be. */
    private static final int MAX_STEP_CHARS = 120;

    /** What the leash decided. Pinned on by tests and by the wire: the prose in
     *  {@code evidence} is written for a person and may be reworded, this may
     *  not. */
    public enum Decision {
        /** Another turn was started, with a message the harness wrote. */
        CONTINUED("continued"),
        /** The budget for this run is spent; the run ends with steps open. */
        BUDGET_EXHAUSTED("budget_exhausted"),
        /** Nothing changed since the last continuation, so a further one would
         *  be the spin card 262 was cut from. */
        NO_PROGRESS("no_progress");

        private final String wireName;

        Decision(String wireName) {
            this.wireName = wireName;
        }

        /** The stable snake_case name that travels on the wire.
         *  @return {@code continued}, {@code budget_exhausted} or {@code no_progress} */
        public String wireName() {
            return wireName;
        }
    }

    /**
     * One decision, with everything the loop and the wire need to state it.
     *
     * @param decision     what happens next
     * @param message      the harness-authored continuation, for the model; null
     *                     for both refusals, which have nothing to tell it
     * @param continuation which continuation this is, 1-based; on a refusal, how
     *                     many had already been spent
     * @param budget       the budget it was measured against, so "2 of 3" reads
     *                     without a second lookup
     * @param evidence     the same decision as one sentence in the operator's
     *                     language
     */
    public record Verdict(Decision decision, String message, int continuation, int budget,
                          String evidence) {}

    private volatile int budget;

    /** How many continuations THIS run has spent. */
    private int spent;

    /** What the run had to show for itself at the last continuation. Null before
     *  the first one, which is why a first stop is always held: there is nothing
     *  yet to be unchanged from. */
    private String lastSignature;

    /**
     * @param budget how many continuations one run may spend; 0 or less turns
     *               the leash off entirely — not even a refusal line, because a
     *               face that was never asked to continue has nothing to say
     */
    public ContinuationLeash(int budget) {
        this.budget = budget;
    }

    /** The budget this leash currently runs on.
     *  @return the count; 0 or less means off */
    public int budget() {
        return budget;
    }

    /**
     * Changes the budget at runtime, without a rebuild (criterion 7).
     *
     * <p>One agent serves every prompt of a browser session, so a budget read
     * only where the agent is built would need a reconnect to change — which is
     * a rebuild by another name. The faces re-read the operator's number per
     * prompt and set it here.</p>
     *
     * @param value the new budget; 0 turns the leash off
     */
    public void setBudget(int value) {
        this.budget = value;
    }

    /** How many continuations this run has spent so far.
     *  @return the count, reset by {@link #startRun()} */
    public int continuations() {
        return spent;
    }

    /**
     * Forgets the last run. Called by the loop at the top of every run, beside
     * card 262's {@code startRun}.
     *
     * <p>Same reason as the guard's: the count and the signature are sentences
     * about ONE run. An agent is not a task — {@code SessionConnection}'s
     * {@code buildAgentOnce} returns the same agent for every prompt of a
     * browser session — so without this the second prompt of an evening would
     * inherit the first one's spent budget.</p>
     */
    public void startRun() {
        spent = 0;
        lastSignature = null;
    }

    /**
     * Decides what happens to a run that just stopped.
     *
     * <p>The verdict it listens to is card 264's and no second notion of
     * "unfinished" is derived here: {@link PlanVerdict#FINISHED} has nothing
     * left to do, and {@link PlanVerdict#UNKNOWN} — the house backend's normal
     * case, a model with no tool belt that never wrote a ledger — cannot be
     * graded either way, so continuing it would be the harness guessing.</p>
     *
     * @param plan      the run's plan ledger, latest-wins, or null when none was written
     * @param signature what the run has to show for itself, from
     *                  {@link #signature(RunEvent.Plan, int)}
     * @return the decision, or empty when the leash does not apply to this exit
     *         at all
     */
    public Optional<Verdict> consider(RunEvent.Plan plan, String signature) {
        int allowed = budget;
        if (allowed <= 0 || PlanVerdict.of(plan) != PlanVerdict.UNFINISHED) {
            return Optional.empty();
        }
        int open = PlanVerdict.openSteps(plan);
        int total = PlanVerdict.totalSteps(plan);
        if (spent >= allowed) {
            return Optional.of(new Verdict(Decision.BUDGET_EXHAUSTED, null, spent, allowed,
                    "not continued: " + open + " of " + total + " steps open, and this run's"
                            + " budget of " + allowed + " continuations is spent"));
        }
        if (signature != null && signature.equals(lastSignature)) {
            return Optional.of(new Verdict(Decision.NO_PROGRESS, null, spent, allowed,
                    "not continued: nothing has changed since continuation " + spent
                            + " — the same plan, and no tool call that came back clean"));
        }
        spent++;
        lastSignature = signature;
        return Optional.of(new Verdict(Decision.CONTINUED, continuationMessage(plan, allowed),
                spent, allowed,
                "continued: " + open + " of " + total + " steps open, continuation "
                        + spent + " of " + allowed));
    }

    /**
     * Decides what happens to a run whose GOAL CHECK just failed (card 267,
     * criterion 6).
     *
     * <p>The second continuation reason, and deliberately not a second
     * mechanism. It spends {@link #budget}, it moves the same {@code spent}
     * counter and it compares against the same {@code lastSignature} — because a
     * ceiling that is the product of two numbers, only one of which is visible,
     * is not a ceiling anybody can reason about, and this class's own javadoc
     * says so about the turn cap. A run whose plan is open AND whose check fails
     * therefore cannot spend the budget twice.</p>
     *
     * <p>Where {@link #consider} refuses to grade an {@link PlanVerdict#UNKNOWN}
     * run, this one has nothing to refuse: an exit code is not a guess. So the
     * plan verdict is not consulted here at all — the check has already said
     * what the ledger could only estimate.</p>
     *
     * @param signature what the run has to show for itself, from
     *                  {@link #checkSignature(Integer, String, int)}
     * @param guidance  the check's own output, which becomes the continuation
     *                  message. The harness does not paraphrase a failure it did
     *                  not produce
     * @return the decision, or empty when the leash is off
     */
    public Optional<Verdict> considerFailedCheck(String signature, String guidance) {
        int allowed = budget;
        if (allowed <= 0) {
            return Optional.empty();
        }
        if (spent >= allowed) {
            return Optional.of(new Verdict(Decision.BUDGET_EXHAUSTED, null, spent, allowed,
                    "not continued: the goal's check did not pass, and this run's budget of "
                            + allowed + " continuations is spent"));
        }
        if (signature != null && signature.equals(lastSignature)) {
            return Optional.of(new Verdict(Decision.NO_PROGRESS, null, spent, allowed,
                    "not continued: the goal's check failed the same way as at continuation "
                            + spent + ", and nothing the model did moved it"));
        }
        spent++;
        lastSignature = signature;
        return Optional.of(new Verdict(Decision.CONTINUED, guidance, spent, allowed,
                "continued: the goal's check did not pass, continuation " + spent + " of "
                        + allowed));
    }

    /**
     * What a run with a goal has to show for itself — the fingerprint two failed
     * checks are compared by (card 267, criterion 6).
     *
     * <p>Both halves again, and for the reasons
     * {@link #signature(RunEvent.Plan, int)} states. The check's own exit code
     * and output are what the WORLD says; the clean-call count is what the model
     * did. Only when neither moved is a further continuation the spin card 262
     * was cut from.</p>
     *
     * <p><b>The known weakness, said out loud.</b> A check whose output carries a
     * timestamp or an elapsed time — most test runners print one — differs on
     * every run, so this fingerprint never matches and the spin guard never
     * fires. The bound that still holds in that case is the budget itself, which
     * is why the budget and not the fingerprint is the load-bearing half.
     * Normalising the output was considered and refused: guessing which digits
     * of somebody else's test runner are noise is exactly the kind of invention
     * this house measures instead of assuming.</p>
     *
     * @param exitCode        the check's exit code, or null when it never
     *                        produced one
     * @param output          what the check printed
     * @param productiveCalls how many tool calls of this run ran and came back
     *                        without an error
     * @return the fingerprint; the leading integer makes the join unambiguous
     *         even though the output half contains newlines
     */
    public static String checkSignature(Integer exitCode, String output, int productiveCalls) {
        return productiveCalls + "\n" + exitCode + "\n" + (output == null ? "" : output);
    }

    /**
     * What the run has to show for itself — the fingerprint two stops are
     * compared by.
     *
     * <p>Both halves are needed and neither alone is enough. The plan alone
     * would refuse a model that is genuinely working and merely forgets to tick
     * its own boxes; the call count alone would keep feeding turns to a model
     * that only fails.</p>
     *
     * @param plan            the run's plan ledger, or null
     * @param productiveCalls how many tool calls of this run ran and came back
     *                        without an error — a call the progress guard
     *                        refused never ran and is not among them
     * @return the fingerprint; the leading integer makes the join unambiguous
     *         even though the plan half contains newlines
     */
    public static String signature(RunEvent.Plan plan, int productiveCalls) {
        return productiveCalls + "\n" + PlanVerdict.planSignature(plan);
    }

    /**
     * The harness's own words, naming what is still open in the plan's own step
     * text and statuses (criterion 1).
     *
     * <p>Only the OPEN steps: a step that is done is not something still open,
     * and naming it invites the model to redo it.</p>
     *
     * @param plan   the ledger
     * @param allowed the budget, for the sentence that states the bound
     * @return the message the loop appends to the history as user content
     */
    private String continuationMessage(RunEvent.Plan plan, int allowed) {
        List<RunEvent.PlanStep> open = plan.steps().stream()
                .filter(step -> !"completed".equals(step.status()))
                .toList();
        StringBuilder out = new StringBuilder();
        out.append("You stopped, but the plan you wrote still has ")
                .append(open.size()).append(" of ").append(plan.steps().size())
                .append(" steps open:\n");
        open.stream().limit(MAX_LISTED_STEPS).forEach(step ->
                out.append("  - [").append(step.status()).append("] ")
                        .append(clip(step.text())).append('\n'));
        if (open.size() > MAX_LISTED_STEPS) {
            out.append("  - … and ").append(open.size() - MAX_LISTED_STEPS).append(" more\n");
        }
        out.append("Carry on with the next open step. If one cannot be done, mark it and say")
                .append(" why rather than stopping. This is continuation ").append(spent)
                .append(" of ").append(allowed)
                .append(" — after that the run ends with whatever is still open.");
        return out.toString();
    }

    private static String clip(String text) {
        if (text == null) {
            return "";
        }
        return text.length() <= MAX_STEP_CHARS ? text : text.substring(0, MAX_STEP_CHARS - 1) + "…";
    }
}
