package dev.spectroscope.core.goal;

import dev.spectroscope.core.tools.ShellCommand;

import java.util.Map;

/**
 * The shipped teeth: a command, and its exit code is the verdict (card 267,
 * placement (a)).
 *
 * <p>It runs through {@link ShellCommand} — the same {@code /bin/sh -c} runner
 * behind {@code run_command} and the hook runner, with the same PATH policy, the
 * same concurrent drain and the same kill-on-cancel. A second process runner
 * would be a second place a command means something, and this house has paid
 * for that mistake before.</p>
 *
 * <p><b>Only exit 0 is met.</b> Every other ending is either a failure (the
 * command ran and said no) or untested (the command never ran to completion).
 * A timeout is untested and not failed: "the check hung" is a statement about
 * the check, not about the work, and reporting it as a failure would spend the
 * continuation budget on a broken thermometer.</p>
 */
public final class CommandGoalCheck implements GoalCheck {

    /** The shipped wall-clock budget for one check, in seconds. A goal's check
     *  is a test suite or a build, not a deployment; ten minutes is the point
     *  past which "it hung" is the more likely reading. */
    public static final long DEFAULT_TIMEOUT_SECONDS = 600;

    private final long timeoutSeconds;

    /** A check on the shipped timeout. */
    public CommandGoalCheck() {
        this(DEFAULT_TIMEOUT_SECONDS);
    }

    /**
     * @param timeoutSeconds wall-clock budget for one check run; an overrun is
     *                       {@link GoalVerdict.Outcome#UNTESTED}
     */
    public CommandGoalCheck(long timeoutSeconds) {
        this.timeoutSeconds = timeoutSeconds;
    }

    @Override
    public GoalVerdict run(RunGoal goal, Context context) {
        if (goal == null || !goal.hasCheck()) {
            return new GoalVerdict(GoalVerdict.Outcome.UNTESTED, null, null, "", 0, null, null,
                    "untested: this goal states no check, so nothing confirms it");
        }
        String command = goal.check().strip();
        long startedAt = System.currentTimeMillis();
        // keepTail: a suite prints its failure LAST. The review measured what the
        // head-clip did here — 600 "ok N" lines survived and the one line that
        // said what broke did not, so criterion 3's "the failure output as the
        // guidance" was handing back the passing prefix.
        ShellCommand.Result result = ShellCommand.run(command, Map.of(), context.cwd(),
                timeoutSeconds, context.signal(), GoalVerdict.MAX_OUTPUT_CHARS, true);
        long durationMs = System.currentTimeMillis() - startedAt;
        if (result.timedOut()) {
            return new GoalVerdict(GoalVerdict.Outcome.UNTESTED, command, null, result.output(),
                    durationMs, null, null,
                    "untested: the check did not finish within " + timeoutSeconds + " s");
        }
        if (result.failure() != null) {
            return new GoalVerdict(GoalVerdict.Outcome.UNTESTED, command, null, result.output(),
                    durationMs, null, null,
                    "untested: the check could not be run — " + result.failure());
        }
        int exit = result.exitCode();
        GoalVerdict.Outcome outcome = exit == 0
                ? GoalVerdict.Outcome.MET : GoalVerdict.Outcome.FAILED;
        String evidence = exit == 0
                ? "met: the check exited 0"
                : "failed: the check exited " + exit;
        return new GoalVerdict(outcome, command, exit, result.output(), durationMs, null, null,
                evidence);
    }
}
