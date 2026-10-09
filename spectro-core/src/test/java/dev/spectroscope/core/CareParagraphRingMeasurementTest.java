package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.subagents.RoleCatalog;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 492, criterion 5: the paragraph's length as the context ring reads it,
 * alone and together with card 470's discovery paragraph, for a helper count
 * of 2 and for the {@code agents} group off. The reader is the
 * {@code system prompt} part of the loop's first {@code context_info}, the
 * same one card 470 measured with. The numbers are printed for the card and
 * held to the concept's 368 and 306 plus the two-character separator.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CareParagraphRingMeasurementTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String WITH_DISCOVERY = RoleCatalog.BASE_SYSTEM_PROMPT + "/workspace/demo";
    private static final String WITHOUT_DISCOVERY =
            WITH_DISCOVERY.replace(" " + RoleCatalog.DISCOVERY_GUIDANCE, "");

    private static Tool named(String name) {
        return new Tool() {
            public String name() {
                return name;
            }

            public String description() {
                return name;
            }

            public JsonNode inputSchema() {
                return JSON.createObjectNode();
            }

            public boolean needsPermission() {
                return false;
            }

            public String execute(JsonNode input, ToolContext context) {
                return "ok";
            }
        };
    }

    private static int ringSystemChars(String systemPrompt, String care, Set<ToolGroup> off) {
        ToolRegistry registry = new ToolRegistry();
        for (String name : List.of("read_file", "spawn_agent", "spawn_agents")) {
            registry.register(named(name));
        }
        LlmProvider provider = request -> List.of(new LlmProvider.PTextDelta("done"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt(systemPrompt)
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .introspection(true)
                .toolGroupsOff(() -> off)
                .careParagraph(care)
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("describe the repository",
                new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events.stream()
                .filter(RunEvent.ContextInfo.class::isInstance)
                .map(RunEvent.ContextInfo.class::cast)
                .findFirst().orElseThrow()
                .parts().stream()
                .filter(part -> part.label().equals("system prompt"))
                .findFirst().orElseThrow()
                .chars();
    }

    private static void measure(String label, Set<ToolGroup> off, int conceptChars) {
        int bare = ringSystemChars(WITHOUT_DISCOVERY, "off", off);
        int careOnly = ringSystemChars(WITHOUT_DISCOVERY, "on", off);
        int discoveryOnly = ringSystemChars(WITH_DISCOVERY, "off", off);
        int both = ringSystemChars(WITH_DISCOVERY, "on", off);
        int alone = careOnly - bare;
        int discovery = discoveryOnly - bare;
        int together = both - bare;
        System.out.println("card-492 ring system prompt chars (" + label + "): bare=" + bare
                + " care=" + careOnly + " discovery=" + discoveryOnly + " both=" + both
                + " | care alone=" + alone + " discovery alone=" + discovery
                + " together=" + together + " | concept=" + conceptChars + " separator=2");
        assertEquals(conceptChars + 2, alone, "the ring reads the concept's paragraph plus the separator");
        assertEquals(alone + discovery, together, "together the two paragraphs add what each adds alone");
    }

    @Test
    void twoHelpers() {
        measure("helpers 2", Set.of(), 368);
    }

    @Test
    void agentsGroupOff() {
        measure("agents group off", EnumSet.of(ToolGroup.AGENTS), 306);
    }
}
