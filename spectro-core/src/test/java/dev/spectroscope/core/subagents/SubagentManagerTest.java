package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.config.HookConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.hooks.HookRunner;
import dev.spectroscope.core.provider.ExchangeLatency;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The subagent machinery against scripted fake providers: the merge order,
 * the tree events, permission profiles by construction, parallelism, the
 * per-child timeout, and untrusted-input handling — all without a key.
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class SubagentManagerTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * Routes requests by system prompt: child scripts for subagent prompts,
     * parent scripts otherwise. Thread-safe — children pop concurrently.
     */
    private static class RoutingProvider implements LlmProvider {
        final Queue<List<ProviderEvent>> parentTurns = new ConcurrentLinkedQueue<>();
        final Queue<List<ProviderEvent>> childTurns = new ConcurrentLinkedQueue<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            boolean isChild = request.system().contains("subagent");
            List<ProviderEvent> turn = (isChild ? childTurns : parentTurns).poll();
            if (turn == null) {
                throw new IllegalStateException("no scripted turn left (child=" + isChild + ")");
            }
            return turn;
        }
    }

    private static JsonNode json(String content) {
        try {
            return JSON.readTree(content);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static List<LlmProvider.ProviderEvent> textTurn(String text) {
        return List.of(new LlmProvider.PTextDelta(text),
                new LlmProvider.PUsage(5, 2),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    private static List<LlmProvider.ProviderEvent> toolTurn(String callId, String name, JsonNode input) {
        return List.of(new LlmProvider.PToolCall(callId, name, input),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    /** A harmless tool for the children's base registry. */
    private static Tool fakeReadTool(String name) {
        return new Tool() {
            public String name() { return name; }
            public String description() { return "fake"; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return "ok"; }
        };
    }

    private record Setup(SubagentManager manager, Agent parent) {}

    private static Setup setup(RoutingProvider provider, long timeoutMs) {
        return setup(provider, timeoutMs, List.of());
    }

    /** The card-205 arity: the parent session's web tools, granted to research children only. */
    private static Setup setup(RoutingProvider provider, long timeoutMs, List<Tool> webTools) {
        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of(fakeReadTool("list_dir"), fakeReadTool("read_file"),
                        fakeReadTool("write_file")))
                .webTools(webTools)
                .build(),
                timeoutMs);
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        manager.devTools().forEach(registry::register); // parent-only, like the spawn tools
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .build());
        return new Setup(manager, parent);
    }

    private static List<RunEvent> collect(Setup setup, String prompt) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = setup.manager()
                .run(setup.parent(), prompt, new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    @Test
    void childAgentsRunTheSamePreToolUseHooksAsTheParent() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(toolTurn("c1", "spawn_agent",
                json("""
                        {"type":"worker","task":"Write the file"}""")));
        provider.parentTurns.add(textTurn("Done."));
        provider.childTurns.add(toolTurn("k1", "write_file",
                json("""
                        {"path":"x.txt","content":"boom"}""")));
        provider.childTurns.add(textTurn("blocked, giving up"));

        // A guard that blocks write_file — on the PARENT it works (AgentTest pins
        // that); this test pins that a child cannot bypass it by delegation.
        HookRunner hooks = new HookRunner(
                List.of(new HookConfig("write_file", "pre_tool_use", "guard", null)),
                (cmd, env, cwd, timeout, signal) ->
                        new HookRunner.CommandRunner.Result(2, "not here", false),
                10);
        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of(fakeReadTool("list_dir"), fakeReadTool("read_file"),
                        fakeReadTool("write_file")))
                .hooks(hooks)
                .build(), 30_000);
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .hooks(hooks)
                .build());

        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = manager
                .run(parent, "Delegate the write", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }

        RunEvent.ToolResult childResult = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .filter(result -> "worker-1".equals(result.agentId()))
                .findFirst().orElseThrow();
        assertTrue(childResult.isError(), "the child's write_file must be blocked");
        assertTrue(childResult.output().startsWith("ERROR: blocked by pre_tool_use hook"),
                childResult.output());
    }

    @Test
    void spawnAgentMergesChildEventsAndFeedsTheResultBack() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(toolTurn("c1", "spawn_agent",
                json("""
                        {"type":"explore","task":"Explore src/"}""")));
        provider.parentTurns.add(textTurn("Summary: looks fine."));
        provider.childTurns.add(textTurn("memo: 2 files found"));

        List<RunEvent> events = collect(setup(provider, 30_000), "Investigate src/");

        // The tree edge exists and precedes the child's run_start.
        int spawnIndex = indexOfType(events, RunEvent.AgentSpawn.class);
        RunEvent.AgentSpawn spawn = (RunEvent.AgentSpawn) events.get(spawnIndex);
        assertEquals("explore-1", spawn.agentId());
        assertEquals("main", spawn.parentId());

        RunEvent.RunStart childStart = events.stream()
                .filter(RunEvent.RunStart.class::isInstance)
                .map(RunEvent.RunStart.class::cast)
                .filter(start -> "explore-1".equals(start.agentId()))
                .findFirst().orElseThrow();
        assertEquals("main", childStart.parentId());
        assertTrue(spawnIndex < events.indexOf(childStart), "agent_spawn must precede the child run");

        // The child's text streamed through the merged queue.
        assertTrue(events.stream()
                .filter(RunEvent.TextDelta.class::isInstance)
                .map(RunEvent.TextDelta.class::cast)
                .anyMatch(delta -> "explore-1".equals(delta.agentId())));

        // The parent's tool_result carries the child's final text plus its usage.
        RunEvent.ToolResult result = firstToolResult(events);
        assertTrue(!result.isError(), "unexpected error result: " + result.output());
        assertTrue(result.output().contains("[explore-1] result"));
        assertTrue(result.output().contains("memo: 2 files found"));
        assertTrue(result.output().contains("5 in / 2 out"));
    }

    @Test
    void exploreChildrenCannotWriteByConstruction() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(toolTurn("c1", "spawn_agent",
                json("""
                        {"type":"explore","task":"Write hack.txt"}""")));
        provider.parentTurns.add(textTurn("The child could not write."));
        // The child tries write_file — which is NOT in the explore registry.
        provider.childTurns.add(toolTurn("cx", "write_file",
                json("""
                        {"path":"hack.txt","content":"x"}""")));
        provider.childTurns.add(textTurn("I lack a write tool."));

        List<RunEvent> events = collect(setup(provider, 30_000), "Try to write via explore");

        RunEvent.ToolResult childResult = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .filter(result -> "explore-1".equals(result.agentId()))
                .findFirst().orElseThrow();
        assertTrue(childResult.isError());
        assertTrue(childResult.output().contains("unknown tool"),
                "explore must not even know write_file: " + childResult.output());
    }

    // ---- card 205: the research role's grant, proven by running -------------------------

    @Test
    void researchChildrenHoldTheWebToolsByConstruction() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(toolTurn("c1", "research",
                json("""
                        {"task":"What is the latest LTS?"}""")));
        provider.parentTurns.add(textTurn("Answered."));
        // The child reaches for web_search — granted, so the fake tool answers.
        provider.childTurns.add(toolTurn("r1", "web_search",
                json("""
                        {"query":"latest LTS"}""")));
        provider.childTurns.add(textTurn("The LTS is 21, sourced."));

        List<RunEvent> events = collect(
                setup(provider, 30_000, List.of(fakeReadTool("web_search"), fakeReadTool("web_fetch"))),
                "Research the LTS");

        RunEvent.ToolResult webResult = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .filter(result -> "research-1".equals(result.agentId()))
                .findFirst().orElseThrow();
        assertTrue(!webResult.isError(), "the research child holds web_search: " + webResult.output());
        assertEquals("ok", webResult.output());
    }

    @Test
    void workerChildrenAreRefusedTheWebByConstruction() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(toolTurn("c1", "spawn_agent",
                json("""
                        {"type":"worker","task":"Search the web"}""")));
        provider.parentTurns.add(textTurn("The child had no web."));
        provider.childTurns.add(toolTurn("w1", "web_search",
                json("""
                        {"query":"anything"}""")));
        provider.childTurns.add(textTurn("I lack a web tool."));

        List<RunEvent> events = collect(
                setup(provider, 30_000, List.of(fakeReadTool("web_search"), fakeReadTool("web_fetch"))),
                "Try the web via worker");

        RunEvent.ToolResult childResult = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .filter(result -> "worker-1".equals(result.agentId()))
                .findFirst().orElseThrow();
        assertTrue(childResult.isError(), "a child without the role is refused the same tools");
        assertTrue(childResult.output().contains("unknown tool"),
                "worker must not even know web_search: " + childResult.output());
    }

    @Test
    void researchChildrenCannotWriteByConstruction() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(toolTurn("c1", "research",
                json("""
                        {"task":"Research and save a file"}""")));
        provider.parentTurns.add(textTurn("The child could not write."));
        provider.childTurns.add(toolTurn("r1", "write_file",
                json("""
                        {"path":"dossier.md","content":"x"}""")));
        provider.childTurns.add(textTurn("I lack a write tool."));

        List<RunEvent> events = collect(
                setup(provider, 30_000, List.of(fakeReadTool("web_search"))),
                "Research with a write attempt");

        RunEvent.ToolResult childResult = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .filter(result -> "research-1".equals(result.agentId()))
                .findFirst().orElseThrow();
        assertTrue(childResult.isError());
        assertTrue(childResult.output().contains("unknown tool"),
                "research reads and reaches the web, it never writes: " + childResult.output());
    }

    @Test
    void spawnAgentRefusesTheResearchTypeItsSchemaDoesNotAdvertise() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(toolTurn("c1", "spawn_agent",
                json("""
                        {"type":"research","task":"Sneak in"}""")));
        provider.parentTurns.add(textTurn("Refused."));

        List<RunEvent> events = collect(
                setup(provider, 30_000, List.of(fakeReadTool("web_search"))),
                "Spawn a research child directly");

        RunEvent.ToolResult result = firstToolResult(events);
        assertTrue(result.isError(),
                "the spawn enum stays explore|worker — the role is selected as the research tool");
        assertTrue(result.output().contains("unknown agent type"), result.output());
    }

    @Test
    void spawnAgentsRunsChildrenInParallel() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(toolTurn("c1", "spawn_agents",
                json("""
                        {"agents":[{"type":"explore","task":"A"},{"type":"explore","task":"B"}]}""")));
        provider.parentTurns.add(textTurn("Both reported."));

        // Both children must be in-flight at the same time: each waits on the
        // latch that only opens when BOTH have started.
        CountDownLatch bothStarted = new CountDownLatch(2);
        for (int i = 0; i < 2; i++) {
            provider.childTurns.add(List.of()); // placeholder, replaced below
        }
        provider.childTurns.clear();
        LlmProvider parallelChild = new LlmProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (!request.system().contains("subagent")) {
                    return provider.parentTurns.poll();
                }
                bothStarted.countDown();
                try {
                    if (!bothStarted.await(5, TimeUnit.SECONDS)) {
                        return textTurn("NOT-PARALLEL");
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                return textTurn("parallel done");
            }
        };

        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(parallelChild)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of(fakeReadTool("list_dir")))
                .build(), 30_000);
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(parallelChild)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .build());

        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = manager.run(parent, "Fan out",
                new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }

        RunEvent.ToolResult result = firstToolResult(events);
        assertTrue(!result.output().contains("NOT-PARALLEL"),
                "children must run concurrently, not sequentially");
        assertTrue(result.output().contains("--- Subagent 1 ---"));
        assertTrue(result.output().contains("--- Subagent 2 ---"));
    }

    // ---- card 270: the price of a child ------------------------------------
    //
    // Two clocks, not one. The queue grace runs from the spawn and only asks
    // "did this backend ever start on my child"; the run budget runs from the
    // child's FIRST TOKEN and asks "is it still getting anywhere". The single
    // literal that used to do both could not tell "wedged" from "waiting", and
    // on the owner's own backend — median exchange 92.2 s — it was shorter than
    // 7 of 15 measured exchanges.

    /** A child that never says a word: the backend accepted the request and
     *  produced nothing until the signal came. */
    private static RoutingProvider aChildThatNeverSpeaks() {
        return new RoutingProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (!request.system().contains("subagent")) {
                    return super.stream(request);
                }
                awaitCancel(request.signal());
                return List.of(new PStop(PStop.StopReason.ABORTED));
            }
        };
    }

    /** A child that produces one token and then wedges — the case the run
     *  budget exists for, and the case the old literal could not tell from a
     *  child that was merely queued. */
    private static RoutingProvider aChildThatSpeaksOnceThenWedges() {
        return new RoutingProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (!request.system().contains("subagent")) {
                    return super.stream(request);
                }
                CancelSignal signal = request.signal();
                return () -> new java.util.Iterator<ProviderEvent>() {
                    private int served;

                    @Override
                    public boolean hasNext() {
                        if (served == 1) {
                            awaitCancel(signal); // wedged AFTER the first token
                        }
                        return served < 2;
                    }

                    @Override
                    public ProviderEvent next() {
                        return served++ == 0
                                ? new PTextDelta("starting to think")
                                : new PStop(PStop.StopReason.ABORTED);
                    }
                };
            }
        };
    }

    /** A child the backend kept in its queue for {@code queuedMs} and which then
     *  answered promptly — the third and fourth child of a four-wide wave on a
     *  single loaded local model. */
    private static RoutingProvider aChildHeldInTheQueueFor(long queuedMs) {
        return new RoutingProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (!request.system().contains("subagent")) {
                    return super.stream(request);
                }
                sleep(queuedMs);
                return textTurn("answered after the queue");
            }
        };
    }

    private static void awaitCancel(CancelSignal signal) {
        while (!signal.isCancelled()) {
            sleep(10);
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    @Test
    void theParentsOwnExchangesAreWhatPriceItsChildren() {
        // The wiring both faces do: ONE window, handed to the parent agent as
        // AgentOptions.latency and to the children as ChildBudget.derivedFrom.
        // Without it the derivation is arithmetic over an empty window and every
        // child is priced at the floor forever — which would look exactly like a
        // working feature.
        ExchangeLatency latency = new ExchangeLatency();
        RoutingProvider provider = new RoutingProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                sleep(120); // a backend that takes a measurable moment
                return super.stream(request);
            }
        };
        provider.parentTurns.add(textTurn("Nothing to delegate."));

        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of(fakeReadTool("list_dir")))
                .budget(ChildBudget.derivedFrom(latency))
                .build());
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .latency(latency)
                .build());

        assertTrue(manager.budget().observedP50Ms().isEmpty(),
                "test premise: nothing is measured before the first exchange");

        try (EventStream stream = manager.run(parent, "Say something",
                new RunOptions(new CancelSignal(), null))) {
            stream.forEach(event -> { });
        }

        assertTrue(manager.budget().observedP50Ms().isPresent(),
                "the parent's exchange must land in the window the children are priced from");
        assertTrue(manager.budget().observedP50Ms().orElseThrow() >= 100,
                "and it must be the real duration: "
                        + manager.budget().observedP50Ms().orElseThrow() + " ms");
        assertTrue(manager.budget().derivation().contains("measured p50"),
                manager.budget().derivation());
    }

    @Test
    void theRunBudgetIsCountedFromTheChildsFirstTokenNotFromItsSpawn() {
        // 550 ms behind a busy backend, then a prompt answer. The whole run
        // budget is 400 ms, so a clock started at the spawn kills this child
        // while it is still in the queue — which is the defect, not the child.
        RoutingProvider provider = aChildHeldInTheQueueFor(550);
        provider.parentTurns.add(toolTurn("c1", "spawn_agent",
                json("""
                        {"type":"worker","task":"Wait behind three others"}""")));
        provider.parentTurns.add(textTurn("The worker came back."));

        List<RunEvent> events = collect(setup(provider, 400), "Run a queued worker");

        RunEvent.ToolResult result = firstToolResult(events);
        assertTrue(!result.isError(),
                "a child must not spend its budget in the queue: " + result.output());
        assertTrue(result.output().contains("answered after the queue"), result.output());
    }

    @Test
    void aChildOutOfBudgetSaysSoInItsRunEndAndInTheParentsToolResult() {
        RoutingProvider provider = aChildThatSpeaksOnceThenWedges();
        provider.parentTurns.add(toolTurn("c1", "spawn_agent",
                json("""
                        {"type":"worker","task":"Take forever"}""")));
        provider.parentTurns.add(textTurn("The worker ran out of budget."));

        List<RunEvent> events = collect(setup(provider, 300), "Run a wedged worker");

        RunEvent.RunEnd childEnd = events.stream()
                .filter(RunEvent.RunEnd.class::isInstance)
                .map(RunEvent.RunEnd.class::cast)
                .filter(end -> !end.runId().isBlank())
                .filter(end -> events.stream()
                        .anyMatch(other -> other instanceof RunEvent.RunStart start
                                && start.runId().equals(end.runId())
                                && "worker-1".equals(start.agentId())))
                .findFirst().orElseThrow();
        assertEquals("child_budget_exhausted", childEnd.stopReason(),
                "the child's own run_end must name the budget, not read as a plain abort");

        RunEvent.ToolResult result = firstToolResult(events);
        assertTrue(result.isError());
        assertTrue(result.output().contains("out of budget"), result.output());
        assertTrue(result.output().contains("first token"),
                "the parent is told WHICH clock ran out: " + result.output());
    }

    @Test
    void aChildThatNeverProducesATokenEndsOnTheQueueGraceAndSaysWhich() {
        RoutingProvider provider = aChildThatNeverSpeaks();
        provider.parentTurns.add(toolTurn("c1", "spawn_agent",
                json("""
                        {"type":"worker","task":"Never answer"}""")));
        provider.parentTurns.add(textTurn("The worker never started."));

        List<RunEvent> events = collect(setup(provider, 300), "Run a mute worker");

        RunEvent.RunEnd childEnd = events.stream()
                .filter(RunEvent.RunEnd.class::isInstance)
                .map(RunEvent.RunEnd.class::cast)
                .filter(end -> events.stream()
                        .anyMatch(other -> other instanceof RunEvent.RunStart start
                                && start.runId().equals(end.runId())
                                && "worker-1".equals(start.agentId())))
                .findFirst().orElseThrow();
        assertEquals("child_no_first_token", childEnd.stopReason());

        RunEvent.ToolResult result = firstToolResult(events);
        assertTrue(result.isError());
        assertTrue(result.output().contains("never produced a token"), result.output());
    }

    @Test
    void unknownAgentTypesAreErrorsNotCrashes() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(toolTurn("c1", "spawn_agent",
                json("""
                        {"type":"ninja","task":"sneak"}""")));
        provider.parentTurns.add(textTurn("No ninjas here."));

        List<RunEvent> events = collect(setup(provider, 30_000), "Spawn a ninja");

        RunEvent.ToolResult result = firstToolResult(events);
        assertTrue(result.isError());
        assertTrue(result.output().contains("unknown agent type"));
        assertEquals("end_turn", ((RunEvent.RunEnd) events.getLast()).stopReason());
    }

    // ---- A2A-lite: agent_message lifecycle -------------------------------

    private static List<RunEvent.AgentMessage> messages(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.AgentMessage.class::isInstance)
                .map(RunEvent.AgentMessage.class::cast)
                .toList();
    }

    @Test
    void aSpawnEmitsTaskAndResultMessagesAroundTheChildRun() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(toolTurn("c1", "spawn_agent",
                json("""
                        {"type":"explore","task":"Explore src/"}""")));
        provider.parentTurns.add(textTurn("Done."));
        provider.childTurns.add(textTurn("memo: 2 files"));

        List<RunEvent> events = collect(setup(provider, 30_000), "Investigate src/");

        List<RunEvent.AgentMessage> msgs = messages(events);
        assertEquals(2, msgs.size(), "task + result message expected: " + msgs);

        RunEvent.AgentMessage task = msgs.get(0);
        assertEquals("main", task.from());
        assertEquals("explore-1", task.to());
        assertEquals("task", task.role());
        assertEquals("submitted", task.state());
        assertEquals("Explore src/", task.text());
        assertEquals(null, task.label(), "plain spawns carry no label");

        RunEvent.AgentMessage result = msgs.get(1);
        assertEquals("explore-1", result.from());
        assertEquals("main", result.to());
        assertEquals("result", result.role());
        assertEquals("completed", result.state());
        assertTrue(result.text().contains("memo: 2 files"));

        // Ordering: spawn edge -> task message -> child run -> result message -> parent tool_result.
        int spawnIdx = indexOfType(events, RunEvent.AgentSpawn.class);
        int taskIdx = events.indexOf(task);
        int resultIdx = events.indexOf(result);
        int toolResultIdx = events.indexOf(firstToolResult(events));
        assertTrue(spawnIdx < taskIdx, "agent_spawn precedes the task message");
        assertTrue(taskIdx < resultIdx, "task precedes result");
        assertTrue(resultIdx < toolResultIdx, "result message precedes the parent's tool_result");
    }

    @Test
    void reportStatusBecomesAWorkingStatusMessage() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(toolTurn("c1", "spawn_agent",
                json("""
                        {"type":"explore","task":"Look around"}""")));
        provider.parentTurns.add(textTurn("Fine."));
        // The child reports progress mid-run — even explore has report_status.
        provider.childTurns.add(toolTurn("cs", "report_status",
                json("""
                        {"message":"halfway through the tree"}""")));
        provider.childTurns.add(textTurn("memo: done"));

        List<RunEvent> events = collect(setup(provider, 30_000), "Research with status");

        RunEvent.AgentMessage status = messages(events).stream()
                .filter(msg -> "status".equals(msg.role()))
                .findFirst().orElseThrow();
        assertEquals("explore-1", status.from());
        assertEquals("main", status.to());
        assertEquals("working", status.state());
        assertEquals("halfway through the tree", status.text());
    }

    @Test
    void aFailingChildEmitsAFailedResultMessage() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(toolTurn("c1", "spawn_agent",
                json("""
                        {"type":"explore","task":"Return nothing"}""")));
        provider.parentTurns.add(textTurn("Sad."));
        // No text delta at all -> "returned no final text" error path.
        provider.childTurns.add(List.of(
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));

        List<RunEvent> events = collect(setup(provider, 30_000), "Spawn a silent child");

        RunEvent.AgentMessage result = messages(events).stream()
                .filter(msg -> "result".equals(msg.role()))
                .findFirst().orElseThrow();
        assertEquals("failed", result.state());
        assertTrue(result.text().startsWith("ERROR:"));
        assertTrue(firstToolResult(events).isError());
    }

    // ---- development tools ------------------------------------------------

    @Test
    void devToolsExistAndSpawnLabeledWorkersWithARolePrompt() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(toolTurn("c1", "build_plan",
                json("""
                        {"task":"Plan the export feature"}""")));
        provider.parentTurns.add(textTurn("Planned."));
        provider.childTurns.add(textTurn("plan: three steps"));

        Setup setup = setup(provider, 30_000);
        assertEquals(List.of("build_plan", "write_spec", "develop", "test", "research"),
                setup.manager().devTools().stream().map(Tool::name).toList());

        List<RunEvent> events = collect(setup, "Plan something");

        // The task message carries the OWNER task + the tool label…
        RunEvent.AgentMessage task = messages(events).get(0);
        assertEquals("task", task.role());
        assertEquals("build_plan", task.label());
        assertEquals("Plan the export feature", task.text());
        assertEquals("worker-1", task.to(), "dev tools run on plain workers — no new agent types");

        // …while the child's actual prompt is the composed role assignment.
        RunEvent.RunStart childStart = events.stream()
                .filter(RunEvent.RunStart.class::isInstance)
                .map(RunEvent.RunStart.class::cast)
                .filter(start -> "worker-1".equals(start.agentId()))
                .findFirst().orElseThrow();
        assertTrue(childStart.prompt().contains("Plan the export feature"));
        assertTrue(childStart.prompt().contains("writing-plans"),
                "the role prompt must point the child at its skill");

        RunEvent.ToolResult result = firstToolResult(events);
        assertTrue(result.output().contains("plan: three steps"));
    }

    @Test
    void devToolsRejectBlankTasksAndChildrenNeverSeeThem() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(toolTurn("c1", "develop",
                json("""
                        {"task":"   "}""")));
        provider.parentTurns.add(toolTurn("c2", "test",
                json("""
                        {"task":"Verify the child cannot recurse"}""")));
        provider.parentTurns.add(textTurn("Over."));
        // The tester child tries to call build_plan — which it must not know.
        provider.childTurns.add(toolTurn("cx", "build_plan",
                json("""
                        {"task":"recurse!"}""")));
        provider.childTurns.add(textTurn("could not recurse"));

        List<RunEvent> events = collect(setup(provider, 30_000), "Blank then recurse");

        RunEvent.ToolResult blank = firstToolResult(events);
        assertTrue(blank.isError());
        assertTrue(blank.output().contains("task must be a non-empty string"));

        RunEvent.ToolResult childAttempt = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .filter(result -> result.agentId().startsWith("worker"))
                .findFirst().orElseThrow();
        assertTrue(childAttempt.isError());
        assertTrue(childAttempt.output().contains("unknown tool"),
                "children must not know the dev tools: " + childAttempt.output());
    }

    private static int indexOfType(List<RunEvent> events, Class<? extends RunEvent> type) {
        for (int i = 0; i < events.size(); i++) {
            if (type.isInstance(events.get(i))) {
                return i;
            }
        }
        throw new AssertionError("no event of type " + type.getSimpleName());
    }

    private static RunEvent.ToolResult firstToolResult(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .filter(result -> "main".equals(result.agentId()))
                .findFirst().orElseThrow();
    }
}
