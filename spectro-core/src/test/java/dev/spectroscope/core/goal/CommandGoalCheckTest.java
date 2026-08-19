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

    @Test
    void theFailingLineOfALongSuiteIsWhatTheModelIsHandedBack(@TempDir Path dir) {
        // The review's finding, and it is the normal case rather than an edge:
        // `node --test` — the command AC 8 itself names — prints one line per
        // test, so a suite of any size pushes its failure past the clip. A
        // head-clipped output hands the model four thousand characters of
        // passing lines under the sentence "the check ran and did not pass",
        // which is criterion 3's guidance saying nothing about the failure.
        String command = "i=1; while [ $i -le 600 ]; do echo \"ok $i - a passing case\"; "
                + "i=$((i+1)); done; echo 'not ok 601 - THE FAILING ASSERTION: expected 2 got 0'; "
                + "exit 1";
        GoalVerdict verdict = new CommandGoalCheck()
                .run(new RunGoal("the suite is green", command), context(dir));

        assertEquals(GoalVerdict.Outcome.FAILED, verdict.outcome(), verdict.evidence());
        assertTrue(verdict.output().length() <= GoalVerdict.MAX_OUTPUT_CHARS,
                "the clip still has to hold, or a chatty suite eats the window the goal is"
                        + " trying to protect — got " + verdict.output().length());
        assertTrue(verdict.output().contains("THE FAILING ASSERTION"),
                "the failure is at the END of a suite's output, so the TAIL is the part a"
                        + " reader cannot afford to lose. Got the last 80 chars: "
                        + verdict.output().substring(Math.max(0, verdict.output().length() - 80)));
        assertTrue(verdict.asGuidance().contains("THE FAILING ASSERTION"),
                "criterion 3 hands the check's own output back as the guidance");
    }

    @Test
    void aShortOutputIsHandedBackWholeAndUnmarked(@TempDir Path dir) {
        // The other direction of the same clip: nothing is prepended, nothing is
        // dropped, for the output that fits. A tail-clip that always stamped its
        // ellipsis would make every verdict look truncated.
        GoalVerdict verdict = new CommandGoalCheck()
                .run(new RunGoal("it works", "echo 'two lines'; echo 'and no more'; exit 1"),
                        context(dir));
        assertEquals("two lines\nand no more\n", verdict.output());
    }
}
