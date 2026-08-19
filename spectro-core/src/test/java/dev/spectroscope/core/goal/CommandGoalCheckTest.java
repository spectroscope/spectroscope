package dev.spectroscope.core.goal;

import dev.spectroscope.core.CancelSignal;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 267, the teeth: an exit code is the verdict, and everything that is not
 * an exit code of 0 is not "met".
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CommandGoalCheckTest {

    private static GoalCheck.Context context(Path cwd) {
        return new GoalCheck.Context(cwd, new CancelSignal(), List::of);
    }

    @Test
    void exitZeroIsTheOnlyThingThatMeetsAGoal(@TempDir Path dir) {
        GoalVerdict verdict = new CommandGoalCheck()
                .run(new RunGoal("it works", "exit 0"), context(dir));
        assertEquals(GoalVerdict.Outcome.MET, verdict.outcome());
        assertEquals(0, verdict.exitCode());
        assertEquals("exit 0", verdict.command());
    }

    @Test
    void aNonZeroExitFailsAndCarriesTheCodeAndTheOutput(@TempDir Path dir) {
        GoalVerdict verdict = new CommandGoalCheck()
                .run(new RunGoal("it works", "echo 'expected 0.2, got 0.18432'; exit 3"),
                        context(dir));
        assertEquals(GoalVerdict.Outcome.FAILED, verdict.outcome());
        assertEquals(3, verdict.exitCode());
        assertTrue(verdict.output().contains("got 0.18432"), verdict.output());
    }

    @Test
    void aGoalWithNoCheckIsUntestedAndNeverMet(@TempDir Path dir) {
        GoalVerdict verdict = new CommandGoalCheck()
                .run(new RunGoal("ship it", null), context(dir));
        assertEquals(GoalVerdict.Outcome.UNTESTED, verdict.outcome());
        assertNull(verdict.exitCode());
    }

    @Test
    void aCheckThatHangsIsUntestedAndNotFailed(@TempDir Path dir) {
        // A hung check is a statement about the thermometer, not about the work.
        // Reporting it FAILED would spend the continuation budget on a broken
        // instrument, which is the one thing criterion 3 separates by name.
        GoalVerdict verdict = new CommandGoalCheck(1)
                .run(new RunGoal("it works", "sleep 30"), context(dir));
        assertEquals(GoalVerdict.Outcome.UNTESTED, verdict.outcome());
        assertNull(verdict.exitCode());
        assertTrue(verdict.evidence().contains("did not finish"), verdict.evidence());
    }

    @Test
    void theCheckRunsInTheAgentsOwnDirectoryAndNoWiderOne(@TempDir Path dir) throws Exception {
        java.nio.file.Files.writeString(dir.resolve("marker"), "here");
        GoalVerdict verdict = new CommandGoalCheck()
                .run(new RunGoal("it works", "test -f marker"), context(dir));
        assertEquals(GoalVerdict.Outcome.MET, verdict.outcome(), verdict.evidence());
    }

    @Test
    void aVerdictNeverUsesTheBannedRegister(@TempDir Path dir) {
        // .spectro/skills/verification/SKILL.md: "should work", "probably
        // passes", "looks correct" are banned words. A verdict line states a
        // measurement; those three state a belief.
        for (String command : List.of("exit 0", "exit 1", "sleep 30")) {
            GoalVerdict verdict = new CommandGoalCheck(1)
                    .run(new RunGoal("it works", command), context(dir));
            String said = verdict.evidence().toLowerCase(java.util.Locale.ROOT);
            assertNotNull(verdict.evidence());
            for (String banned : List.of("should work", "probably", "looks correct")) {
                assertTrue(!said.contains(banned), command + " → " + verdict.evidence());
            }
        }
    }

    @Test
    void theChecksOwnDurationIsRecorded(@TempDir Path dir) {
        // The non-functional criterion: the check's time is kept apart from the
        // model's work, the split card 111 established for the gate.
        GoalVerdict verdict = new CommandGoalCheck()
                .run(new RunGoal("it works", "sleep 0.2; exit 0"), context(dir));
        assertTrue(verdict.durationMs() >= 150,
                "a 200 ms check reported " + verdict.durationMs() + " ms");
    }
}
