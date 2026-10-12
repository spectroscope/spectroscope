package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.goal.GoalVerdict;
import dev.spectroscope.core.goal.RunGoal;
import dev.spectroscope.core.goal.SessionGoal;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.PToolCall;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 504, criterion 5: a child holds no goal. The parent's goal rides on
 * the parent's system prompt and is checked at the parent's exits; the child
 * the parent spawns is built without it, so it is never continued by it.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class ChildGoalFenceTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String OUTCOME = "The parser has a test.";
    private static final com.fasterxml.jackson.databind.JsonNode SPAWN = parse(
            "{\"agents\":[{\"type\":\"explore\",\"task\":\"look\"}]}");

    private static com.fasterxml.jackson.databind.JsonNode parse(String text) {
        try {
            return JSON.readTree(text);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    @Test
    void aSpawnedChildIsBuiltWithoutTheParentsGoal() {
        List<String> childSystems = new CopyOnWriteArrayList<>();
        List<String> parentSystems = new CopyOnWriteArrayList<>();
        AtomicInteger parentTurn = new AtomicInteger();
        LlmProvider provider = request -> {
            if (request.system().contains("subagent")) {
                childSystems.add(request.system());
                return List.of(new PTextDelta("child done"), new PStop(PStop.StopReason.END_TURN));
            }
            parentSystems.add(request.system());
            if (parentTurn.incrementAndGet() == 1) {
                return List.of(new PToolCall("p1", "spawn_agents", SPAWN),
                        new PStop(PStop.StopReason.TOOL_USE));
            }
            return List.of(new PTextDelta("parent done"), new PStop(PStop.StopReason.END_TURN));
        };
        AtomicInteger checks = new AtomicInteger();
        SessionGoal goal = new SessionGoal((stated, context) -> {
            checks.incrementAndGet();
            return new GoalVerdict(GoalVerdict.Outcome.MET, "exit 0", 0, "", 1, null, null, "met");
        });
        goal.state(new RunGoal(OUTCOME, "true"));

        SubagentManager manager = new SubagentManager(SubagentConfig.builder().provider(provider)
                .cwd(Path.of(".")).parentAgentId("main").onPermission(request -> true).build());
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder().provider(provider).systemPrompt("You are the parent.")
                .registry(registry).cwd(Path.of(".")).agentId("main").onPermission(request -> true)
                .goal(goal).build());
        try (EventStream stream = manager.run(parent, "go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(event -> { });
        }

        assertFalse(childSystems.isEmpty(), "premise: the child ran");
        assertTrue(parentSystems.stream().allMatch(system -> system.contains(OUTCOME)),
                "positive: the parent carries its goal");
        childSystems.forEach(system -> assertFalse(system.contains(OUTCOME),
                "the child carries the parent's goal: " + system));
        assertEquals(1, checks.get(), "the goal is checked once, at the parent's end_turn");
    }
}
