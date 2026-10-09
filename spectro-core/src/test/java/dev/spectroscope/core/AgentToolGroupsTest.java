package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 466, criteria 2 and 5 and the security criterion, at the loop: a
 * switched-off group is absent from the provider request, not merely denied;
 * the ring's "tool schemas" part shrinks by exactly what was left out; a change
 * reaches the next run of an agent that is already built; and a tool that is
 * still on asks the gate exactly as before.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class AgentToolGroupsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A tool with a real-looking schema, counting how often it ran. */
    private static final class Counting implements Tool {
        final String name;
        final boolean gated;
        final AtomicInteger ran = new AtomicInteger();

        Counting(String name, boolean gated) {
            this.name = name;
            this.gated = gated;
        }

        public String name() {
            return name;
        }

        public String description() {
            return "The " + name + " tool, described at the length a real one is.";
        }

        public JsonNode inputSchema() {
            return JSON.createObjectNode().put("type", "object")
                    .set("properties", JSON.createObjectNode()
                            .set("path", JSON.createObjectNode().put("type", "string")));
        }

        public boolean needsPermission() {
            return gated;
        }

        public String execute(JsonNode input, ToolContext context) {
            ran.incrementAndGet();
            return "ok";
        }
    }

    /** Plays scripted turns and records the tool names of every request. */
    private static final class Recording implements LlmProvider {
        final Queue<List<ProviderEvent>> turns = new ConcurrentLinkedQueue<>();
        final List<List<String>> advertised = new CopyOnWriteArrayList<>();

        public String modelName() {
            return "fake-model-1";
        }

        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            advertised.add(request.tools().stream().map(ToolSpec::name).toList());
            List<ProviderEvent> turn = turns.poll();
            return turn != null ? turn : List.of(new PTextDelta("done"),
                    new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static List<LlmProvider.ProviderEvent> call(String name) {
        return List.of(new LlmProvider.PToolCall("c-" + name, name, JSON.createObjectNode()),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    private record Belt(ToolRegistry registry, Counting read, Counting browser, Counting launch,
                        Counting web, Counting shell) { }

    private static Belt belt() {
        Belt belt = new Belt(new ToolRegistry(), new Counting("read_file", false),
                new Counting("browser_click", false), new Counting("launch_list", false),
                new Counting("web_fetch", false), new Counting("run_command", true));
        List.of(belt.read(), belt.browser(), belt.launch(), belt.web(), belt.shell())
                .forEach(belt.registry()::register);
        return belt;
    }

    private static Agent agent(Recording provider, Belt belt,
                               java.util.function.Supplier<Set<ToolGroup>> off,
                               PermissionBroker broker) {
        AgentOptions.Builder builder = AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(belt.registry())
                .onPermission(broker)
                .introspection(true);
        if (off != null) {
            builder.toolGroupsOff(off);
        }
        return new Agent(builder.build());
    }

    private static List<RunEvent> run(Agent agent) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static int schemaChars(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.ContextInfo.class::isInstance)
                .map(RunEvent.ContextInfo.class::cast)
                .findFirst().orElseThrow(() -> new AssertionError("no context_info"))
                .parts().stream()
                .filter(part -> "tool schemas".equals(part.label()))
                .findFirst().orElseThrow().chars();
    }

    private static int charsOf(Tool tool) {
        return tool.name().length() + tool.description().length() + tool.inputSchema().toString().length();
    }

    @Test
    void aSwitchedOffGroupIsAbsentFromTheProviderRequest() {
        Recording provider = new Recording();
        Belt belt = belt();

        run(agent(provider, belt, () -> EnumSet.of(ToolGroup.BROWSER, ToolGroup.LAUNCH),
                request -> true));

        assertEquals(List.of("read_file", "web_fetch", "run_command"), provider.advertised.getFirst(),
                "no browser_* and no launch_* tool in the tools field");
    }

    @Test
    void anEmptySwitchSendsEveryRegisteredToolAsBefore() {
        List<String> all = List.of("read_file", "browser_click", "launch_list", "web_fetch", "run_command");

        Recording unwired = new Recording();
        run(agent(unwired, belt(), null, request -> true));
        assertEquals(all, unwired.advertised.getFirst(), "a face that wires nothing sends everything");

        Recording empty = new Recording();
        run(agent(empty, belt(), Set::of, request -> true));
        assertEquals(all, empty.advertised.getFirst(), "an empty list sends everything");
    }

    @Test
    void theRingsToolSchemasPartShrinksByExactlyWhatWasLeftOut() {
        Recording provider = new Recording();
        Belt belt = belt();
        AtomicReference<Set<ToolGroup>> off = new AtomicReference<>(Set.of());
        Agent agent = agent(provider, belt, off::get, request -> true);

        int before = schemaChars(run(agent));
        off.set(EnumSet.of(ToolGroup.BROWSER, ToolGroup.LAUNCH));
        int after = schemaChars(run(agent));

        assertTrue(after < before, "before " + before + ", after " + after);
        assertEquals(charsOf(belt.browser()) + charsOf(belt.launch()), before - after,
                "the part shrinks by the two schemas that no longer ride along");
    }

    @Test
    void aChangeReachesTheNextRunOfAnAgentThatIsAlreadyBuilt() {
        Recording provider = new Recording();
        AtomicReference<Set<ToolGroup>> off = new AtomicReference<>(Set.of());
        Agent agent = agent(provider, belt(), off::get, request -> true);

        run(agent);
        off.set(EnumSet.of(ToolGroup.WEB));
        run(agent);

        assertTrue(provider.advertised.get(0).contains("web_fetch"), "first run: on");
        assertFalse(provider.advertised.get(1).contains("web_fetch"), "second run: off");
        assertTrue(provider.advertised.get(1).contains("read_file"), "the rest still rides along");
    }

    @Test
    void aCallToASwitchedOffToolIsRefusedAndNeverRuns() {
        Recording provider = new Recording();
        provider.turns.add(call("browser_click"));
        Belt belt = belt();

        List<RunEvent> events = run(agent(provider, belt, () -> EnumSet.of(ToolGroup.BROWSER),
                request -> true));

        RunEvent.ToolResult result = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .findFirst().orElseThrow();
        assertTrue(result.isError(), result.output());
        assertTrue(result.output().contains("switched off"), result.output());
        assertEquals(0, belt.browser().ran.get(), "a switched-off tool never runs");

        Recording onAgain = new Recording();
        onAgain.turns.add(call("browser_click"));
        run(agent(onAgain, belt, Set::of, request -> true));
        assertEquals(1, belt.browser().ran.get(), "the same call runs while its group is on");
    }

    @Test
    void switchingGroupsOffNeverLiftsAGate() {
        Recording provider = new Recording();
        provider.turns.add(call("run_command"));
        Belt belt = belt();
        AtomicInteger asked = new AtomicInteger();

        run(agent(provider, belt, () -> EnumSet.allOf(ToolGroup.class), request -> {
            asked.incrementAndGet();
            return false;
        }));

        assertEquals(1, asked.get(), "run_command still asks with every group off");
        assertEquals(0, belt.shell().ran.get(), "and a refusal still holds");
        assertTrue(provider.advertised.getFirst().contains("run_command"),
                "run_command has no group and stays advertised");
    }
}
