package dev.spectroscope.core.goal;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;

import java.nio.file.Path;
import java.util.List;
import java.util.function.Supplier;

/**
 * The teeth: whatever decides whether a {@link RunGoal} was reached
 * (card 267, part 3).
 *
 * <p>Two implementations ship and they are not equals. {@link CommandGoalCheck}
 * is the primary and the only one wired anywhere by default: a command, an exit
 * code, a verdict nobody has to interpret. {@link EvaluatorGoalCheck} is behind
 * an explicit opt-in with a named model, because on this house's own backend the
 * judge would be weaker than the worker — LM Studio reports
 * {@code trained_for_tool_use: false} for the loaded {@code
 * deepseek-v4-flash-0731@iq1_m} — and a critic without teeth backfires.</p>
 *
 * <p>A check is handed what it needs and nothing else. It gets no tool belt, no
 * registry and no permission broker: the goal never widens what a run may do
 * (criterion 5), so the seam a check reaches the world through is the same
 * {@code /bin/sh} the {@code run_command} tool uses, behind the same
 * gate.</p>
 */
public interface GoalCheck {

    /**
     * Everything a check may see.
     *
     * @param cwd        where the command runs — the agent's own working
     *                   directory, never a wider one
     * @param signal     the run's cancellation; a cancelled run kills the check
     * @param transcript the run's history so far, for the evaluator variant
     *                   only. A command check never reads it, which is the
     *                   point: an exit code cannot be talked into anything
     */
    record Context(Path cwd, CancelSignal signal, Supplier<List<ProviderMessage>> transcript) {}

    /**
     * Decides.
     *
     * @param goal    the stated goal
     * @param context what the check may see
     * @return the verdict, carrying whatever produced it; never null, and never
     *         {@link GoalVerdict.Outcome#MET} for a check that did not actually
     *         run to completion
     */
    GoalVerdict run(RunGoal goal, Context context);
}
