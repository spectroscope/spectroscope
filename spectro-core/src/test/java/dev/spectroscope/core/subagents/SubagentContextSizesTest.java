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
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 593: a child built by the manager reports the sizes of its context
 * parts each turn and none of their texts; the parent keeps its texts.
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class SubagentContextSizesTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Parent and child scripts kept apart by system prompt: every role prompt
     *  of RoleCatalog says "subagent", the parent's here does not. */
    private static final class RoutingProvider implements LlmProvider {
        final Queue<List<ProviderEvent>> parentTurns = new ConcurrentLinkedQueue<>();
        final Queue<List<ProviderEvent>> childTurns = new ConcurrentLinkedQueue<>();

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

    private static List<ProviderEvent> textTurn(String text) {
        return List.of(new LlmProvider.PTextDelta(text),
                new LlmProvider.PUsage(5, 2),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    private static List<ProviderEvent> spawnTurn() {
        return List.of(new LlmProvider.PToolCall("c1", "spawn_agent",
                        json("""
                                {"type":"worker","task":"do the thing"}""")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    /** One parent run that spawns one child; the parent introspects with texts. */
    private static List<RunEvent> spawnOnce() {
        return spawnOnce(List.of(textTurn("child done")), null);
    }

    /** A child turn that calls report_status, which every child holds and
     *  which asks for no permission, so the child runs a second turn. */
    private static List<ProviderEvent> reportTurn() {
        return List.of(new LlmProvider.PToolCall("r1", "report_status",
                        json("""
                                {"message":"halfway"}""")),
                new LlmProvider.PUsage(5, 2),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    /** The child's id, from the spawn the parent's stream carries. */
    private static String childIdOf(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.AgentSpawn.class::isInstance)
                .map(RunEvent.AgentSpawn.class::cast)
                .map(RunEvent.AgentSpawn::agentId)
                .findFirst()
                .orElseThrow(() -> new AssertionError("a child really ran"));
    }

    /** One parent run that spawns one child with the given script.
     *  @param childScript the child's turns, in order
     *  @param window      the session window the manager hands its children
     *                     and the parent reads, or null for none */
    private static List<RunEvent> spawnOnce(List<List<ProviderEvent>> childScript,
                                            SessionWindow window) {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(spawnTurn());
        provider.parentTurns.add(textTurn("done"));
        provider.childTurns.addAll(childScript);

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
                .introspection(true)
                .sessionWindow(window)
                .build());

        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream =
                     manager.run(parent, "delegate it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static List<RunEvent.ContextInfo> infosOf(List<RunEvent> events, String agentId) {
        return events.stream()
                .filter(RunEvent.ContextInfo.class::isInstance)
                .map(RunEvent.ContextInfo.class::cast)
                .filter(info -> agentId.equals(info.agentId()))
                .toList();
    }

    @Test
    void aChildReportsItsPartSizesEachTurnWithoutTheirTexts() {
        List<RunEvent> events = spawnOnce();
        String childId = events.stream()
                .filter(RunEvent.AgentSpawn.class::isInstance)
                .map(RunEvent.AgentSpawn.class::cast)
                .map(RunEvent.AgentSpawn::agentId)
                .findFirst()
                .orElseThrow(() -> new AssertionError("a child really ran"));
        long childTurns = events.stream()
                .filter(RunEvent.TurnStart.class::isInstance)
                .map(RunEvent.TurnStart.class::cast)
                .filter(turn -> childId.equals(turn.agentId()))
                .count();
        assertTrue(childTurns >= 1, "the child ran at least one turn");

        List<RunEvent.ContextInfo> child = infosOf(events, childId);
        assertEquals(childTurns, child.size(), "one line per child turn");
        RunEvent.ContextInfo info = child.get(0);
        assertEquals(List.of("system prompt", "tool schemas", "conversation"),
                info.parts().stream().map(RunEvent.ContextPart::label).toList());
        for (RunEvent.ContextPart part : info.parts()) {
            assertNull(part.text(), "no text on " + part.label());
        }
        assertTrue(info.parts().get(0).chars() > 0, "the role prompt is counted");
        assertTrue(info.parts().get(2).chars() > 0, "the task is counted");
        assertEquals(info.parts().stream().mapToInt(RunEvent.ContextPart::estTokens).sum(),
                info.estimatedTokens(), "the estimate is the sum of its parts");
        assertNotNull(info.thresholdSource(), "the threshold and its source ride as on the parent");
    }

    @Test
    void theParentKeepsItsTexts() {
        List<RunEvent.ContextInfo> parent = infosOf(spawnOnce(), "main");
        assertEquals(2, parent.size(), "one line per parent turn");
        String system = parent.get(0).parts().get(0).text();
        assertNotNull(system, "the main agent's parts carry their texts");
        assertTrue(system.startsWith("You are the parent."), system);
    }

    @Test
    void aChildFrameNamesTheWindowItInheritsWithItsSourceAndThreshold() {
        // The provider here states no window, so a child that missed the
        // holder would derive the fallback: source "fallback", no window.
        SessionWindow window = new SessionWindow();
        window.set(512_000);

        List<RunEvent> events = spawnOnce(List.of(textTurn("child done")), window);

        RunEvent.ContextInfo child = infosOf(events, childIdOf(events)).get(0);
        assertEquals("window_override", child.thresholdSource(), "the source word of the set window");
        assertEquals(512_000, child.contextWindow(), "the child divides by the window it inherited");
        assertEquals(358_400, child.threshold(), "the threshold that window gives");
        RunEvent.ContextInfo parent = infosOf(events, "main").get(0);
        assertEquals(parent.threshold(), child.threshold(), "parent and child read one holder");
    }

    @Test
    void aChildWithATwoTurnRunReportsOneFramePerTurn() {
        List<RunEvent> events = spawnOnce(List.of(reportTurn(), textTurn("child done")), null);
        String childId = childIdOf(events);
        List<Integer> turns = events.stream()
                .filter(RunEvent.TurnStart.class::isInstance)
                .map(RunEvent.TurnStart.class::cast)
                .filter(turn -> childId.equals(turn.agentId()))
                .map(RunEvent.TurnStart::turn)
                .toList();
        assertEquals(List.of(1, 2), turns, "premise: the child ran two turns");

        List<RunEvent.ContextInfo> child = infosOf(events, childId);
        assertEquals(turns, child.stream().map(RunEvent.ContextInfo::turn).toList(),
                "one frame per turn, each naming its own turn");
        assertTrue(child.get(1).messages() > child.get(0).messages(),
                "the second frame counts the tool call and its result");
        assertTrue(child.get(1).parts().get(2).chars() > child.get(0).parts().get(2).chars(),
                "the conversation part grows with the history");
        for (RunEvent.ContextInfo info : child) {
            for (RunEvent.ContextPart part : info.parts()) {
                assertNull(part.text(), "no text on " + part.label() + " in turn " + info.turn());
            }
        }
    }

    @Test
    void aChildFrameOnTheWireHasNoTextKeyAndTheParentFrameHasOne() throws Exception {
        List<RunEvent> events = spawnOnce();

        JsonNode child = JSON.readTree(JSON.writeValueAsString(infosOf(events, childIdOf(events)).get(0)));
        assertEquals(3, child.path("parts").size(), "premise: the child frame has its three parts");
        for (JsonNode part : child.path("parts")) {
            assertTrue(part.has("chars") && part.has("estTokens"), "the sizes ride: " + part);
            assertFalse(part.has("text"), "no text key on the wire: " + part);
        }
        JsonNode parent = JSON.readTree(JSON.writeValueAsString(infosOf(events, "main").get(0)));
        for (JsonNode part : parent.path("parts")) {
            assertTrue(part.has("text"), "the main agent's part keeps its text key: " + part);
        }
    }
}
