package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.CareTexts;
import dev.spectroscope.core.subagents.RoleCatalog;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 492 at the loop: with {@code careParagraph} on, every request of a run
 * ends with the paragraph once; the text is fixed when the run starts; the
 * subagent sentence follows the spawn tools the run offers; with the key off
 * the request's system prompt is the one v0.14.4 sent, byte for byte; and the
 * context ring reads what the request carries.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class AgentCareParagraphTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The interactive assembly the v0.14.4 capture was taken with. */
    private static final String BASE = RoleCatalog.BASE_SYSTEM_PROMPT + "/workspace/demo";

    private static Tool named(String name) {
        return new Tool() {
            public String name() {
                return name;
            }

            public String description() {
                return "The " + name + " tool.";
            }

            public JsonNode inputSchema() {
                return JSON.createObjectNode().put("type", "object");
            }

            public boolean needsPermission() {
                return false;
            }

            public String execute(JsonNode input, ToolContext context) {
                return "ok";
            }
        };
    }

    /** Calls read_file once, then ends; records the system prompt of every request. */
    private static final class TwoTurns implements LlmProvider {
        final List<String> systems = new CopyOnWriteArrayList<>();
        Consumer<Integer> onRequest = turn -> { };
        private int turn;

        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            systems.add(request.system());
            onRequest.accept(systems.size());
            return turn++ % 2 == 0
                    ? List.of(new PToolCall("c" + turn, "read_file", JSON.createObjectNode()),
                            new PStop(PStop.StopReason.TOOL_USE))
                    : List.of(new PTextDelta("done"), new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static ToolRegistry belt() {
        ToolRegistry registry = new ToolRegistry();
        for (String name : List.of("read_file", "spawn_agent", "spawn_agents")) {
            registry.register(named(name));
        }
        return registry;
    }

    private static Agent agent(LlmProvider provider, String systemPrompt, String care,
                               Set<ToolGroup> off) {
        AgentOptions.Builder builder = AgentOptions.builder()
                .provider(provider)
                .systemPrompt(systemPrompt)
                .registry(belt())
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .introspection(true)
                .careParagraph(care);
        if (off != null) {
            builder.toolGroupsOff(() -> off);
        }
        return new Agent(builder.build());
    }

    private static List<RunEvent> run(Agent agent) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("describe the repository",
                new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static String fixture(String name) throws IOException {
        try (InputStream in = AgentCareParagraphTest.class.getResourceAsStream("/care-v0144/" + name)) {
            assertNotNull(in, "the v0.14.4 capture " + name + " is missing from the test resources");
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static int count(String haystack, String needle) {
        int found = 0;
        for (int at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
            found++;
        }
        return found;
    }

    @Test
    void withTheKeyOffTheRequestIsTheOneVersion0144SentByteForByte() throws IOException {
        String captured = fixture("interactive-request-system.txt");
        assertEquals(BASE, captured, "premise: the capture is this test's assembly at v0.14.4");
        for (String care : new String[] {null, "off"}) {
            TwoTurns provider = new TwoTurns();
            run(agent(provider, BASE, care, null));
            assertEquals(2, provider.systems.size(), "premise: the run made two requests");
            for (String system : provider.systems) {
                assertEquals(captured, system, "careParagraph=" + care + " changed the system prompt");
            }
        }
    }

    @Test
    void withTheKeyOnEveryRequestOfTheRunEndsWithTheParagraphOnce() {
        TwoTurns provider = new TwoTurns();
        run(agent(provider, BASE, "on", null));
        assertEquals(2, provider.systems.size(), "premise: the run made two requests");
        for (String system : provider.systems) {
            assertEquals(BASE + "\n\n" + CareTexts.TWO_HELPERS, system);
            assertEquals(1, count(system, "Work in small steps."), "the paragraph is in the prompt once");
        }
    }

    @Test
    void withTheAgentsGroupOffTheSubagentSentenceIsLeftOut() {
        TwoTurns provider = new TwoTurns();
        run(agent(provider, BASE, "on", EnumSet.of(ToolGroup.AGENTS)));
        assertEquals(BASE + "\n\n" + CareTexts.NO_SUBAGENTS, provider.systems.get(0));
    }

    @Test
    void theHelperCountTheFaceSetsIsTheOneTheParagraphNames() {
        TwoTurns provider = new TwoTurns();
        Agent agent = agent(provider, BASE, "on", null);
        agent.setCareHelpers(3);
        run(agent);
        assertTrue(provider.systems.get(0).endsWith(
                        CareTexts.TWO_HELPERS.replace("at most 2 subagents", "at most 3 subagents")),
                provider.systems.get(0));
    }

    @Test
    void theTextIsFixedWhenTheRunStartsAndAChangeReachesTheNextRun() {
        TwoTurns provider = new TwoTurns();
        Agent agent = agent(provider, BASE, "on", null);
        provider.onRequest = turn -> {
            if (turn == 1) {
                agent.setCareHelpers(5);
                agent.setCareParagraph("off");
            }
        };
        run(agent);
        assertEquals(2, provider.systems.size(), "premise: the run made two requests");
        assertEquals(provider.systems.get(0), provider.systems.get(1),
                "a change in the middle of a run moved the text of that run");
        assertTrue(provider.systems.get(1).endsWith(CareTexts.TWO_HELPERS));

        provider.onRequest = turn -> { };
        run(agent);
        assertEquals(BASE, provider.systems.get(2), "the change did not reach the next run");
    }

    @Test
    void theRingReadsTheParagraphTheRequestCarries() {
        TwoTurns provider = new TwoTurns();
        List<RunEvent> events = run(agent(provider, BASE, "on", null));
        int ring = events.stream()
                .filter(RunEvent.ContextInfo.class::isInstance)
                .map(RunEvent.ContextInfo.class::cast)
                .findFirst().orElseThrow()
                .parts().stream()
                .filter(part -> part.label().equals("system prompt"))
                .findFirst().orElseThrow()
                .chars();
        assertEquals(provider.systems.get(0).length(), ring,
                "the ring's system prompt part is not what the request carried");
    }
}
