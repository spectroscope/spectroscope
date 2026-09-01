package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 364, criterion 1, for the face nobody could see: a child agent.
 *
 * <p>A child is an {@link Agent} like any other, built in
 * {@code SubagentManager.executeChild}. Until this card that builder chain
 * passed neither ceiling, so every delegated piece of work ran on
 * {@code Agent.DEFAULT_MAX_TURNS} and {@code Agent.DEFAULT_MAX_TOKENS} no
 * matter what the settings page said — and a child is exactly where nobody
 * would notice, because its {@code run_end} is folded into the parent's stream
 * and the parent only ever reads its last words.</p>
 *
 * <p>Reasoning visibility rides with them, for the reason card 263 carries the
 * compaction threshold down: an operator who turned it on meant it for the
 * tree, and a child's events are merged into the very stream they turned it on
 * to watch.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SubagentReachTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Parent turns are scripted; the child loops until something stops it. */
    private static final class ParentThenRelentlessChild implements LlmProvider {
        final Queue<List<ProviderEvent>> parentTurns = new ConcurrentLinkedQueue<>();
        final List<Integer> childBudgets = new CopyOnWriteArrayList<>();
        final List<ProviderRequest.Reasoning> childReasoning = new CopyOnWriteArrayList<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (request.system().contains("subagent")) {
                childBudgets.add(request.maxTokens());
                childReasoning.add(request.reasoning());
                if (request.signal() != null && request.signal().isCancelled()) {
                    return List.of(new PStop(PStop.StopReason.ABORTED));
                }
                return List.of(
                        new PToolCall("k" + childBudgets.size(), "list_dir",
                                JSON.createObjectNode().put("path", ".")),
                        new PStop(PStop.StopReason.TOOL_USE));
            }
            List<ProviderEvent> turn = parentTurns.poll();
            if (turn == null) {
                throw new IllegalStateException("no scripted parent turn left");
            }
            return turn;
        }
    }

    private static JsonNode json(String content) {
        try {
            return JSON.readTree(content);
        } catch (Exception failure) {
            throw new AssertionError(failure);
        }
    }

    /** A harmless tool for the child's belt — the child only needs something to call. */
    private static Tool fakeTool(String name) {
        return new Tool() {
            public String name() {
                return name;
            }

            public String description() {
                return "fake";
            }

            public JsonNode inputSchema() {
                return JSON.createObjectNode();
            }

            public boolean needsPermission() {
                return false;
            }

            public String execute(JsonNode input, ToolContext context) {
                return "ok";
            }
        };
    }

    /** One parent turn that spawns a single explore child, then one that ends. */
    private static ParentThenRelentlessChild scriptedParent() {
        ParentThenRelentlessChild provider = new ParentThenRelentlessChild();
        provider.parentTurns.add(List.of(
                new LlmProvider.PToolCall("c1", "spawn_agent",
                        json("{\"type\":\"explore\",\"task\":\"Explore src/\"}")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        provider.parentTurns.add(List.of(
                new LlmProvider.PTextDelta("done"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        return provider;
    }

    private static List<RunEvent> runOneChild(ParentThenRelentlessChild provider,
                                              SubagentConfig config) {
        SubagentManager manager = new SubagentManager(config, 30_000);
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = manager.run(parent, "Delegate",
                new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static SubagentConfig.Builder childConfig(LlmProvider provider) {
        return SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of(fakeTool("list_dir"), fakeTool("read_file")));
    }

    @Test
    void aChildStopsAtTheCeilingItsParentWasConfiguredWith() {
        ParentThenRelentlessChild provider = scriptedParent();

        List<RunEvent> events = runOneChild(provider, childConfig(provider).maxTurns(3).build());

        long childTurns = events.stream()
                .filter(RunEvent.TurnStart.class::isInstance)
                .map(RunEvent.TurnStart.class::cast)
                .filter(turn -> !"main".equals(turn.agentId()))
                .count();
        assertEquals(3, childTurns,
                "the child ran past the ceiling the operator typed. A child is the face"
                        + " nobody watches: its run_end is folded into the parent's stream"
                        + " and the parent reads only its last words, so an ignored ceiling"
                        + " here is invisible AND expensive");
        assertTrue(events.stream().anyMatch(RunEvent.AgentSpawn.class::isInstance),
                "the premise: a child was actually spawned");
    }

    @Test
    void aChildsProviderCallCarriesTheConfiguredCompletionBudget() {
        ParentThenRelentlessChild provider = scriptedParent();

        runOneChild(provider, childConfig(provider).maxTurns(2).maxTokens(4321).build());

        assertEquals(List.of(4321, 4321), provider.childBudgets,
                "a child spent a completion budget nobody typed — the builder method that"
                        + " sets it had zero callers anywhere before this card");
    }

    @Test
    void aChildAsksForReasoningExactlyWhenItsParentDoes() {
        ParentThenRelentlessChild provider = scriptedParent();

        runOneChild(provider, childConfig(provider).maxTurns(1).thinking(true).build());

        assertEquals(List.of(LlmProvider.ProviderRequest.Reasoning.ON), provider.childReasoning,
                "the operator turned reasoning on and the children of that session kept"
                        + " asking for the provider's default — the same shape as the two"
                        + " ceilings, found by the same source-derived count");
    }

    @Test
    void aChildLeftUnconfiguredStillRunsOnTheHarnessOwnDefaults() {
        // The nullable half of the seam, and it is not decoration: SubagentConfig
        // keeps two compatibility constructors that pass null for all three, so
        // "unset" has to go on meaning what it meant before this card — the
        // harness's own numbers — rather than meaning zero.
        ParentThenRelentlessChild provider = scriptedParent();

        runOneChild(provider, childConfig(provider).maxTurns(2).build());

        assertEquals(List.of(Agent.DEFAULT_MAX_TOKENS, Agent.DEFAULT_MAX_TOKENS),
                provider.childBudgets,
                "an unset completion budget stopped meaning the harness default");
        assertEquals(List.of(LlmProvider.ProviderRequest.Reasoning.DEFAULT,
                        LlmProvider.ProviderRequest.Reasoning.DEFAULT),
                provider.childReasoning,
                "an unset thinking flag stopped meaning the provider's default");
    }
}
