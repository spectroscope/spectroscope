package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.SessionWindow;
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
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 390, owner call 8 (default taken): the children of a session run on the
 * window the operator set for it. They share the parent's backend, so the
 * window the operator stated is theirs too.
 *
 * <p>Children run without introspection and emit no {@code context_info}, so
 * the measurement is the one {@code SubagentThresholdInheritanceTest} uses: a
 * run whose window is decided asks the backend nothing. With no session window
 * the parent's run and the child's run ask once each; with one, neither asks.
 * A child that did not get the holder would ask once, and the count would be
 * 1.</p>
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class SubagentSessionWindowTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Parent and child scripts kept apart by system prompt, plus a count of
     *  every window question either of them asked. */
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

    private static List<LlmProvider.ProviderEvent> textTurn(String text) {
        return List.of(new LlmProvider.PTextDelta(text),
                new LlmProvider.PUsage(5, 2),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    private static List<LlmProvider.ProviderEvent> spawnTurn() {
        try {
            return List.of(new LlmProvider.PToolCall("c1", "spawn_agent",
                            JSON.readTree("{\"type\":\"worker\",\"task\":\"do the thing\"}")),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
        } catch (Exception failure) {
            throw new AssertionError(failure);
        }
    }

    /** One parent run that spawns exactly one child, both scripted, both
     *  handed the same session window holder the way a face hands it. */
    private static List<RunEvent> spawnOnce(CountingRoutingProvider provider, SessionWindow window) {
        provider.parentTurns.add(spawnTurn());
        provider.parentTurns.add(textTurn("done"));
        provider.childTurns.add(textTurn("child done"));

        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of())
                .sessionWindow(window)
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
                .sessionWindow(window)
                .build());

        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream =
                     manager.run(parent, "delegate it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    @Test
    void withNoSessionWindowTheParentAndTheChildEachAskOnce() {
        // The baseline, so the count below cannot be zero for the wrong reason.
        CountingRoutingProvider provider = new CountingRoutingProvider();

        List<RunEvent> events = spawnOnce(provider, new SessionWindow());

        assertTrue(events.stream().anyMatch(RunEvent.AgentSpawn.class::isInstance),
                "test premise: a child really ran");
        assertEquals(2, provider.windowQuestions.get(), "one run each, one question each");
    }

    @Test
    void aSessionWindowReachesTheChildrenSoNobodyAsks() {
        CountingRoutingProvider provider = new CountingRoutingProvider();
        SessionWindow window = new SessionWindow();
        window.set(512_000);

        List<RunEvent> events = spawnOnce(provider, window);

        assertTrue(events.stream().anyMatch(RunEvent.AgentSpawn.class::isInstance),
                "test premise: a child really ran");
        assertEquals(0, provider.windowQuestions.get(),
                "the parent and the child both read the operator's window; a child"
                        + " without the holder would have asked once");
    }

    @Test
    void theConfigCarriesTheHolderByNameAndTheOldArityCarriesNone() {
        SessionWindow window = new SessionWindow();
        SubagentConfig set = SubagentConfig.builder()
                .provider(request -> List.of())
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .sessionWindow(window)
                .build();
        assertSame(window, set.sessionWindow());

        SubagentConfig compat = new SubagentConfig(request -> List.of(), Path.of("."), "main",
                request -> true, List.of(), null, null, null, null, null, null, null, null, null);
        assertNull(compat.sessionWindow(), "the pre-390 arity sets nothing");
    }
}
