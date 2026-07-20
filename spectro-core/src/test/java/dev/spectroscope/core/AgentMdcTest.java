package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.slf4j.MDC;

import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The MDC agent prefix : every agent loop runs on its own
 * producer thread, and that thread carries {@code agentId} in the MDC for
 * the whole run — so every log line written anywhere below the loop
 * (provider, tools, hooks) prefixes itself with main / worker-1 / … via the
 * pattern's %X{agentId}. Proven with a probe tool that reads the MDC from
 * inside execute(); the caller's own MDC stays untouched.
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AgentMdcTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Pops one scripted turn per stream() call. */
    private static final class FakeProvider implements LlmProvider {
        private final Deque<List<ProviderEvent>> scriptedTurns = new ArrayDeque<>();

        @SafeVarargs
        static FakeProvider scripted(List<ProviderEvent>... turns) {
            FakeProvider provider = new FakeProvider();
            List.of(turns).forEach(provider.scriptedTurns::add);
            return provider;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            return scriptedTurns.poll();
        }
    }

    /** Answers with whatever the MDC says the agent is. */
    private static final class MdcProbeTool implements Tool {
        public String name() { return "probe"; }
        public String description() { return "reads the MDC"; }
        public JsonNode inputSchema() { return JSON.createObjectNode(); }
        public boolean needsPermission() { return false; }
        public String execute(JsonNode input, ToolContext context) {
            return String.valueOf(MDC.get("agentId"));
        }
    }

    @AfterEach
    void clearMdc() {
        MDC.clear();
    }

    private static String probedAgentId(String agentId) {
        FakeProvider provider = FakeProvider.scripted(
                List.of(new LlmProvider.PToolCall("c1", "probe", JSON.createObjectNode()),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PTextDelta("done"),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        ToolRegistry registry = new ToolRegistry();
        registry.register(new MdcProbeTool());
        AgentOptions.Builder options = AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true);
        if (agentId != null) {
            options.agentId(agentId);
        }
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = new Agent(options.build())
                .run("go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .findFirst().orElseThrow()
                .output();
    }

    @Test
    void theLoopThreadCarriesTheAgentIdInTheMdc() {
        assertEquals("worker-7", probedAgentId("worker-7"),
                "a subagent's loop must prefix as its own id");
    }

    @Test
    void theDefaultAgentIsMainInTheMdc() {
        assertEquals("main", probedAgentId(null));
    }

    @Test
    void theCallersOwnMdcStaysUntouched() {
        MDC.put("agentId", "caller-context");
        probedAgentId("worker-1");
        assertEquals("caller-context", MDC.get("agentId"),
                "the run must not clobber the calling thread's MDC");
    }
}
