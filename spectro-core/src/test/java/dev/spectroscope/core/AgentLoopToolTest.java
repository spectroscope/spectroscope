package dev.spectroscope.core;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.loop.LoopDriver;
import dev.spectroscope.core.loop.ScheduleWakeupTool;
import dev.spectroscope.core.permission.ToolTier;
import dev.spectroscope.core.permission.ToolTierMap;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 504, criterion 7: the agent offers {@code schedule_wakeup} only while
 * the session runs a loop, reads that once per run, and asks the gate for it.
 * A session without a loop sends the tools array it sent before the card.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class AgentLoopToolTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static Agent agent(LlmProvider provider, List<RunEvent.PermissionRequest> asked) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(new ScheduleWakeupTool(() -> (LoopDriver) null));
        return new Agent(AgentOptions.builder().provider(provider).systemPrompt("test").registry(registry)
                .cwd(Path.of(".")).onPermission(request -> {
                    asked.add(request);
                    return true;
                }).build());
    }

    private static List<String> toolNames(LlmProvider.ProviderRequest request) {
        return request.tools().stream().map(LlmProvider.ToolSpec::name).toList();
    }

    private static List<RunEvent> run(Agent agent) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static final List<LlmProvider.ProviderEvent> DONE = List.of(new LlmProvider.PTextDelta("ok"),
            new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));

    @Test
    void withoutALoopTheToolIsNotOffered() {
        List<List<String>> seen = new CopyOnWriteArrayList<>();
        Agent agent = agent(request -> {
            seen.add(toolNames(request));
            return DONE;
        }, new ArrayList<>());
        run(agent);
        assertFalse(seen.get(0).contains(ScheduleWakeupTool.NAME), seen.toString());
        assertFalse(agent.toolSpecsForNextRun().stream().anyMatch(s -> s.name().equals(ScheduleWakeupTool.NAME)));
    }

    @Test
    void whileALoopRunsTheToolIsOffered() {
        List<List<String>> seen = new CopyOnWriteArrayList<>();
        Agent agent = agent(request -> {
            seen.add(toolNames(request));
            return DONE;
        }, new ArrayList<>());
        agent.loopActive(() -> true);
        run(agent);
        assertTrue(seen.get(0).contains(ScheduleWakeupTool.NAME), seen.toString());
        assertTrue(agent.toolSpecsForNextRun().stream().anyMatch(s -> s.name().equals(ScheduleWakeupTool.NAME)));
    }

    @Test
    void theLoopIsReadOncePerRun() {
        AtomicBoolean loop = new AtomicBoolean(true);
        AtomicInteger turn = new AtomicInteger();
        List<List<String>> seen = new CopyOnWriteArrayList<>();
        Agent agent = agent(request -> {
            seen.add(toolNames(request));
            if (turn.incrementAndGet() == 1) {
                loop.set(false); // the loop ends while the run works
                return List.of(new LlmProvider.PToolCall("c1", "missing_tool", JSON.createObjectNode()),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
            }
            return DONE;
        }, new ArrayList<>());
        agent.loopActive(loop::get);
        run(agent);
        assertEquals(2, seen.size());
        assertEquals(seen.get(0), seen.get(1), "one tools array for the whole run");
        assertTrue(seen.get(1).contains(ScheduleWakeupTool.NAME));
    }

    @Test
    void aCallWithoutALoopIsAnswered() {
        AtomicInteger turn = new AtomicInteger();
        List<String> results = new CopyOnWriteArrayList<>();
        Agent agent = agent(request -> {
            if (turn.incrementAndGet() == 1) {
                return List.of(new LlmProvider.PToolCall("c1", ScheduleWakeupTool.NAME,
                                JSON.createObjectNode().put("delaySeconds", 60).put("reason", "r").put("prompt", "p")),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
            }
            return DONE;
        }, new ArrayList<>());
        for (RunEvent event : run(agent)) {
            if (event instanceof RunEvent.ToolResult result) {
                results.add(result.output());
            }
        }
        assertEquals(1, results.size());
        assertTrue(results.get(0).startsWith("ERROR: unknown tool: schedule_wakeup"), results.get(0));
        assertTrue(results.get(0).contains("/loop"), results.get(0));
    }

    @Test
    void theCallAsksTheGate() {
        AtomicInteger turn = new AtomicInteger();
        List<RunEvent.PermissionRequest> asked = new CopyOnWriteArrayList<>();
        Agent agent = agent(request -> {
            if (turn.incrementAndGet() == 1) {
                return List.of(new LlmProvider.PToolCall("c1", ScheduleWakeupTool.NAME,
                                JSON.createObjectNode().put("stop", true)),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
            }
            return DONE;
        }, asked);
        agent.loopActive(() -> true);
        run(agent);
        assertEquals(List.of(ScheduleWakeupTool.NAME), asked.stream().map(RunEvent.PermissionRequest::name).toList());
    }

    @Test
    void itsTierIsWrite() {
        assertEquals(ToolTier.WRITE, ToolTierMap.shipped().resolve(ScheduleWakeupTool.NAME).tier());
    }

    // ── fix round 1, found in the live check: the turn ends when it returns ──

    private static Agent loopAgent(LlmProvider provider, LoopDriver driver) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(new ScheduleWakeupTool(() -> driver));
        Agent agent = new Agent(AgentOptions.builder().provider(provider).systemPrompt("test").registry(registry)
                .cwd(Path.of(".")).onPermission(request -> true).build());
        agent.loopActive(() -> true);
        return agent;
    }

    private static LoopDriver driver() {
        LoopDriver driver = new LoopDriver("s-r1", (task, delayMs) -> () -> { }, System::currentTimeMillis, null);
        driver.start("watch the build", null);
        return driver;
    }

    private static List<LlmProvider.ProviderEvent> wakeupCall(int n, String prompt) {
        return List.of(new LlmProvider.PToolCall("c" + n, ScheduleWakeupTool.NAME,
                        JSON.createObjectNode().put("delaySeconds", 60).put("reason", "r").put("prompt", prompt)),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    @Test
    void anArmedWakeupEndsTheRunAfterItsRound() {
        // Live check 2026-10-12, minimax-m3:cloud: the model called
        // schedule_wakeup again and again in one run, 776 times in 22 minutes
        // (379 in the first eleven, counted from its .loop.jsonl), while the
        // result said the turn ends when it returns.
        AtomicInteger requests = new AtomicInteger();
        Agent agent = loopAgent(request -> wakeupCall(requests.incrementAndGet(), "<<loop>>"), driver());
        List<RunEvent> events = run(agent);
        assertEquals(1, requests.get(), "no request after the round that armed the wakeup");
        RunEvent.RunEnd end = (RunEvent.RunEnd) events.get(events.size() - 1);
        assertEquals("end_turn", end.stopReason());
        assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.ToolResult r
                && r.output().startsWith("Next wakeup at")), "the call itself ran");
    }

    @Test
    void aStopEndsTheRunAfterItsRoundToo() {
        AtomicInteger requests = new AtomicInteger();
        Agent agent = loopAgent(request -> {
            requests.incrementAndGet();
            return List.of(new LlmProvider.PToolCall("c1", ScheduleWakeupTool.NAME,
                            JSON.createObjectNode().put("stop", true)),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
        }, driver());
        run(agent);
        assertEquals(1, requests.get());
    }

    @Test
    @GuideExit("goal-check.schedule-wakeup")
    void aGoalIsNotCheckedOnTheRoundThatArmedTheWakeup() {
        // Fix round 2, pinning provisional decision 8 of fix round 1: the run
        // that called schedule_wakeup ends end_turn right after that round,
        // before the goal's exit, so a self paced tick never grades the goal.
        // The goal is checked when a tick ends without schedule_wakeup. An
        // owner call on card 504; a change here is that decision.
        AtomicInteger checks = new AtomicInteger();
        dev.spectroscope.core.goal.SessionGoal goal = new dev.spectroscope.core.goal.SessionGoal(
                (stated, context) -> {
                    checks.incrementAndGet();
                    return new dev.spectroscope.core.goal.GoalVerdict(
                            dev.spectroscope.core.goal.GoalVerdict.Outcome.FAILED, "npm test", 1, "1 failing", 5,
                            null, null, "failed: the check exited 1");
                });
        goal.state(new dev.spectroscope.core.goal.RunGoal("The tests are green.", "npm test"));
        ToolRegistry registry = new ToolRegistry();
        LoopDriver driver = driver();
        registry.register(new ScheduleWakeupTool(() -> driver));
        AtomicInteger requests = new AtomicInteger();
        Agent agent = new Agent(AgentOptions.builder()
                .provider(request -> wakeupCall(requests.incrementAndGet(), "<<loop>>"))
                .systemPrompt("test").registry(registry).cwd(Path.of(".")).onPermission(request -> true)
                .goal(goal).build());
        agent.loopActive(() -> true);
        List<RunEvent> events = run(agent);
        assertEquals(1, requests.get(), "no goal continuation after the round that armed the wakeup");
        assertEquals(0, checks.get(), "the goal's check did not run on this exit");
        assertFalse(events.stream().anyMatch(e -> e instanceof RunEvent.GoalCheck), "no goal_check line");
        assertEquals("end_turn", ((RunEvent.RunEnd) events.get(events.size() - 1)).stopReason());
    }

    @Test
    @GuideExit("goal-check.loop-tick")
    void aGoalIsCheckedWhenALoopTickEndsWithoutAWakeup() {
        // The positive beside the pin above: the goal and the loop do meet.
        AtomicInteger checks = new AtomicInteger();
        dev.spectroscope.core.goal.SessionGoal goal = new dev.spectroscope.core.goal.SessionGoal(
                (stated, context) -> {
                    checks.incrementAndGet();
                    return new dev.spectroscope.core.goal.GoalVerdict(
                            dev.spectroscope.core.goal.GoalVerdict.Outcome.MET, "npm test", 0, "ok", 5,
                            null, null, "met: the check exited 0");
                });
        goal.state(new dev.spectroscope.core.goal.RunGoal("The tests are green.", "npm test"));
        ToolRegistry registry = new ToolRegistry();
        LoopDriver driver = driver();
        registry.register(new ScheduleWakeupTool(() -> driver));
        Agent agent = new Agent(AgentOptions.builder().provider(request -> DONE)
                .systemPrompt("test").registry(registry).cwd(Path.of(".")).onPermission(request -> true)
                .goal(goal).build());
        agent.loopActive(() -> true);
        List<RunEvent> events = run(agent);
        assertEquals(1, checks.get());
        assertEquals(dev.spectroscope.core.goal.GoalVerdict.MET_STOP_REASON,
                ((RunEvent.RunEnd) events.get(events.size() - 1)).stopReason());
    }

    @Test
    void aRefusedWakeupDoesNotEndTheRun() {
        AtomicInteger requests = new AtomicInteger();
        Agent agent = loopAgent(request -> requests.incrementAndGet() == 1
                ? List.of(new LlmProvider.PToolCall("c1", ScheduleWakeupTool.NAME,
                                JSON.createObjectNode().put("delaySeconds", 60)),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE))
                : DONE, driver());
        List<RunEvent> events = run(agent);
        assertEquals(2, requests.get(), "an ERROR result goes back to the model to correct it");
        assertEquals("end_turn", ((RunEvent.RunEnd) events.get(events.size() - 1)).stopReason());
    }
}
