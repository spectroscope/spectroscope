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

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 558, criterion 1: the agents of the picked playbook are available in a
 * plain chat. One parent tool, {@code spawn_named_agent}, starts one child
 * as a named agent: the child type and the preamble come from the agent file,
 * the task from the model, composed as the role tools compose theirs. The tool
 * is offered only while the session has an agent, and reads the list at call
 * time.
 */
class NamedAgentToolTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final SubagentManager.NamedAgent REVIEWER = new SubagentManager.NamedAgent(
            "reviewer", "Reviews a diff against the house rules", "explore", "You review diffs. Name every finding.");

    /** Routes by system prompt like SubagentManagerTest and keeps every child prompt. */
    private static final class Routing implements LlmProvider {
        final Queue<List<ProviderEvent>> parentTurns = new ConcurrentLinkedQueue<>();
        final Queue<List<ProviderEvent>> childTurns = new ConcurrentLinkedQueue<>();
        final List<String> childSystems = new CopyOnWriteArrayList<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            boolean child = request.system().contains("subagent");
            if (child) {
                childSystems.add(request.system());
            }
            List<ProviderEvent> turn = (child ? childTurns : parentTurns).poll();
            if (turn == null) {
                throw new IllegalStateException("no scripted turn left (child=" + child + ")");
            }
            return turn;
        }
    }

    private static List<LlmProvider.ProviderEvent> text(String text) {
        return List.of(new LlmProvider.PTextDelta(text), new LlmProvider.PUsage(5, 2),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    private static List<LlmProvider.ProviderEvent> call(String name, String input) throws Exception {
        return List.of(new LlmProvider.PToolCall("c1", name, JSON.readTree(input)),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    private static Tool readTool(String name) {
        return new Tool() {
            public String name() { return name; }
            public String description() { return "fake"; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return "ok"; }
        };
    }

    private static SubagentManager manager(LlmProvider provider) {
        return new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of(readTool("list_dir"), readTool("read_file"), readTool("write_file")))
                .build(), 30_000);
    }

    @Test
    void theToolIsOfferedOnlyWhileTheSessionHasAnAgentAndNamesThem() {
        AtomicReference<List<SubagentManager.NamedAgent>> agents = new AtomicReference<>(List.of());
        Tool tool = manager(new Routing()).namedAgentTool(agents::get);

        assertEquals("spawn_named_agent", tool.name());
        assertFalse(tool.offeredIn(Path.of(".")), "offered with no agent to start");

        agents.set(List.of(REVIEWER));

        assertTrue(tool.offeredIn(Path.of(".")));
        assertTrue(tool.description().contains("reviewer (explore): Reviews a diff against the house rules"),
                tool.description());
        assertFalse(tool.needsPermission(), "the child's own calls pass the gate, as for the role tools");
        assertFalse(tool.resultRepeatable());
    }

    @Test
    void itStartsOneChildOfTheAgentsTypeOnThePreambleAndTheTask() throws Exception {
        Routing provider = new Routing();
        provider.parentTurns.add(call("spawn_named_agent", "{\"agent\":\"reviewer\",\"task\":\"Check the diff\"}"));
        provider.parentTurns.add(text("Reviewed."));
        provider.childTurns.add(text("two findings"));
        SubagentManager manager = manager(provider);
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        registry.register(manager.namedAgentTool(() -> List.of(REVIEWER)));
        Agent parent = new Agent(AgentOptions.builder().provider(provider).systemPrompt("You are the parent.")
                .registry(registry).cwd(Path.of(".")).agentId("main").onPermission(request -> true).build());

        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = manager.run(parent, "Review it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }

        RunEvent.RunStart childStart = events.stream().filter(RunEvent.RunStart.class::isInstance)
                .map(RunEvent.RunStart.class::cast).filter(s -> !"main".equals(s.agentId())).findFirst().orElseThrow();
        assertEquals("explore-1", childStart.agentId(), "the type comes from the agent file");
        assertEquals(SubagentManager.roleTask(REVIEWER.preamble(), "Check the diff"), childStart.prompt());
        RunEvent.AgentMessage task = events.stream().filter(RunEvent.AgentMessage.class::isInstance)
                .map(RunEvent.AgentMessage.class::cast).filter(m -> "task".equals(m.role())).findFirst().orElseThrow();
        assertEquals("reviewer", task.label());
        assertEquals("Check the diff", task.text());
        RunEvent.ToolResult result = events.stream().filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast).filter(r -> "main".equals(r.agentId())).findFirst().orElseThrow();
        assertTrue(result.output().contains("two findings"), result.output());
        assertTrue(provider.childSystems.getFirst().contains("type explore"));
    }

    @Test
    void anUnknownAgentOrABlankTaskIsRefusedAndStartsNothing() throws Exception {
        Tool tool = manager(new Routing()).namedAgentTool(() -> List.of(REVIEWER));
        Tool.ToolContext context = new Tool.ToolContext(Path.of("."), new CancelSignal());

        String unknown = tool.execute(JSON.readTree("{\"agent\":\"writer\",\"task\":\"x\"}"), context);
        assertTrue(unknown.startsWith("ERROR:") && unknown.contains("reviewer"), unknown);
        String blank = tool.execute(JSON.readTree("{\"agent\":\"reviewer\",\"task\":\"  \"}"), context);
        assertTrue(blank.startsWith("ERROR:"), blank);
    }
}
