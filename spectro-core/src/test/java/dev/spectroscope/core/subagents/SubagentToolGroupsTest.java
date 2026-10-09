package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.ToolGroup;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 466, criterion 4: a child agent inherits the parent's switched-off
 * groups, and its role policy applies on top and never widens. The research
 * role is the hard case, because its grant ADDS the web trio to a child; with
 * the web group off, that grant must not bring them back.
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class SubagentToolGroupsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Routes by system prompt, like SubagentManagerTest, and records what each side was advertised. */
    private static final class RoutingProvider implements LlmProvider {
        final Queue<List<ProviderEvent>> parentTurns = new ConcurrentLinkedQueue<>();
        final Queue<List<ProviderEvent>> childTurns = new ConcurrentLinkedQueue<>();
        final List<List<String>> parentTools = new CopyOnWriteArrayList<>();
        final List<List<String>> childTools = new CopyOnWriteArrayList<>();

        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            boolean isChild = request.system().contains("subagent");
            (isChild ? childTools : parentTools)
                    .add(request.tools().stream().map(ToolSpec::name).toList());
            List<ProviderEvent> turn = (isChild ? childTurns : parentTurns).poll();
            if (turn == null) {
                throw new IllegalStateException("no scripted turn left (child=" + isChild + ")");
            }
            return turn;
        }
    }

    private static Tool fake(String name) {
        return new Tool() {
            public String name() { return name; }
            public String description() { return "fake"; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return "ok"; }
        };
    }

    private static List<LlmProvider.ProviderEvent> text(String text) {
        return List.of(new LlmProvider.PTextDelta(text),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    private static List<LlmProvider.ProviderEvent> call(String name, String input) {
        try {
            return List.of(new LlmProvider.PToolCall("c1", name, JSON.readTree(input)),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static void runParent(RoutingProvider provider, Set<ToolGroup> off) {
        List<Tool> web = List.of(fake("web_search"), fake("web_fetch"), fake("browse_page"));
        List<Tool> base = new ArrayList<>(List.of(fake("list_dir"), fake("read_file"),
                fake("browser_click"), fake("launch_list")));
        base.addAll(web);
        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(base)
                .webTools(web)
                .toolGroupsOff(() -> off)
                .build(), 30_000);
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        manager.devTools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .toolGroupsOff(() -> off)
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = manager.run(parent, "go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
    }

    @Test
    void aWorkerChildInheritsTheParentsSwitchedOffGroups() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(call("spawn_agent", """
                {"type":"worker","task":"look around"}"""));
        provider.parentTurns.add(text("done"));
        provider.childTurns.add(text("looked"));

        runParent(provider, EnumSet.of(ToolGroup.BROWSER, ToolGroup.LAUNCH));

        List<String> child = provider.childTools.getFirst();
        assertFalse(child.contains("browser_click"), "child: " + child);
        assertFalse(child.contains("launch_list"), "child: " + child);
        assertTrue(child.contains("read_file"), "the rest of the belt still reaches the child: " + child);
        assertTrue(child.contains("web_fetch"), "a group that is on stays on: " + child);
    }

    @Test
    void aRoleGrantNeverWidensPastASwitchedOffGroup() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(call("research", """
                {"task":"find the LTS"}"""));
        provider.parentTurns.add(text("done"));
        provider.childTurns.add(text("found"));

        runParent(provider, EnumSet.of(ToolGroup.WEB));

        List<String> child = provider.childTools.getFirst();
        assertFalse(child.contains("web_search"), "the research grant must not bring web back: " + child);
        assertFalse(child.contains("web_fetch"), "child: " + child);
        assertFalse(child.contains("browse_page"), "child: " + child);
        assertTrue(child.contains("read_file"), "child: " + child);
    }

    @Test
    void aResearchChildHoldsItsGrantWhileTheWebGroupIsOn() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(call("research", """
                {"task":"find the LTS"}"""));
        provider.parentTurns.add(text("done"));
        provider.childTurns.add(text("found"));

        runParent(provider, EnumSet.of(ToolGroup.BROWSER));

        List<String> child = provider.childTools.getFirst();
        assertTrue(child.contains("web_search"), "test premise, the grant without the switch: " + child);
        assertFalse(child.contains("browser_click"), "child: " + child);
    }

    /**
     * The parent reads its groups once, when its run starts. A child spawned in
     * that run must get the same set, even when the gear changes while the run
     * is working; otherwise a group switched back on mid-run reaches the child
     * while the parent still hides it. The next run picks the new set up.
     */
    @Test
    void aChildGetsTheGroupsOfTheParentsRunEvenWhenTheGearChangesMidRun() {
        RoutingProvider provider = new RoutingProvider();
        AtomicReference<Set<ToolGroup>> gear = new AtomicReference<>(EnumSet.of(ToolGroup.BROWSER));
        Tool flipGear = new Tool() {
            public String name() { return "flip_gear"; }
            public String description() { return "switches every group back on"; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) {
                gear.set(Set.of());
                return "ok";
            }
        };
        List<Tool> base = List.of(fake("read_file"), fake("browser_click"));
        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(base)
                .toolGroupsOff(gear::get)
                .build(), 30_000);
        ToolRegistry registry = new ToolRegistry();
        registry.register(flipGear);
        registry.register(fake("browser_click"));
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .toolGroupsOff(gear::get)
                .build());

        provider.parentTurns.add(call("flip_gear", "{}"));
        provider.parentTurns.add(call("spawn_agent", """
                {"type":"worker","task":"look around"}"""));
        provider.parentTurns.add(text("done"));
        provider.childTurns.add(text("looked"));
        try (EventStream stream = manager.run(parent, "go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(event -> { });
        }

        List<String> parentAtSpawn = provider.parentTools.get(1);
        List<String> child = provider.childTools.getFirst();
        assertFalse(parentAtSpawn.contains("browser_click"),
                "test premise, the parent keeps its run's set: " + parentAtSpawn);
        assertFalse(child.contains("browser_click"),
                "the child gets the set of the run that spawned it: " + child);
        assertTrue(child.contains("read_file"), "child: " + child);

        provider.parentTurns.add(call("spawn_agent", """
                {"type":"worker","task":"look again"}"""));
        provider.parentTurns.add(text("done"));
        provider.childTurns.add(text("looked"));
        try (EventStream stream = manager.run(parent, "again", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(event -> { });
        }
        List<String> nextChild = provider.childTools.get(1);
        assertTrue(nextChild.contains("browser_click"),
                "the next run reads the gear again, and so does its child: " + nextChild);
    }

    @Test
    void theAgentsAndRolesGroupsTakeTheSpawnVerbsOffTheParent() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(text("done"));

        runParent(provider, EnumSet.of(ToolGroup.AGENTS, ToolGroup.ROLES));

        assertEquals(List.of(), provider.parentTools.getFirst(),
                "spawn_agent, spawn_agents and the five role tools are all switched off");
    }
}
