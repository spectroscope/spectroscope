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
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.session.CareTexts;
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
 * Card 492 for a child agent: a child takes the care setting of the parent
 * run that spawns it. A child carries no spawn tool, so its paragraph leaves
 * the sentence about subagents out, while the parent's names the helpers.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SubagentCareParagraphTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PARENT = "You are the parent.";

    /** The parent spawns one explorer; the child answers at once. */
    private static final class ParentAndChild implements LlmProvider {
        final List<ProviderRequest> parentRequests = new CopyOnWriteArrayList<>();
        final List<ProviderRequest> childRequests = new CopyOnWriteArrayList<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (!request.system().startsWith(PARENT)) {
                childRequests.add(request);
                return List.of(new PTextDelta("found it"), new PStop(PStop.StopReason.END_TURN));
            }
            parentRequests.add(request);
            if (parentRequests.size() == 1) {
                return List.of(new PToolCall("c1", "spawn_agent",
                                JSON.createObjectNode().put("type", "explore").put("task", "Explore")),
                        new PStop(PStop.StopReason.TOOL_USE));
            }
            return List.of(new PTextDelta("done"), new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static Tool tool(String name) {
        return new Tool() {
            public String name() { return name; }
            public String description() { return name; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return "ok"; }
        };
    }

    /**
     * @param configured the session's value, handed to the child config
     * @param parentRuns the value the parent agent's run reads
     */
    private static ParentAndChild runWith(String configured, String parentRuns) {
        ParentAndChild provider = new ParentAndChild();
        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of(tool("read_file")))
                .careParagraph(configured)
                .build(), 30_000);
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt(PARENT)
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .careParagraph(parentRuns)
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = manager.run(parent, "Delegate", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        assertTrue(events.stream().anyMatch(RunEvent.AgentSpawn.class::isInstance),
                "premise: a child was spawned");
        assertFalse(provider.childRequests.isEmpty(), "premise: the child asked the model");
        return provider;
    }

    @Test
    void theChildCarriesTheParagraphWithoutTheSubagentSentence() {
        ParentAndChild provider = runWith("on", "on");
        assertTrue(provider.parentRequests.get(0).system().endsWith("\n\n" + CareTexts.TWO_HELPERS),
                "the parent offers spawn tools, so its paragraph names the helpers");
        assertTrue(provider.childRequests.get(0).system().endsWith("\n\n" + CareTexts.NO_SUBAGENTS),
                provider.childRequests.get(0).system());
    }

    @Test
    void theChildFollowsTheParentRunNotTheBuildTimeConfig() {
        ParentAndChild provider = runWith("off", "on");
        assertTrue(provider.childRequests.get(0).system().endsWith("\n\n" + CareTexts.NO_SUBAGENTS),
                "a setting the parent run started with did not reach its child");
    }

    @Test
    void withTheKeyOffTheChildSendsNoParagraph() {
        ParentAndChild provider = runWith("on", "off");
        assertFalse(provider.childRequests.get(0).system().contains("Work in small steps."),
                provider.childRequests.get(0).system());
        assertEquals(RoleCatalog.SYSTEM_PROMPTS.get(AgentType.EXPLORE),
                provider.childRequests.get(0).system(), "the child's prompt is its role prompt alone");
    }
}
