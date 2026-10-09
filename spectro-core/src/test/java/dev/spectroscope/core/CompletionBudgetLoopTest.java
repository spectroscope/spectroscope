package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.CompactionThreshold;
import dev.spectroscope.core.session.SessionWindow;
import dev.spectroscope.core.subagents.SubagentConfig;
import dev.spectroscope.core.subagents.SubagentManager;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 488 in the loop: the completion budget each turn request carries.
 *
 * <p>Three things the wire test cannot show, because it runs one fixed window
 * per run with no children: the clamp is decided again on every turn, so a
 * session window set while the run works reaches the next request; a child
 * agent runs its own loop and is clamped by its own derivation; and a turn
 * whose input has already passed the threshold is held to what the window has
 * left after that input.</p>
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class CompletionBudgetLoopTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Scripted turns, a fixed loaded window and every request it was sent. */
    private static final class RecordingProvider implements LlmProvider {
        private final int window;
        private final Function<ProviderRequest, List<ProviderEvent>> script;
        final List<ProviderRequest> requests = Collections.synchronizedList(new ArrayList<>());

        RecordingProvider(int window, Function<ProviderRequest, List<ProviderEvent>> script) {
            this.window = window;
            this.script = script;
        }

        @Override
        public int contextWindow() {
            return window;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            return script.apply(request);
        }
    }

    /** A permissionless tool whose output is set per test. */
    private static Tool tool(String name, Function<JsonNode, String> output) {
        return new Tool() {
            public String name() {
                return name;
            }

            public String description() {
                return "returns a scripted output";
            }

            public JsonNode inputSchema() {
                return JSON.createObjectNode().put("type", "object");
            }

            public boolean needsPermission() {
                return false;
            }

            public String execute(JsonNode input, ToolContext context) {
                return output.apply(input);
            }
        };
    }

    private static List<LlmProvider.ProviderEvent> toolTurn(String id, String name, int reportedInput) {
        return List.of(new LlmProvider.PToolCall(id, name, JSON.createObjectNode()),
                new LlmProvider.PUsage(reportedInput, 3),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    private static List<LlmProvider.ProviderEvent> answer(String text, int reportedInput) {
        return List.of(new LlmProvider.PTextDelta(text),
                new LlmProvider.PUsage(reportedInput, 3),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    private static List<RunEvent> run(Agent agent) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("do it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static Agent agent(LlmProvider provider, ToolRegistry registry, SessionWindow window) {
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .sessionWindow(window)
                .build());
    }

    @Test
    void aSessionWindowSetDuringTheRunReachesTheNextTurnsBudget() {
        // The backend states no window and names no model, so the first turn
        // knows nothing and keeps the configured budget. The operator sets
        // 8,192 on the ring while the tool runs; the next request is clamped.
        SessionWindow window = new SessionWindow();
        ToolRegistry registry = new ToolRegistry();
        registry.register(tool("noop", input -> {
            window.set(8_192);
            return "done";
        }));
        int[] turn = {0};
        RecordingProvider provider = new RecordingProvider(0,
                request -> ++turn[0] == 1 ? toolTurn("c1", "noop", 50) : answer("ok", 60));

        List<RunEvent> events = run(agent(provider, registry, window));

        assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.RunEnd), "premise: the run ended");
        assertEquals(2, provider.requests.size(), "premise: two turns");
        assertEquals(Agent.DEFAULT_MAX_TOKENS, provider.requests.get(0).maxTokens(),
                "first turn: no window is known yet");
        assertEquals(2_458, provider.requests.get(1).maxTokens(),
                "second turn: 8,192 minus its threshold of 5,734, read at the top of that turn");
    }

    @Test
    void aChildAgentIsClampedByItsOwnDerivation() {
        // The child never sees the parent's derivation: it asks the backend for
        // its window in its own loop, as SubagentSessionWindowTest counts. The
        // backend says 8,192, so both requests of both agents carry 2,458.
        int[] parentTurn = {0};
        RecordingProvider provider = new RecordingProvider(8_192, request -> {
            if (request.system().contains("subagent")) {
                return answer("child done", 40);
            }
            if (++parentTurn[0] == 1) {
                try {
                    return List.of(new LlmProvider.PToolCall("c1", "spawn_agent",
                                    JSON.readTree("{\"type\":\"worker\",\"task\":\"do the thing\"}")),
                            new LlmProvider.PUsage(40, 3),
                            new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
                } catch (Exception failure) {
                    throw new AssertionError(failure);
                }
            }
            return answer("done", 60);
        });
        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of())
                .build());
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = agent(provider, registry, new SessionWindow());

        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = manager.run(parent, "delegate it",
                new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }

        assertTrue(events.stream().anyMatch(RunEvent.AgentSpawn.class::isInstance),
                "premise: a child really ran");
        List<LlmProvider.ProviderRequest> child = provider.requests.stream()
                .filter(r -> r.system().contains("subagent")).toList();
        List<LlmProvider.ProviderRequest> parentRequests = provider.requests.stream()
                .filter(r -> !r.system().contains("subagent")).toList();
        assertFalse(child.isEmpty(), "premise: the child sent a request");
        assertEquals(2, parentRequests.size(), "premise: the parent spawned, then answered");
        for (LlmProvider.ProviderRequest request : child) {
            assertEquals(2_458, request.maxTokens(), "the child's request");
        }
        for (LlmProvider.ProviderRequest request : parentRequests) {
            assertEquals(2_458, request.maxTokens(), "the parent's request");
        }
    }

    @Test
    void aTurnWhoseInputPassedTheThresholdGetsWhatTheWindowHasLeft() {
        // One tool result of 24,000 characters pushes the second request well
        // past the 5,734 threshold of an 8,192 window. Compaction only runs at
        // the start of the turn after, so this request is the one that would
        // overshoot with the reserve alone.
        ToolRegistry registry = new ToolRegistry();
        registry.register(tool("big", input -> "x".repeat(24_000)));
        int[] turn = {0};
        RecordingProvider provider = new RecordingProvider(8_192,
                request -> ++turn[0] == 1 ? toolTurn("c1", "big", 1) : answer("ok", 30));

        run(agent(provider, registry, new SessionWindow()));

        assertEquals(2, provider.requests.size(), "premise: two turns, no compaction between");
        LlmProvider.ProviderRequest first = provider.requests.get(0);
        LlmProvider.ProviderRequest second = provider.requests.get(1);
        assertEquals(2_458, first.maxTokens(), "a small first request: the reserve decides");

        long chars = Agent.requestChars(second.system(), second.tools(), second.messages());
        int estimate = CompactionThreshold.inputEstimate(chars,
                Agent.requestChars(first.system(), first.tools(), first.messages()), 1);
        assertTrue(estimate > 5_734, "premise: the input passed the threshold, estimate " + estimate);
        assertEquals(8_192 - estimate, second.maxTokens(),
                "the completion gets what the window leaves after the input");
    }

    @Test
    void theBackendsOwnCountRaisesTheEstimate() {
        // A backend whose tokenizer counts twice what chars/4 says: the first
        // request is reported at twice its estimate, so the second is held to
        // the same density.
        ToolRegistry registry = new ToolRegistry();
        registry.register(tool("big", input -> "x".repeat(12_500)));
        List<LlmProvider.ProviderRequest> seen = new ArrayList<>();
        RecordingProvider provider = new RecordingProvider(8_192, request -> {
            seen.add(request);
            if (seen.size() == 1) {
                int doubled = (int) (2 * ((Agent.requestChars(request.system(), request.tools(),
                        request.messages()) + 3) / 4));
                return toolTurn("c1", "big", doubled);
            }
            return answer("ok", 30);
        });

        run(agent(provider, registry, new SessionWindow()));

        LlmProvider.ProviderRequest first = provider.requests.get(0);
        LlmProvider.ProviderRequest second = provider.requests.get(1);
        long firstChars = Agent.requestChars(first.system(), first.tools(), first.messages());
        long secondChars = Agent.requestChars(second.system(), second.tools(), second.messages());
        int reported = (int) (2 * ((firstChars + 3) / 4));
        int calibrated = CompactionThreshold.inputEstimate(secondChars, firstChars, reported);
        int plain = CompactionThreshold.inputEstimate(secondChars, 0, 0);
        assertTrue(calibrated > plain + 2_000, "premise: the backend's density moves the estimate");
        assertTrue(calibrated > 5_734 && calibrated < 8_192 - 512,
                "premise: the input passed the threshold but not the floor, " + calibrated);
        assertEquals(8_192 - calibrated, second.maxTokens());
    }
}
