package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
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
 * Card 503, criterion 10: with {@code agentMessaging} false both tools leave
 * the {@code tools} array of the next run, and a call to one of them is
 * refused as unknown; switched back on, they return with the next run.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class AgentMessagingOffTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static Tool named(String name) {
        return new Tool() {
            public String name() { return name; }
            public String description() { return name; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return "ran " + name; }
        };
    }

    private static List<String> names(List<ToolSpec> specs) {
        return specs.stream().map(ToolSpec::name).toList();
    }

    private static ToolRegistry registry() {
        ToolRegistry registry = new ToolRegistry();
        registry.register(named("read_file"));
        registry.register(named("send_message"));
        registry.register(named("list_agents"));
        return registry;
    }

    @Test
    void offLeavesBothToolsOutOfTheRequest() {
        Agent off = new Agent(AgentOptions.builder().provider(request -> List.of()).systemPrompt("s")
                .registry(registry()).cwd(Path.of(".")).agentMessaging(false).build());
        assertEquals(List.of("read_file"), names(off.toolSpecsForNextRun()));
        Agent on = new Agent(AgentOptions.builder().provider(request -> List.of()).systemPrompt("s")
                .registry(registry()).cwd(Path.of(".")).build());
        assertEquals(List.of("read_file", "send_message", "list_agents"), names(on.toolSpecsForNextRun()),
                "unset is the shipped on");
    }

    @Test
    void theNextRunFollowsTheSwitchAndACallIsRefusedWhileItIsOff() {
        List<ProviderRequest> requests = new CopyOnWriteArrayList<>();
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        LlmProvider provider = request -> {
            requests.add(request);
            if (calls.incrementAndGet() == 1) {
                return List.of(new LlmProvider.PToolCall("c1", "send_message", JSON.createObjectNode()),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
            }
            return List.of(new LlmProvider.PTextDelta("ok"),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        };
        Agent agent = new Agent(AgentOptions.builder().provider(provider).systemPrompt("s").registry(registry())
                .cwd(Path.of(".")).agentMessaging(true).build());
        agent.setAgentMessaging(false);
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        assertEquals(List.of("read_file"), names(requests.getFirst().tools()));
        RunEvent.ToolResult refused = events.stream().filter(e -> e instanceof RunEvent.ToolResult)
                .map(e -> (RunEvent.ToolResult) e).findFirst().orElseThrow();
        assertTrue(refused.isError(), refused.toString());
        assertTrue(refused.output().contains("unknown tool: send_message"), refused.output());
        assertTrue(refused.output().contains("messaging"), refused.output());

        agent.setAgentMessaging(true);
        assertEquals(List.of("read_file", "send_message", "list_agents"), names(agent.toolSpecsForNextRun()));
    }

    @Test
    void offAddsTheMessagingGroupToTheGroupsTheRunLeavesOut() {
        Agent agent = new Agent(AgentOptions.builder().provider(request -> List.of()).systemPrompt("s")
                .registry(registry()).cwd(Path.of(".")).agentMessaging(false)
                .toolGroupsOff(() -> java.util.Set.of(ToolGroup.BROWSER)).build());
        assertEquals(java.util.Set.of(ToolGroup.BROWSER, ToolGroup.MESSAGING), agent.toolGroupsOffNow());
        assertFalse(new Agent(AgentOptions.builder().provider(request -> List.of()).systemPrompt("s")
                .registry(registry()).cwd(Path.of(".")).build()).toolGroupsOffNow().contains(ToolGroup.MESSAGING));
    }
}
