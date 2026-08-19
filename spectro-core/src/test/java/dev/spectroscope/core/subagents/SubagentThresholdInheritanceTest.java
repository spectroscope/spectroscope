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
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 263, AC 3, applied to the TREE: an explicit {@code compactionThreshold}
 * is the operator's instruction, and it has to reach the children too.
 *
 * <p>The review found it did not. The child's {@code AgentOptions} chain set
 * provider, prompt, registry, permission, hooks, wire, latency, cwd and the two
 * ids, and nothing else — so a parent pinned to 5,000 on the owner's backend
 * spawned children that derived 153,216 from the same provider. A 30x
 * divergence from a stated instruction, and an invisible one: children are
 * built without introspection, so no {@code context_info} of theirs ever says
 * what they were compacting at.</p>
 *
 * <p>What is observable from outside is the CONSEQUENCE of the override
 * arriving: a run that has one never asks the backend for a window, because the
 * answer could not change anything. So the count of capability questions across
 * a spawn is the measurement — it is 1 (the parent's own) when nothing is set,
 * and 0 when the operator has spoken.</p>
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class SubagentThresholdInheritanceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Parent and child scripts kept apart by system prompt, plus a count of
     *  every capability question either of them asked. */
    private static final class CountingRoutingProvider implements LlmProvider {
        final Queue<List<ProviderEvent>> parentTurns = new ConcurrentLinkedQueue<>();
        final Queue<List<ProviderEvent>> childTurns = new ConcurrentLinkedQueue<>();
        final AtomicInteger windowQuestions = new AtomicInteger();

        @Override
        public int contextWindow() {
            windowQuestions.incrementAndGet();
            return 204_288;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            boolean isChild = request.system().contains("subagent");
            List<ProviderEvent> turn = (isChild ? childTurns : parentTurns).poll();
            if (turn == null) {
                throw new IllegalStateException("no scripted turn left (child=" + isChild + ")");
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

    private static List<LlmProvider.ProviderEvent> textTurn(String text) {
        return List.of(new LlmProvider.PTextDelta(text),
                new LlmProvider.PUsage(5, 2),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    private static List<LlmProvider.ProviderEvent> spawnTurn() {
        return List.of(new LlmProvider.PToolCall("c1", "spawn_agent",
                        json("""
                                {"type":"worker","task":"do the thing"}""")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    /** One parent run that spawns exactly one child, both scripted. */
    private static List<RunEvent> spawnOnce(CountingRoutingProvider provider,
                                            Integer compactionThreshold) {
        provider.parentTurns.add(spawnTurn());
        provider.parentTurns.add(textTurn("done"));
        provider.childTurns.add(textTurn("child done"));

        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of())
                .compactionThreshold(compactionThreshold)
                .build());
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .compactionThreshold(compactionThreshold)
                .build());

        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream =
                     manager.run(parent, "delegate it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    @Test
    void aChildRunAsksTheBackendForAWindowWhenNoOneHasSetAThreshold() {
        // The baseline, so the assertion below cannot be green for the wrong
        // reason: the child DOES enter runLoop and DOES derive its threshold —
        // one question for the parent's run, one for the child's.
        CountingRoutingProvider provider = new CountingRoutingProvider();

        List<RunEvent> events = spawnOnce(provider, null);

        assertTrue(events.stream().anyMatch(RunEvent.AgentSpawn.class::isInstance),
                "a child really ran");
        assertEquals(2, provider.windowQuestions.get(),
                "one derivation for the parent's run, one for the child's");
    }

    @Test
    void anOperatorsThresholdGovernsTheChildrenToo() {
        // With the number carried down, neither run has anything to ask: the
        // override decides on its own. Before this pass the child ignored the
        // parent's 5,000 entirely and derived 153,216 from the shared provider.
        CountingRoutingProvider provider = new CountingRoutingProvider();

        List<RunEvent> events = spawnOnce(provider, 5_000);

        assertTrue(events.stream().anyMatch(RunEvent.AgentSpawn.class::isInstance),
                "a child really ran");
        assertEquals(0, provider.windowQuestions.get(),
                "an override reaching parent AND child leaves nothing to ask");
    }

    @Test
    void theConfigCarriesTheNumberByNameAndDefaultsItToUnset() {
        SubagentConfig set = SubagentConfig.builder()
                .provider(request -> List.of())
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .compactionThreshold(5_000)
                .build();
        assertEquals(5_000, set.compactionThreshold());

        SubagentConfig unset = SubagentConfig.builder()
                .provider(request -> List.of())
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .build();
        assertNull(unset.compactionThreshold(),
                "unset stays unset — the children then derive it, as they did before");
    }
}
