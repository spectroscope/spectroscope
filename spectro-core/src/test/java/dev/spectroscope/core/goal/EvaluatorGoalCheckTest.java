package dev.spectroscope.core.goal;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The opt-in judge, offline (card 267, review pass).
 *
 * <p>It shipped with no test of its own: the only class that constructed one
 * was {@code LiveWeakModelGoalTest}, which is behind
 * {@code SPECTRO_LIVE=1} and therefore skipped in every gate run. 133 lines of
 * verdict logic were unpinned in both directions, and the review found a real
 * defect inside them — a judge that answered {@code GOAL_NOT_MET} and mentioned
 * the other word in its sentence was recorded MET.</p>
 *
 * <p>Everything here scripts the provider, so this class needs no backend.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class EvaluatorGoalCheckTest {

    private static final String MODEL = "judge-model-1";

    private static GoalCheck.Context context(Path cwd) {
        return new GoalCheck.Context(cwd, new CancelSignal(), List::of);
    }

    /** A provider that says one thing and stops. */
    private static LlmProvider says(String answer) {
        return request -> List.of(new LlmProvider.PTextDelta(answer),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    private static GoalVerdict judged(LlmProvider provider, Path dir) {
        return new EvaluatorGoalCheck(provider, MODEL)
                .run(new RunGoal("the auth tests pass", null), context(dir));
    }

    @Test
    void theVerdictWordDecidesAndTheModelIsNamedOnIt(@TempDir Path dir) {
        GoalVerdict verdict = judged(says("GOAL_MET the suite ran and printed 4 passing cases."),
                dir);
        assertEquals(GoalVerdict.Outcome.MET, verdict.outcome(), verdict.evidence());
        assertEquals(MODEL, verdict.judge());
        assertNull(verdict.exitCode(), "an opinion is not an exit code and must not look like one");
    }

    @Test
    void theRefusalWordIsAFailureAndNotAnUntested(@TempDir Path dir) {
        GoalVerdict verdict = judged(says("GOAL_NOT_MET the suite was never run."), dir);
        assertEquals(GoalVerdict.Outcome.FAILED, verdict.outcome(), verdict.evidence());
    }

    @Test
    void aRefusalThatQUOTESTheOtherWordIsStillARefusal(@TempDir Path dir) {
        // The review's finding, and the house's own named shape: a negative pin
        // that is green for its own opposite. GOAL_MET is not a substring of
        // GOAL_NOT_MET, so the two words never collide by spelling — but a judge
        // that names both in one sentence is the normal case, because the system
        // prompt asks it for a verdict AND a reason, and the reason is about
        // evidence for the other verdict. Tested MET-first, this run was graded
        // met while its judge had said the opposite.
        GoalVerdict verdict = judged(says(
                "GOAL_NOT_MET — the transcript never shows the suite being run, so there is no"
                        + " GOAL_MET evidence in it."), dir);
        assertEquals(GoalVerdict.Outcome.FAILED, verdict.outcome(),
                "the class javadoc says it refuses to guess in the permissive direction: "
                        + verdict.evidence());
    }

    @Test
    void aJudgeThatRamblesHasNotJudged(@TempDir Path dir) {
        GoalVerdict verdict = judged(says("Well, it depends what you mean by pass."), dir);
        assertEquals(GoalVerdict.Outcome.UNTESTED, verdict.outcome(), verdict.evidence());
        assertTrue(verdict.evidence().contains("neither verdict word"), verdict.evidence());
    }

    @Test
    void aBackendThatThrowsIsUntestedAndNeverMet(@TempDir Path dir) {
        LlmProvider broken = request -> {
            throw new IllegalStateException("connection refused");
        };
        GoalVerdict verdict = judged(broken, dir);
        assertEquals(GoalVerdict.Outcome.UNTESTED, verdict.outcome(), verdict.evidence());
        assertTrue(verdict.evidence().contains("connection refused"), verdict.evidence());
        assertEquals(MODEL, verdict.judge(), "even a failure names who was asked");
    }

    @Test
    void anEmptyAnswerIsUntested(@TempDir Path dir) {
        assertEquals(GoalVerdict.Outcome.UNTESTED, judged(says(""), dir).outcome());
    }
}
