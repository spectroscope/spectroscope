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
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.PToolCall;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 467, criterion 6: a child agent follows the same rule as its parent.
 *
 * <p>A child is an {@link Agent} built in {@code SubagentManager}, from the
 * session's {@link SubagentConfig}. The switch reaches it through that config,
 * so an operator who turned the elision off turned it off for the tree.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SubagentToolResultElisionTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String FILE = "LINE-OF-A-BIG-FILE\n".repeat(2_000);

    /** The parent spawns one explorer; the child reads a big file, then lists eight times. */
    private static final class ParentAndChild implements LlmProvider {
        final List<ProviderRequest> childRequests = new CopyOnWriteArrayList<>();
        private int parentTurn;

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (request.system().contains("subagent")) {
                childRequests.add(request);
                int turn = childRequests.size();
                if (turn == 1) {
                    return List.of(new PToolCall("k1", "read_file",
                            JSON.createObjectNode().put("path", "big.txt")),
                            new PStop(PStop.StopReason.TOOL_USE));
                }
                if (turn <= 9) {
                    return List.of(new PToolCall("k" + turn, "list_dir",
                            JSON.createObjectNode().put("path", ".")),
                            new PStop(PStop.StopReason.TOOL_USE));
                }
                return List.of(new PTextDelta("found it"), new PStop(PStop.StopReason.END_TURN));
            }
            parentTurn++;
            if (parentTurn == 1) {
                return List.of(new PToolCall("c1", "spawn_agent",
                                JSON.createObjectNode().put("type", "explore").put("task", "Explore")),
                        new PStop(PStop.StopReason.TOOL_USE));
            }
            return List.of(new PTextDelta("done"), new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static Tool tool(String name, String output) {
        return new Tool() {
            public String name() { return name; }
            public String description() { return name; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return output; }
        };
    }

    private static ParentAndChild runWith(String elision) {
        ParentAndChild provider = new ParentAndChild();
        SubagentConfig config = SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of(tool("read_file", FILE), tool("list_dir", "a.txt")))
                .maxTurns(12)
                .toolResultElision(elision)
                .build();
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
                .toolResultElision(elision)
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = manager.run(parent, "Delegate",
                new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        assertTrue(events.stream().anyMatch(RunEvent.AgentSpawn.class::isInstance),
                "premise: a child was spawned");
        return provider;
    }

    private static String sent(ProviderRequest request, String callId) {
        for (ProviderMessage message : request.messages()) {
            for (ProviderContent content : message.content()) {
                if (content instanceof ToolResultContent result && result.callId().equals(callId)) {
                    return result.output();
                }
            }
        }
        throw new AssertionError("no result for " + callId);
    }

    @Test
    void aChildStubsItsOwnOldReadWhenTheSessionLeavesTheElisionOn() {
        ParentAndChild provider = runWith(null);

        assertEquals(10, provider.childRequests.size(), "premise: the child ran ten turns");
        assertEquals(FILE, sent(provider.childRequests.get(1), "k1"), "premise: turn 2 read it whole");
        assertFalse(sent(provider.childRequests.getLast(), "k1").contains("LINE-OF-A-BIG-FILE"),
                "the child resent a read nine turns old in full");
    }

    @Test
    void aChildSendsEveryResultWholeWhenTheOperatorTurnedTheElisionOff() {
        ParentAndChild provider = runWith("off");

        assertEquals(FILE, sent(provider.childRequests.getLast(), "k1"),
                "the operator turned the elision off and the child stubbed anyway");
    }
}
