package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 547: a tool that is not offered in the run's folder stays out of the
 * request, and the answer is read once per run.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class AgentOffersOnlyPresentToolsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A tool whose offer is switched from the test; counts how often it is asked. */
    private static final class Switchable implements Tool {
        final AtomicBoolean present = new AtomicBoolean();
        final List<Path> askedIn = new CopyOnWriteArrayList<>();

        public String name() { return "code_graph"; }
        public String description() { return "asks the graph"; }
        public JsonNode inputSchema() { return JSON.createObjectNode().put("type", "object"); }
        public boolean needsPermission() { return false; }
        public String execute(JsonNode input, ToolContext context) { return "ok"; }

        @Override
        public boolean offeredIn(Path cwd) {
            askedIn.add(cwd);
            return present.get();
        }

        @Override
        public String systemPromptLine() {
            return "LINE: ask the graph first.";
        }
    }

    /** Records the tool names of every request and answers with one text turn. */
    private static final class Names implements LlmProvider {
        final List<List<String>> requests = new CopyOnWriteArrayList<>();
        final List<String> systems = new CopyOnWriteArrayList<>();

        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request.tools().stream().map(ToolSpec::name).toList());
            systems.add(request.system());
            return List.of(new PTextDelta("done"), new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static Agent agent(LlmProvider provider, Tool tool, Path cwd) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(tool);
        return new Agent(AgentOptions.builder().provider(provider).systemPrompt("test")
                .registry(registry).cwd(cwd).onPermission(request -> true).build());
    }

    private static void run(Agent agent) {
        try (EventStream stream = agent.run("hi", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(event -> { });
        }
    }

    @Test
    void aToolThatIsNotOfferedStaysOutOfTheRequest(@TempDir Path cwd) {
        Switchable tool = new Switchable();
        Names provider = new Names();
        Agent agent = agent(provider, tool, cwd);
        run(agent);
        assertFalse(provider.requests.get(0).contains("code_graph"), provider.requests.toString());
        assertFalse(agent.toolSpecsForNextRun().stream().anyMatch(s -> s.name().equals("code_graph")));
        tool.present.set(true);
        run(agent);
        assertTrue(provider.requests.get(1).contains("code_graph"), provider.requests.toString());
        assertTrue(agent.toolSpecsForNextRun().stream().anyMatch(s -> s.name().equals("code_graph")));
        assertTrue(tool.askedIn.stream().allMatch(cwd::equals), "asked about the run's folder: " + tool.askedIn);
    }

    @Test
    void theOfferIsReadOncePerRun(@TempDir Path cwd) {
        Switchable tool = new Switchable();
        Names provider = new Names();
        run(agent(provider, tool, cwd));
        assertEquals(1, tool.askedIn.size(), "one question per run, asked " + tool.askedIn.size());
    }

    @Test
    void theToolsPromptLineRidesOnlyInARunThatOffersIt(@TempDir Path cwd) {
        Switchable tool = new Switchable();
        Names provider = new Names();
        Agent agent = agent(provider, tool, cwd);
        run(agent);
        assertEquals("test", provider.systems.get(0), "a run without the tool sends the base prompt unchanged");
        tool.present.set(true);
        run(agent);
        assertEquals("test\n\nLINE: ask the graph first.", provider.systems.get(1));
    }
}
