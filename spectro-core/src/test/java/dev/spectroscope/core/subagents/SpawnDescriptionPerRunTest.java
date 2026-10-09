package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 490, criterion 6: the count is captured when a run starts, so the
 * spawn tools describe one number for the whole run. The tools come first in
 * every request and Anthropic caches the prefix up to the last tool; a
 * description that moved inside a run would throw that prefix away. A count
 * changed during a run reaches the descriptions of the next run.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SpawnDescriptionPerRunTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final class RecordingProvider implements LlmProvider {
        final Queue<List<ProviderEvent>> parentTurns = new ConcurrentLinkedQueue<>();
        final List<String> parentSpawnAgentsDescriptions = new CopyOnWriteArrayList<>();
        final AtomicReference<Runnable> whileTheChildRuns = new AtomicReference<>(() -> { });

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (request.system().contains("subagent")) {
                whileTheChildRuns.get().run();
                return List.of(new PTextDelta("child done"), new PStop(PStop.StopReason.END_TURN));
            }
            request.tools().stream().filter(spec -> spec.name().equals("spawn_agents"))
                    .forEach(spec -> parentSpawnAgentsDescriptions.add(spec.description()));
            return parentTurns.remove();
        }
    }

    private static List<LlmProvider.ProviderEvent> spawnOne() throws Exception {
        return List.of(new LlmProvider.PToolCall("c1", "spawn_agent",
                        JSON.readTree("{\"type\":\"explore\",\"task\":\"look\"}")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    private static List<LlmProvider.ProviderEvent> text(String text) {
        return List.of(new LlmProvider.PTextDelta(text),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    @Test
    void aCountChangedDuringARunReachesTheNextRunAndNotTheRestOfThisOne() throws Exception {
        RecordingProvider provider = new RecordingProvider();
        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of())
                .sessionsPerChat(3)
                .build(), 30_000);
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .sessionsPerChat(3)
                .build());
        provider.whileTheChildRuns.set(() -> parent.setSessionsPerChat(5));

        provider.parentTurns.add(spawnOne());
        provider.parentTurns.add(text("first run done"));
        try (EventStream stream = manager.run(parent, "go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(event -> { });
        }
        provider.parentTurns.add(text("second run done"));
        try (EventStream stream = manager.run(parent, "again", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(event -> { });
        }

        List<String> seen = provider.parentSpawnAgentsDescriptions;
        assertEquals(3, seen.size(), "premise: two requests in the first run, one in the second");
        assertEquals(seen.get(0), seen.get(1),
                "the description moved inside a run, which costs the cached prefix");
        assertTrue(seen.get(0).contains("at most 2 subagents"), seen.get(0));
        assertTrue(seen.get(2).contains("at most 4 subagents"),
                "the count set during the first run did not reach the second: " + seen.get(2));
    }
}
