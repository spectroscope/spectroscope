package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.goal.GoalCheck;
import dev.spectroscope.core.goal.GoalVerdict;
import dev.spectroscope.core.goal.RunGoal;
import dev.spectroscope.core.goal.SessionGoal;
import dev.spectroscope.core.loop.ContinuationLeash;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 504, criterion 2: a failed goal check continues the run from a goal
 * counter that is not the leash's {@code continuationBudget}. The ceiling is
 * {@code maxTurns}, and the same failure fingerprint twice in a row ends the
 * run.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class AgentGoalContinuationTest {

    private static final String OUTCOME = "The tests are green.";

    /** A check whose verdicts are scripted; the last one repeats. */
    private static final class ScriptedCheck implements GoalCheck {
        private final List<GoalVerdict> script;
        private final AtomicInteger next = new AtomicInteger();

        ScriptedCheck(GoalVerdict... verdicts) {
            this.script = List.of(verdicts);
        }

        @Override
        public GoalVerdict run(RunGoal goal, Context context) {
            int index = next.getAndIncrement();
            return script.get(Math.min(index, script.size() - 1));
        }
    }

    private static GoalVerdict met() {
        return new GoalVerdict(GoalVerdict.Outcome.MET, "npm test", 0, "ok", 5, null, null,
                "met: the check exited 0");
    }

    private static GoalVerdict failed(String output) {
        return new GoalVerdict(GoalVerdict.Outcome.FAILED, "npm test", 1, output, 5, null, null,
                "failed: the check exited 1");
    }

    private static LlmProvider answers() {
        return request -> List.of(new LlmProvider.PTextDelta("Done, I think."),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    private static Agent agent(SessionGoal goal, ContinuationLeash leash, Integer maxTurns) {
        return new Agent(AgentOptions.builder()
                .provider(answers())
                .systemPrompt("test")
                .registry(new ToolRegistry())
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .goal(goal)
                .continuationLeash(leash)
                .maxTurns(maxTurns)
                .build());
    }

    private static SessionGoal goal(GoalCheck check) {
        SessionGoal goal = new SessionGoal(check);
        goal.state(new RunGoal(OUTCOME, "npm test"));
        return goal;
    }

    private static List<RunEvent> run(Agent agent) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("make the tests green", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static String stopReason(List<RunEvent> events) {
        return events.stream().filter(RunEvent.RunEnd.class::isInstance).map(RunEvent.RunEnd.class::cast)
                .reduce((a, b) -> b).orElseThrow().stopReason();
    }

    private static List<String> decisions(List<RunEvent> events) {
        return events.stream().filter(RunEvent.Continuation.class::isInstance)
                .map(RunEvent.Continuation.class::cast).map(RunEvent.Continuation::decision).toList();
    }

    private static List<Integer> turns(List<RunEvent> events) {
        return events.stream().filter(RunEvent.TurnStart.class::isInstance)
                .map(RunEvent.TurnStart.class::cast).map(RunEvent.TurnStart::turn).toList();
    }

    @Test
    void theNoProgressBrakeEndsTheRunWithTheMeasuredStopReason() {
        // Measured on the base e42ae648 with a budget of 3 (red-t1 log): the
        // same failure twice wrote a continuation line `no_progress` and ended
        // the run `goal_unmet`. The goal counter keeps that stop reason.
        List<RunEvent> events = run(agent(goal(new ScriptedCheck(failed("1 failing"))),
                new ContinuationLeash(0), null));
        assertEquals(List.of("goal_continued", "no_progress"), decisions(events));
        assertEquals(GoalVerdict.UNMET_STOP_REASON, stopReason(events));
    }

    @Test
    void aFailedCheckContinuesWithAContinuationBudgetOfZero() {
        List<RunEvent> events = run(agent(
                goal(new ScriptedCheck(failed("2 failing"), failed("1 failing"), met())),
                new ContinuationLeash(0), null));
        assertEquals(List.of("goal_continued", "goal_continued"), decisions(events));
        assertEquals(GoalVerdict.MET_STOP_REASON, stopReason(events));
        assertEquals(List.of(1, 2, 3), turns(events), "the turn counter is not reset by a goal continuation");
    }

    @Test
    void theGoalCounterLeavesTheLeashBudgetUntouched() {
        ContinuationLeash leash = new ContinuationLeash(1);
        List<RunEvent> events = run(agent(
                goal(new ScriptedCheck(failed("3"), failed("2"), failed("1"), met())), leash, null));
        assertEquals(GoalVerdict.MET_STOP_REASON, stopReason(events));
        assertEquals(3, decisions(events).size(), "three continuations past a budget of one");
        assertEquals(0, leash.continuations(), "the leash spent nothing on the goal");
    }

    @Test
    void aGoalContinuesOnAFaceWithoutALeashObject() {
        List<RunEvent> events = run(agent(goal(new ScriptedCheck(failed("a"), met())), null, null));
        assertEquals(List.of("goal_continued"), decisions(events));
        assertEquals(GoalVerdict.MET_STOP_REASON, stopReason(events));
    }

    @Test
    void theTurnCapEndsTheRunMaxTurnsWithTheGoalStillUnmet() {
        AtomicInteger n = new AtomicInteger();
        GoalCheck neverTheSame = (goal, context) -> failed("failing run " + n.incrementAndGet());
        List<RunEvent> events = run(agent(goal(neverTheSame), new ContinuationLeash(0), 3));
        assertEquals("max_turns", stopReason(events));
        assertEquals(List.of(1, 2, 3), turns(events));
        List<RunEvent.GoalCheck> checks = events.stream().filter(RunEvent.GoalCheck.class::isInstance)
                .map(RunEvent.GoalCheck.class::cast).toList();
        assertEquals("failed", checks.get(checks.size() - 1).outcome(), "the goal is still unmet at the cap");
    }

    @Test
    void aCheckThatPrintsItsOwnDurationRunsToTheTurnCap() {
        // Fix round 2, the behaviour as concept decision 11 has it: the same
        // failure with a different elapsed time is not "the same failure",
        // so the brake does not fire and the turn cap (1000 by default) ends
        // the run. Pinned so a change to it is a decision, not an accident.
        AtomicInteger n = new AtomicInteger();
        GoalCheck timed = (goal, context) -> failed("Tests: 1 failed, 41 passed\nTime: 0."
                + (80 + n.incrementAndGet()) + " s");
        List<RunEvent> events = run(agent(goal(timed), new ContinuationLeash(0), 5));
        assertEquals("max_turns", stopReason(events));
        assertEquals(List.of(1, 2, 3, 4, 5), turns(events));
        assertTrue(decisions(events).stream().allMatch("goal_continued"::equals), decisions(events).toString());
    }

    @Test
    void theDefaultTurnCapIsTheCeilingOfAGoal() {
        assertEquals(1000, Agent.DEFAULT_MAX_TURNS, "the number the guide and the card name");
    }

    @Test
    void aGoalContinuationNamesTheTurnCapAsItsBound() {
        List<RunEvent> events = run(agent(goal(new ScriptedCheck(failed("x"), met())),
                new ContinuationLeash(0), 7));
        RunEvent.Continuation line = events.stream().filter(RunEvent.Continuation.class::isInstance)
                .map(RunEvent.Continuation.class::cast).findFirst().orElseThrow();
        assertEquals(1, line.continuation());
        assertEquals(7, line.budget(), "the bound on the line is the turn cap, not the leash budget");
        assertTrue(line.evidence().contains("turn cap"), line.evidence());
    }
}
