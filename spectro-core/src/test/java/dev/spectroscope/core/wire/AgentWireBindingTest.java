package dev.spectroscope.core.wire;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.subagents.SubagentConfig;
import dev.spectroscope.core.subagents.SubagentManager;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.wire.LlmWireRecorder.ExchangeMeta;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Leg C of the llm-wire record (card 184): the agent loop hands the tap down.
 * A scripted provider walks one full exchange through every tap it receives,
 * exactly like a real provider would; the recorder's per-exchange metadata then
 * proves WHO was bound: the right agentId, the same turn number turn_start
 * carries, kind "chat" for plain calls and "compaction" for the summarizer.
 * No recorder means no tap, and the run is untouched.
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class AgentWireBindingTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path dir;

    /**
     * Routes scripted turns like SubagentManagerTest's RoutingProvider (child
     * system prompts contain "subagent") and, when a request carries a tap,
     * records one begin/line/end exchange through it, the leg B contract.
     */
    private static final class TappingProvider implements LlmProvider {
        final Queue<List<ProviderEvent>> parentTurns = new ConcurrentLinkedQueue<>();
        final Queue<List<ProviderEvent>> childTurns = new ConcurrentLinkedQueue<>();
        final List<ProviderRequest> requests = Collections.synchronizedList(new ArrayList<>());

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            if (request.tap() != null) {
                LlmWireTap.Exchange exchange = request.tap().begin(new LlmWireTap.WireRequest(
                        "fake", "fake-model", "http", "POST", "http://fake.local/v1/chat",
                        Map.of("content-type", "application/json"), "bytes",
                        "{\"messages\":" + request.messages().size() + "}",
                        System.currentTimeMillis()));
                exchange.line("data: {\"delta\":\"ok\"}");
                exchange.end(new LlmWireTap.WireOutcome(200, "bytes", null, false, null,
                        System.currentTimeMillis()));
            }
            boolean child = request.system().contains("subagent");
            List<ProviderEvent> turn = (child ? childTurns : parentTurns).poll();
            if (turn == null) {
                throw new IllegalStateException("no scripted turn left (child=" + child + ")");
            }
            return turn;
        }
    }

    /** A permissionless echo tool so scripted tool turns have something to run. */
    private static Tool echoTool() {
        return new Tool() {
            public String name() { return "echo"; }
            public String description() { return "echoes"; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return "ok"; }
        };
    }

    private static List<LlmProvider.ProviderEvent> textTurn(String text) {
        return List.of(new LlmProvider.PTextDelta(text),
                new LlmProvider.PUsage(5, 2),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    /** One echo tool call; inputTokens feeds the loop's compaction trigger. */
    private static List<LlmProvider.ProviderEvent> toolTurn(String callId, int inputTokens) {
        return List.of(
                new LlmProvider.PToolCall(callId, "echo", JSON.createObjectNode().put("value", callId)),
                new LlmProvider.PUsage(inputTokens, 2),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    /** A real recorder onto a temp sidecar, metas collected through onExchange. */
    private LlmWireRecorder recorder(List<ExchangeMeta> metas) {
        LlmWireRecorder recorder = new LlmWireRecorder(
                dir.resolve("session.llm.jsonl"), LlmWireRecorder.DEFAULT_CEILING_BYTES);
        recorder.onExchange(metas::add);
        return recorder;
    }

    private static Agent agent(TappingProvider provider, LlmWireRecorder recorder,
                               Integer compactionThreshold) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(echoTool());
        AgentOptions.Builder builder = AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true);
        if (recorder != null) {
            builder.llmWire(recorder);
        }
        if (compactionThreshold != null) {
            builder.compactionThreshold(compactionThreshold);
        }
        return new Agent(builder.build());
    }

    private static List<RunEvent> collect(Agent agent, String prompt) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run(prompt, new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    @Test
    void everyChatCallIsBoundToItsAgentAndTurn() {
        TappingProvider provider = new TappingProvider();
        provider.parentTurns.add(toolTurn("c1", 50));
        provider.parentTurns.add(textTurn("done"));
        List<ExchangeMeta> metas = Collections.synchronizedList(new ArrayList<>());

        collect(agent(provider, recorder(metas), null), "do it");

        assertEquals(2, metas.size(), "one exchange per provider call");
        assertEquals("main", metas.get(0).agentId());
        assertEquals(1, metas.get(0).turn());
        assertEquals("chat", metas.get(0).kind());
        assertEquals("main", metas.get(1).agentId());
        assertEquals(2, metas.get(1).turn());
        assertEquals("chat", metas.get(1).kind());
        assertTrue(provider.requests.stream().allMatch(request -> request.tap() != null),
                "every provider call must carry a tap when a recorder is configured");
    }

    @Test
    void theCompactionCallBindsItsOwnKindOnTheSameTurn() {
        TappingProvider provider = new TappingProvider();
        // Three tool rounds inflate the history past keep + 2 messages while the
        // usage events hold the trigger over the threshold; turn 4 then compacts
        // (the summarizer pops the fourth scripted turn) and answers normally.
        provider.parentTurns.add(toolTurn("c1", 100));
        provider.parentTurns.add(toolTurn("c2", 100));
        provider.parentTurns.add(toolTurn("c3", 100));
        provider.parentTurns.add(textTurn("summary of everything so far"));
        provider.parentTurns.add(textTurn("done"));
        List<ExchangeMeta> metas = Collections.synchronizedList(new ArrayList<>());

        List<RunEvent> events = collect(agent(provider, recorder(metas), 10), "do it");

        assertTrue(events.stream().anyMatch(event -> event instanceof RunEvent.Compaction),
                "the scripted run must actually compact");
        assertEquals(List.of("chat", "chat", "chat", "compaction", "chat"),
                metas.stream().map(ExchangeMeta::kind).toList());
        ExchangeMeta compaction = metas.get(3);
        assertEquals("main", compaction.agentId());
        assertEquals(4, compaction.turn(), "the summarizer is bound to the turn that triggered it");
        assertEquals(4, metas.get(4).turn(), "the turn's own chat call follows on the same turn");
    }

    @Test
    void withoutARecorderEveryRequestStaysTapFree() {
        TappingProvider provider = new TappingProvider();
        provider.parentTurns.add(toolTurn("c1", 50));
        provider.parentTurns.add(textTurn("done"));

        List<RunEvent> events = collect(agent(provider, null, null), "do it");

        assertTrue(events.stream().anyMatch(event -> event instanceof RunEvent.RunEnd),
                "the run must complete normally");
        assertEquals(2, provider.requests.size());
        provider.requests.forEach(request -> assertNull(request.tap(),
                "no recorder means no tap, byte-identical behavior"));
    }

    @Test
    void childAgentsBindTheirOwnAgentIdOnTheSharedRecorder() {
        TappingProvider provider = new TappingProvider();
        provider.parentTurns.add(List.of(
                new LlmProvider.PToolCall("c1", "spawn_agent",
                        JSON.createObjectNode().put("type", "explore").put("task", "look around")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        provider.parentTurns.add(textTurn("done"));
        provider.childTurns.add(textTurn("child answer"));
        List<ExchangeMeta> metas = Collections.synchronizedList(new ArrayList<>());
        LlmWireRecorder recorder = recorder(metas);

        SubagentManager manager = new SubagentManager(new SubagentConfig(
                provider, Path.of("."), "main", request -> true,
                List.of(echoTool()), null, recorder));
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .llmWire(recorder)
                .build());

        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = manager.run(parent, "delegate", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }

        assertEquals(3, metas.size(), "parent turn 1, the child's turn, parent turn 2");
        ExchangeMeta child = metas.stream()
                .filter(meta -> "explore-1".equals(meta.agentId()))
                .findFirst().orElseThrow(() -> new AssertionError(
                        "the child's exchange must be bound to its own agentId, got: "
                                + metas.stream().map(ExchangeMeta::agentId).toList()));
        assertEquals(1, child.turn());
        assertEquals("chat", child.kind());
        assertEquals(2, metas.stream().filter(meta -> "main".equals(meta.agentId())).count());
    }
}
