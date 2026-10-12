package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.goal.GoalVerdict;
import dev.spectroscope.core.goal.RunGoal;
import dev.spectroscope.core.goal.SessionGoal;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.TransientProviderException;
import dev.spectroscope.core.steering.SteeringInbox;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 504, criterion 4: the goal clears itself on a context limit, an
 * authentication, a billing and a model unavailable error, with a chat line;
 * a transient API error, a steering message and the turn cap do not clear it.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class AgentGoalClearTest {

    private static final RunGoal STATED = new RunGoal("The tests are green.", "npm test");

    private static SessionGoal goal(List<String> heard) {
        SessionGoal goal = new SessionGoal((g, context) -> new GoalVerdict(GoalVerdict.Outcome.MET,
                "npm test", 0, "", 1, null, null, "met"));
        goal.state(STATED);
        goal.listen(new SessionGoal.Listener() {
            @Override
            public void cleared(String reason) {
                heard.add(reason);
            }
        });
        return goal;
    }

    private static LlmProvider throwing(RuntimeException error) {
        return request -> {
            throw error;
        };
    }

    private static List<RunEvent> run(LlmProvider provider, SessionGoal goal, SteeringInbox steering,
                                      Integer maxTurns) {
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(new ToolRegistry())
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .goal(goal)
                .steering(steering)
                .maxTurns(maxTurns)
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static RunEvent.GoalCheck clearedLine(List<RunEvent> events) {
        return events.stream().filter(RunEvent.GoalCheck.class::isInstance).map(RunEvent.GoalCheck.class::cast)
                .filter(line -> "cleared".equals(line.outcome())).findFirst().orElse(null);
    }

    private static void assertCleared(String message, String reason) {
        List<String> heard = new CopyOnWriteArrayList<>();
        SessionGoal goal = goal(heard);
        List<RunEvent> events = run(throwing(new RuntimeException(message)), goal, null, null);
        assertNull(goal.stated(), "the goal is still stated after: " + message);
        assertEquals(List.of(reason), heard);
        RunEvent.GoalCheck line = clearedLine(events);
        assertNotNull(line, "no chat line for: " + message);
        assertEquals("Goal cleared after an unrecoverable error (" + reason + ")", line.evidence());
        assertEquals("npm test", line.command());
    }

    private static void assertKept(LlmProvider provider, SteeringInbox steering, Integer maxTurns) {
        List<String> heard = new CopyOnWriteArrayList<>();
        SessionGoal goal = goal(heard);
        List<RunEvent> events = run(provider, goal, steering, maxTurns);
        assertEquals(STATED, goal.stated(), "the goal was cleared");
        assertTrue(heard.isEmpty(), "the host heard a clear: " + heard);
        assertNull(clearedLine(events));
    }

    @Test
    void aContextLimitErrorClearsTheGoal() {
        assertCleared("OpenAI-compatible server HTTP 400: This model's maximum context length is 32768 tokens",
                "context_limit");
    }

    @Test
    void anAuthenticationErrorClearsTheGoal() {
        assertCleared("OpenAI-compatible server HTTP 401: Incorrect API key provided", "authentication");
    }

    @Test
    void aBillingErrorClearsTheGoal() {
        assertCleared("OpenAI-compatible server HTTP 429: You exceeded your current quota, insufficient_quota",
                "billing");
    }

    @Test
    void aModelUnavailableErrorClearsTheGoal() {
        assertCleared("Ollama HTTP 404: model 'qwen9:404b' not found", "model_unavailable");
    }

    @Test
    void aTransientApiErrorDoesNotClearTheGoal() {
        assertKept(throwing(new TransientProviderException("OpenAI-compatible server HTTP 503: overloaded")),
                null, null);
    }

    @Test
    void aSteeringMessageDoesNotClearTheGoal() {
        SteeringInbox inbox = new SteeringInbox();
        AtomicInteger turn = new AtomicInteger();
        LlmProvider provider = request -> {
            if (turn.incrementAndGet() == 1) {
                inbox.submit("also look at the README");
            }
            return List.of(new LlmProvider.PTextDelta("ok"),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        };
        assertKept(provider, inbox, null);
        assertEquals(2, turn.get(), "premise: the steering sentence started a second turn");
    }

    @Test
    void theTurnCapDoesNotClearTheGoal() {
        LlmProvider forever = request -> List.of(new LlmProvider.PTextDelta("again"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.MAX_TOKENS));
        assertKept(request -> List.of(new LlmProvider.PToolCall("c", "missing_tool",
                        new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode()),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)), null, 2);
        assertKept(forever, null, 1);
    }

    @Test
    void anErrorWithoutAGoalWritesNoLine() {
        Agent agent = new Agent(AgentOptions.builder()
                .provider(throwing(new RuntimeException("OpenAI-compatible server HTTP 401: bad key")))
                .systemPrompt("test")
                .registry(new ToolRegistry())
                .cwd(Path.of("."))
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        assertNull(clearedLine(events));
        assertTrue(events.stream().anyMatch(RunEvent.ErrorEvent.class::isInstance));
    }
}
