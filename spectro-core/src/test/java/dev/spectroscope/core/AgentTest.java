package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.HookConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.hooks.HookRunner;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.RetryPolicy;
import dev.spectroscope.core.provider.RetryingProvider;
import dev.spectroscope.core.provider.TransientProviderException;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The agent loop, proven against a scripted fake provider — no API key, no
 * network. Each test scripts the provider turns and asserts the emitted
 * event sequence plus the message bookkeeping (assistant before results,
 * all results in one user message).
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AgentTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Pops one scripted turn per stream() call and records every request. */
    private static final class FakeProvider implements LlmProvider {
        private final Deque<List<ProviderEvent>> scriptedTurns = new ArrayDeque<>();
        final List<ProviderRequest> requests = new ArrayList<>();
        private String modelName = "fake-model-1";

        @Override
        public String modelName() {
            return modelName;
        }

        /** Name the model, for the capability lookup the loop does per model. */
        FakeProvider named(String value) {
            this.modelName = value;
            return this;
        }

        @SafeVarargs
        static FakeProvider scripted(List<ProviderEvent>... turns) {
            FakeProvider provider = new FakeProvider();
            List.of(turns).forEach(provider.scriptedTurns::add);
            return provider;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            if (request.signal().isCancelled()) {
                return List.of(new PStop(PStop.StopReason.ABORTED));
            }
            if (scriptedTurns.isEmpty()) {
                throw new IllegalStateException("provider asked for more turns than scripted");
            }
            return scriptedTurns.poll();
        }
    }

    /** A permissionless echo tool that records its inputs. */
    private static final class EchoTool implements Tool {
        final List<JsonNode> inputs = new ArrayList<>();
        private final boolean guarded;

        EchoTool(boolean guarded) {
            this.guarded = guarded;
        }

        public String name() { return "echo"; }
        public String description() { return "echoes"; }
        public JsonNode inputSchema() { return JSON.createObjectNode(); }
        public boolean needsPermission() { return guarded; }

        public String execute(JsonNode input, ToolContext context) {
            inputs.add(input);
            return "echoed: " + input.path("value").asText();
        }
    }

    private static Agent agentWith(LlmProvider provider, Tool tool, PermissionBroker broker) {
        ToolRegistry registry = new ToolRegistry();
        if (tool != null) {
            registry.register(tool);
        }
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(broker != null ? broker : request -> true)
                .build());
    }

    private static List<RunEvent> collect(Agent agent) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("do it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static List<Class<?>> typesOf(List<RunEvent> events) {
        return events.stream().<Class<?>>map(RunEvent::getClass).toList();
    }

    // ---------------------------------------------------------------- basics

    @Test
    void plainAnswerEmitsTheCanonicalSequence() {
        FakeProvider provider = FakeProvider.scripted(List.of(
                new LlmProvider.PTextDelta("Hello"),
                new LlmProvider.PUsage(10, 5),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));

        List<RunEvent> events = collect(agentWith(provider, null, null));

        assertEquals(List.of(RunEvent.RunStart.class, RunEvent.TurnStart.class,
                        RunEvent.TextDelta.class, RunEvent.Usage.class, RunEvent.RunEnd.class),
                typesOf(events));
        RunEvent.RunEnd end = (RunEvent.RunEnd) events.getLast();
        assertEquals("end_turn", end.stopReason());
    }

    /** A model without native tool_calls (spectro-local) must be handed NO tools —
     *  advertising them only invites the <fulfilment>/runaway failure mode. */
    private Agent agentNamed(String providerName, FakeProvider provider) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(new EchoTool(false));   // a non-empty tool set
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .providerName(providerName)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .build());
    }

    @Test
    void spectroLocalReasonerIsAdvertisedNoTools() {
        FakeProvider provider = FakeProvider.scripted(List.of(
                new LlmProvider.PTextDelta("hi"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)))
                .named("vibethinker-3b");
        try (EventStream stream = agentNamed("spectro-local", provider)
                .run("do it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(e -> { });
        }
        assertTrue(provider.requests.get(0).tools().isEmpty(),
                "the small reasoner emits tool calls as text, so it is handed none");
    }

    @Test
    void spectroLocalToolCapableModelStillGetsTools() {
        FakeProvider provider = FakeProvider.scripted(List.of(
                new LlmProvider.PTextDelta("hi"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)))
                .named("qwen3-4b");
        try (EventStream stream = agentNamed("spectro-local", provider)
                .run("do it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(e -> { });
        }
        assertFalse(provider.requests.get(0).tools().isEmpty(),
                "a catalogue model that speaks tool_calls must be offered the registry");
    }

    @Test
    void aNativeToolProviderStillGetsTools() {
        FakeProvider provider = FakeProvider.scripted(List.of(
                new LlmProvider.PTextDelta("hi"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        try (EventStream stream = agentNamed("anthropic", provider)
                .run("do it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(e -> { });
        }
        assertFalse(provider.requests.get(0).tools().isEmpty(),
                "a native-tool provider still receives the tool set");
    }

    @Test
    void toolRoundTripFeedsTheResultBackInOneUserMessage() {
        JsonNode input = JSON.createObjectNode().put("value", "42");
        FakeProvider provider = FakeProvider.scripted(
                List.of(new LlmProvider.PToolCall("c1", "echo", input),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PTextDelta("done"),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        EchoTool tool = new EchoTool(false);

        List<RunEvent> events = collect(agentWith(provider, tool, null));

        // The tool ran with the parsed input.
        assertEquals(1, tool.inputs.size());
        assertEquals("42", tool.inputs.getFirst().path("value").asText());

        // tool_call and a non-error tool_result were emitted, linked by callId.
        RunEvent.ToolResult result = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .findFirst().orElseThrow();
        assertEquals("c1", result.callId());
        assertEquals("echoed: 42", result.output());
        assertTrue(!result.isError());

        // Second request carries: user prompt, assistant tool_call, ONE user message
        // whose content is exactly the tool result for c1.
        LlmProvider.ProviderRequest secondRequest = provider.requests.getLast();
        LlmProvider.ProviderMessage lastMessage = secondRequest.messages().getLast();
        assertEquals(LlmProvider.ProviderMessage.Role.USER, lastMessage.role());
        assertEquals(1, lastMessage.content().size());
        LlmProvider.ToolResultContent feedback =
                assertInstanceOf(LlmProvider.ToolResultContent.class, lastMessage.content().getFirst());
        assertEquals("c1", feedback.callId());
    }

    // ----------------------------------------------------------- permissions

    @Test
    void deniedPermissionSkipsTheToolAndReportsAnErrorResult() {
        JsonNode input = JSON.createObjectNode().put("value", "no");
        FakeProvider provider = FakeProvider.scripted(
                List.of(new LlmProvider.PToolCall("c1", "echo", input),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        EchoTool guardedTool = new EchoTool(true);

        List<RunEvent> events = collect(agentWith(provider, guardedTool, request -> false));

        assertTrue(guardedTool.inputs.isEmpty(), "a denied tool must never execute");
        assertTrue(typesOf(events).contains(RunEvent.PermissionRequest.class));
        RunEvent.PermissionDecision decision = events.stream()
                .filter(RunEvent.PermissionDecision.class::isInstance)
                .map(RunEvent.PermissionDecision.class::cast)
                .findFirst().orElseThrow();
        assertTrue(!decision.allowed());
        RunEvent.ToolResult result = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .findFirst().orElseThrow();
        assertTrue(result.isError());
        assertTrue(result.output().contains("denied"));
    }

    /** A guarded tool that sleeps a fixed time — the execution half of the card-111 clock. */
    private static final class SlowTool implements Tool {
        final List<JsonNode> inputs = new ArrayList<>();
        private final long sleepMs;

        SlowTool(long sleepMs) {
            this.sleepMs = sleepMs;
        }

        public String name() { return "slow"; }
        public String description() { return "sleeps, then answers"; }
        public JsonNode inputSchema() { return JSON.createObjectNode(); }
        public boolean needsPermission() { return true; }

        public String execute(JsonNode input, ToolContext context) {
            inputs.add(input);
            try {
                Thread.sleep(sleepMs);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return "slept " + sleepMs;
        }
    }

    /** Scripts one turn calling the given tool once, then a clean end_turn. */
    private static FakeProvider oneToolCallThenEnd(String toolName) {
        JsonNode input = JSON.createObjectNode().put("value", "x");
        return FakeProvider.scripted(
                List.of(new LlmProvider.PToolCall("c1", toolName, input),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PTextDelta("done"),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
    }

    private static RunEvent.ToolResult firstToolResult(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .findFirst().orElseThrow();
    }

    // ------------------------------------------- card 269: the write that changed nothing

    /**
     * The whole chain, through the REAL write_file: the tool compares what it is
     * about to write against what is there, the loop carries the word out, and
     * the recorded result states it as a field. A test with a hand-made tool
     * would pin the plumbing and miss the tool.
     *
     * <p>Read off the WIRE, not off an accessor, so this test could be seen
     * failing before the field existed.
     */
    @Test
    void theLoopRecordsWhatAWriteActuallyDidToTheFile(@TempDir Path cwd) {
        JsonNode sameCall = JSON.createObjectNode().put("path", "pi.py").put("content", "import math\n");
        FakeProvider provider = FakeProvider.scripted(
                List.of(new LlmProvider.PToolCall("c1", "write_file", sameCall),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PToolCall("c2", "write_file", sameCall),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PTextDelta("done"),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(cwd)
                .onPermission(request -> true)
                .build());

        List<RunEvent.ToolResult> results = collect(agent).stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .toList();

        assertEquals(2, results.size());
        assertEquals("created", JSON.valueToTree(results.getFirst()).path("fileChange").asText());
        assertEquals("unchanged", JSON.valueToTree(results.getLast()).path("fileChange").asText(),
                "the second write moved no byte and the record has to say so");
    }

    @Test
    void aToolThatTouchesNoFileLeavesTheWordOffTheRecord(@TempDir Path cwd) {
        JsonNode listing = JSON.createObjectNode().put("path", ".");
        FakeProvider provider = FakeProvider.scripted(
                List.of(new LlmProvider.PToolCall("c1", "list_dir", listing),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PTextDelta("done"),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(cwd)
                .onPermission(request -> true)
                .build());

        RunEvent.ToolResult result = firstToolResult(collect(agent));
        assertFalse(JSON.valueToTree(result).has("fileChange"),
                "a listing changed no file, and silence is the honest answer");
    }

    // ------------------------------------------ card 111: gate wait vs execution

    @Test
    void aGatedToolBillsExecutionOnlyNotTheOperatorWait() {
        // The gate parks the call for ~2 s; the tool itself runs ~100 ms. The
        // reported durationMs must be the execution, never request-to-finish.
        SlowTool tool = new SlowTool(100);
        PermissionBroker parkedBroker = request -> {
            try {
                Thread.sleep(2000);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return true;
        };

        List<RunEvent> events = collect(agentWith(oneToolCallThenEnd("slow"), tool, parkedBroker));

        RunEvent.ToolResult result = firstToolResult(events);
        assertTrue(result.durationMs() >= 100,
                "execution slept 100 ms, durationMs was " + result.durationMs());
        assertTrue(result.durationMs() < 1000,
                "durationMs must exclude the ~2 s gate wait, was " + result.durationMs());
        // The wait is not discarded — it is named, additively.
        assertNotNull(result.gateWaitMs(), "a gated call must carry the parked time");
        assertTrue(result.gateWaitMs() >= 2000,
                "the broker parked ~2 s, gateWaitMs was " + result.gateWaitMs());
        assertTrue(result.gateWaitMs() < 3000,
                "gateWaitMs is the wait alone, was " + result.gateWaitMs());
    }

    @Test
    void anUngatedToolCarriesNoGateWait() {
        // No gate ever parked the call — the field must be ABSENT (null), so an
        // ungated session serializes byte-identical to a pre-card-111 one.
        EchoTool tool = new EchoTool(false);

        List<RunEvent> events = collect(agentWith(oneToolCallThenEnd("echo"), tool, null));

        assertEquals(null, firstToolResult(events).gateWaitMs(),
                "no gate -> no gateWaitMs, never zero");
    }

    @Test
    void aDeniedGateReportsZeroExecutionAndStillNamesTheWait() {
        // Card 111's worst case: a call reported 321.6 s and was DENIED — it
        // never executed at all. Denial must bill 0 execution, wait named.
        EchoTool guardedTool = new EchoTool(true);
        PermissionBroker slowDeny = request -> {
            try {
                Thread.sleep(200);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return false;
        };

        List<RunEvent> events = collect(agentWith(oneToolCallThenEnd("echo"), guardedTool, slowDeny));

        assertTrue(guardedTool.inputs.isEmpty(), "a denied tool must never execute");
        RunEvent.ToolResult result = firstToolResult(events);
        assertTrue(result.isError());
        assertEquals(0, result.durationMs(), "a tool that never ran executed for 0 ms");
        assertNotNull(result.gateWaitMs(), "the denied call still names its wait");
        assertTrue(result.gateWaitMs() >= 200,
                "the broker parked ~200 ms, gateWaitMs was " + result.gateWaitMs());
    }

    @Test
    void aPreToolUseHookBlockBypassesPermissionAndNeverExecutes() {
        JsonNode input = JSON.createObjectNode().put("value", "no");
        FakeProvider provider = FakeProvider.scripted(
                List.of(new LlmProvider.PToolCall("c1", "echo", input),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        EchoTool guardedTool = new EchoTool(true); // guarded, so we also prove the gate is skipped
        HookRunner hooks = new HookRunner(
                List.of(new HookConfig("*", "pre_tool_use", "guard", null)),
                (cmd, env, cwd, timeout, signal) ->
                        new HookRunner.CommandRunner.Result(2, "not allowed here", false),
                10);
        ToolRegistry registry = new ToolRegistry();
        registry.register(guardedTool);
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true) // would allow — but the hook blocks first
                .hooks(hooks)
                .build());

        List<RunEvent> events = collect(agent);

        assertTrue(guardedTool.inputs.isEmpty(), "a pre_tool_use block must skip execute");
        assertTrue(events.stream().noneMatch(RunEvent.PermissionRequest.class::isInstance),
                "a blocked call emits no permission_request");
        RunEvent.ToolResult result = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .findFirst().orElseThrow();
        assertTrue(result.isError());
        assertTrue(result.output().startsWith("ERROR: blocked by pre_tool_use hook"),
                result.output());

        // Card 195: the block is a fact of the run, not only a sentence inside
        // the model's error string. Nothing downstream could name WHICH hook
        // refused, and a screen cannot invent that.
        RunEvent.HookDecision decision = events.stream()
                .filter(RunEvent.HookDecision.class::isInstance)
                .map(RunEvent.HookDecision.class::cast)
                .findFirst().orElseThrow(() -> new AssertionError("no hook_decision on the wire"));
        assertEquals("c1", decision.callId(), "the decision joins the call it refused");
        assertEquals("echo", decision.toolName());
        assertEquals("pre_tool_use", decision.event());
        assertEquals("guard", decision.command());
        assertEquals("blocked", decision.verdict());
        assertTrue(decision.reason().contains("not allowed here"), decision.reason());
    }

    @Test
    void aTimedOutHookIsOnTheWireAsTimedOutThoughTheCallProceeds() {
        // The fail-open is deliberate. A fail-open nobody can see is not.
        JsonNode input = JSON.createObjectNode().put("value", "yes");
        FakeProvider provider = FakeProvider.scripted(
                List.of(new LlmProvider.PToolCall("c1", "echo", input),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        EchoTool tool = new EchoTool(false);
        HookRunner hooks = new HookRunner(
                List.of(new HookConfig("*", "pre_tool_use", "slow-guard", 3)),
                (cmd, env, cwd, timeout, signal) ->
                        new HookRunner.CommandRunner.Result(-1, "", true),
                10);
        ToolRegistry registry = new ToolRegistry();
        registry.register(tool);
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .hooks(hooks)
                .build());

        List<RunEvent> events = collect(agent);

        assertFalse(tool.inputs.isEmpty(), "fail-open stands: the call still ran");
        RunEvent.HookDecision decision = events.stream()
                .filter(RunEvent.HookDecision.class::isInstance)
                .map(RunEvent.HookDecision.class::cast)
                .findFirst().orElseThrow(() -> new AssertionError("no hook_decision on the wire"));
        assertEquals("timed-out", decision.verdict());
        assertEquals(3, decision.timeoutSeconds());
        assertNull(decision.reason(), "a killed hook stated nothing; a reason here would be invented");
    }

    @Test
    void aPassingHookPutsNothingOnTheWire() {
        JsonNode input = JSON.createObjectNode().put("value", "yes");
        FakeProvider provider = FakeProvider.scripted(
                List.of(new LlmProvider.PToolCall("c1", "echo", input),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        HookRunner hooks = new HookRunner(
                List.of(new HookConfig("*", "pre_tool_use", "guard", null),
                        new HookConfig("*", "post_tool_use", "notify", null)),
                (cmd, env, cwd, timeout, signal) ->
                        new HookRunner.CommandRunner.Result(0, "", false),
                10);
        ToolRegistry registry = new ToolRegistry();
        registry.register(new EchoTool(false));
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .hooks(hooks)
                .build());

        assertTrue(collect(agent).stream().noneMatch(RunEvent.HookDecision.class::isInstance),
                "a hook that agreed is not news; a line per tool call per hook would bury the two that are");
    }

    @Test
    void cacheTokensFeedTheTriggerButStayOffTheWire() {
        FakeProvider provider = FakeProvider.scripted(
                List.of(new LlmProvider.PTextDelta("hi"),
                        new LlmProvider.PUsage(200, 7, 50_000, 300),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        Agent agent = agentWith(provider, null, null);

        List<RunEvent> events = collect(agent);

        RunEvent.Usage usage = events.stream()
                .filter(RunEvent.Usage.class::isInstance)
                .map(RunEvent.Usage.class::cast)
                .findFirst().orElseThrow();
        assertEquals(200, usage.inputTokens(), "the wire keeps the provider's raw count");
        assertEquals(7, usage.outputTokens());
        // The cache counts ride ADDITIVELY on the same event — the UIs need them
        // to show the true context size (raw in + cache = what fills the window).
        assertEquals(50_000, usage.cacheReadTokens());
        assertEquals(300, usage.cacheCreationTokens());

        // The compaction trigger folds the cache counts back in — cached tokens
        // still occupy the context window.
        assertEquals(50_500, Agent.contextTokens(new LlmProvider.PUsage(200, 7, 50_000, 300)));
    }

    @Test
    void theThinkingToggleActsMidSessionEvenWhenTheModelAlwaysReasons() {
        // Ollama's gpt-oss streams reasoning UNCONDITIONALLY (the wire flag
        // cannot stop it), and the server keeps ONE agent per connection — so
        // the visibility switch must hold at the harness level AND reach the
        // already-built agent (Agent.setThinking, fed by the web toggle).
        FakeProvider provider = FakeProvider.scripted(
                List.of(new LlmProvider.PThinkingDelta("let me think"),
                        new LlmProvider.PTextDelta("one"),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)),
                List.of(new LlmProvider.PThinkingDelta("still reasoning"),
                        new LlmProvider.PTextDelta("two"),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(new ToolRegistry())
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .thinking(true)
                .build());

        assertTrue(collect(agent).stream().anyMatch(RunEvent.ThinkingDelta.class::isInstance),
                "thinking ON surfaces the reasoning stream");
        assertTrue(provider.requests.getFirst().thinking(), "the wire asks for reasoning");

        agent.setThinking(false); // the header toggle, mid-session
        List<RunEvent> second = collect(agent);
        assertTrue(second.stream().noneMatch(RunEvent.ThinkingDelta.class::isInstance),
                "the toggle silences reasoning even for always-thinking models");
        assertTrue(second.stream().anyMatch(RunEvent.TextDelta.class::isInstance),
                "the answer itself still streams");
        assertFalse(provider.requests.get(1).thinking(), "the wire stops asking too");
    }

    @Test
    void aToolAttachedImageRidesTheToolResultsMessageAfterTheResults() {
        // view_image's contract: the tool hands the loop an image through the
        // attach sink, and the NEXT provider request carries it as image
        // content on the tool-results user message — AFTER the results (the
        // Anthropic API requires tool_result blocks first).
        JsonNode input = JSON.createObjectNode().put("path", "red.png");
        FakeProvider provider = FakeProvider.scripted(
                List.of(new LlmProvider.PToolCall("c1", "show_red", input),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PTextDelta("It is red."),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        Tool showRed = new Tool() {
            public String name() { return "show_red"; }
            public String description() { return "attaches a red pixel"; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode in, ToolContext context) {
                context.attach().accept(new Tool.AttachedImage("image/png", "UkVEUE5H"));
                return "Attached red.png for you to see.";
            }
        };

        collect(agentWith(provider, showRed, null));

        LlmProvider.ProviderMessage toolResults = provider.requests.get(1).messages().getLast();
        assertEquals(LlmProvider.ProviderMessage.Role.USER, toolResults.role());
        assertInstanceOf(LlmProvider.ToolResultContent.class, toolResults.content().get(0),
                "the tool result leads the message");
        LlmProvider.ImageContent image = (LlmProvider.ImageContent) toolResults.content().get(1);
        assertEquals("image/png", image.mediaType());
        assertEquals("UkVEUE5H", image.dataBase64());
    }

    @Test
    void aToolAttachedDocumentRidesTheToolResultsMessage() {
        // view_file's contract (file_upload): the tool hands the loop a PDF
        // through the SAME attach sink, and the NEXT provider request carries
        // it as document content on the tool-results user message — after the
        // results, like images. Bytes live in provider history only.
        JsonNode input = JSON.createObjectNode().put("path", "paper.pdf");
        FakeProvider provider = FakeProvider.scripted(
                List.of(new LlmProvider.PToolCall("c1", "show_pdf", input),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PTextDelta("Read it."),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        Tool showPdf = new Tool() {
            public String name() { return "show_pdf"; }
            public String description() { return "attaches a pdf"; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode in, ToolContext context) {
                context.attach().accept(new Tool.AttachedDocument(
                        "application/pdf", "UERGQllURVM=", "paper.pdf"));
                return "Attached paper.pdf for you to read.";
            }
        };

        collect(agentWith(provider, showPdf, null));

        LlmProvider.ProviderMessage toolResults = provider.requests.get(1).messages().getLast();
        assertInstanceOf(LlmProvider.ToolResultContent.class, toolResults.content().get(0));
        LlmProvider.DocumentContent document =
                (LlmProvider.DocumentContent) toolResults.content().get(1);
        assertEquals("application/pdf", document.mediaType());
        assertEquals("UERGQllURVM=", document.dataBase64());
        assertEquals("paper.pdf", document.name());
    }

    @Test
    void usageWithoutCacheTokensStaysByteIdenticalToTheLegacyShape() {
        // Ollama/openai never report cache counts — their sessions must keep
        // writing EXACTLY the old line (the additive fields stay absent).
        FakeProvider provider = FakeProvider.scripted(
                List.of(new LlmProvider.PTextDelta("hi"),
                        new LlmProvider.PUsage(297, 49, 0, 0),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));

        RunEvent.Usage usage = collect(agentWith(provider, null, null)).stream()
                .filter(RunEvent.Usage.class::isInstance)
                .map(RunEvent.Usage.class::cast)
                .findFirst().orElseThrow();
        assertEquals(297, usage.inputTokens());
        assertTrue(usage.cacheReadTokens() == null && usage.cacheCreationTokens() == null,
                "zero cache counts must not appear on the wire");
    }

    @Test
    void unknownToolsComeBackAsErrorResultsNotExceptions() {
        JsonNode input = JSON.createObjectNode();
        FakeProvider provider = FakeProvider.scripted(
                List.of(new LlmProvider.PToolCall("c1", "does_not_exist", input),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));

        List<RunEvent> events = collect(agentWith(provider, null, null));

        RunEvent.ToolResult result = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .findFirst().orElseThrow();
        assertTrue(result.isError());
        assertTrue(result.output().contains("unknown tool"));
        assertEquals("end_turn", ((RunEvent.RunEnd) events.getLast()).stopReason());
    }

    // ---------------------------------------------------------------- errors

    @Test
    void aProviderFailureEndsTheRunWithErrorEvents() {
        LlmProvider failing = request -> {
            throw new IllegalStateException("connection refused");
        };

        List<RunEvent> events = collect(agentWith(failing, null, null));

        List<Class<?>> tail = typesOf(events).subList(events.size() - 2, events.size());
        assertEquals(List.of(RunEvent.ErrorEvent.class, RunEvent.RunEnd.class), tail);
        assertEquals("error", ((RunEvent.RunEnd) events.getLast()).stopReason());
    }

    @Test
    void aCancelledSignalEndsTheRunAsAborted() {
        CancelSignal signal = new CancelSignal();
        signal.cancel();
        FakeProvider provider = FakeProvider.scripted();

        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agentWith(provider, null, null)
                .run("do it", new RunOptions(signal, null))) {
            stream.forEach(events::add);
        }

        assertEquals("aborted", ((RunEvent.RunEnd) events.getLast()).stopReason());
    }

    @Test
    void theTurnBrakeStopsRunawayToolLoops() {
        // A provider that wants a tool on every turn, forever.
        JsonNode input = JSON.createObjectNode().put("value", "again");
        LlmProvider relentless = request -> List.of(
                new LlmProvider.PToolCall("c" + request.messages().size(), "echo", input),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));

        List<RunEvent> events = collect(agentWith(relentless, new EchoTool(false), null));

        assertEquals("max_turns", ((RunEvent.RunEnd) events.getLast()).stopReason());
        long turnCount = events.stream().filter(RunEvent.TurnStart.class::isInstance).count();
        // Against the CONSTANT, not against a literal. This assertion said 15,
        // and card 365 moved the shipped ceiling to 150 after a census found
        // 48 % of real sessions going past the old one — so a test naming the
        // number was a second copy of it, and it went red for a reason that
        // had nothing to do with the brake. Its subject is that the loop stops
        // exactly AT the brake, whatever the brake is.
        assertEquals(Agent.DEFAULT_MAX_TURNS, turnCount,
                "the loop must stop exactly at the turn brake");
    }

    @Test
    void anExplicitCeilingOutranksTheShippedOne() {
        // The other half, and the reason the assertion above may derive its
        // number without becoming untestable: read against the constant alone,
        // a brake that IGNORED the option would still look right. This one is
        // wrong for every value of the default.
        JsonNode input = JSON.createObjectNode().put("value", "again");
        LlmProvider relentless = request -> List.of(
                new LlmProvider.PToolCall("c" + request.messages().size(), "echo", input),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
        ToolRegistry registry = new ToolRegistry();
        registry.register(new EchoTool(false));
        Agent capped = new Agent(AgentOptions.builder()
                .provider(relentless)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .maxTurns(4)
                .build());

        List<RunEvent> events = collect(capped);

        assertEquals("max_turns", ((RunEvent.RunEnd) events.getLast()).stopReason());
        assertEquals(4, events.stream().filter(RunEvent.TurnStart.class::isInstance).count(),
                "a configured ceiling has to beat the shipped one, or the settings key"
                        + " resolves perfectly and steers nothing");
    }

    // --------------------------------------------------------- introspection

    @Test
    void introspectionEmitsOneContextInfoPerTurnAndOnlyWhenEnabled() {
        JsonNode input = JSON.createObjectNode().put("value", "42");
        FakeProvider provider = FakeProvider.scripted(
                List.of(new LlmProvider.PToolCall("c1", "echo", input),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)),
                List.of(new LlmProvider.PTextDelta("done"),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        ToolRegistry registry = new ToolRegistry();
        registry.register(new EchoTool(false));
        Agent introspective = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .introspection(true)
                .build());

        List<RunEvent> events = collect(introspective);

        List<RunEvent.ContextInfo> infos = events.stream()
                .filter(RunEvent.ContextInfo.class::isInstance)
                .map(RunEvent.ContextInfo.class::cast)
                .toList();
        long turnCount = events.stream().filter(RunEvent.TurnStart.class::isInstance).count();
        assertEquals(2, turnCount);
        assertEquals(turnCount, infos.size(), "exactly one context_info per turn");
        assertEquals(List.of(1, 2), infos.stream().map(RunEvent.ContextInfo::turn).toList());
        for (RunEvent.ContextInfo info : infos) {
            assertEquals(List.of("system prompt", "tool schemas", "conversation"),
                    info.parts().stream().map(RunEvent.ContextPart::label).toList());
            assertEquals(info.parts().stream().mapToInt(RunEvent.ContextPart::estTokens).sum(),
                    info.estimatedTokens(), "estimatedTokens must be the sum of its parts");
            // Card 263: the fake provider reports no window and nothing is
            // configured, so this is the FALLBACK arm — the only one that is
            // still 100,000, and it says so on the event now.
            assertEquals(100_000, info.threshold(), "a provider that knows nothing lands on 100000");
            assertEquals("fallback", info.thresholdSource(), "and the event names that arm");
        }
        // Card 86 follow-up: the parts carry their CONTENT — what actually
        // rides to the provider, readable in the trace's Insight view.
        assertEquals("test", infos.get(0).parts().get(0).text(), "system prompt text verbatim");
        assertTrue(infos.get(0).parts().get(1).text().contains("echo"),
                "tool schema text names the tool");
        assertTrue(infos.get(1).parts().get(2).text().contains("tool_result"),
                "conversation text renders the history");

        // Without the flag the stream stays exactly as before — no context_info at all.
        FakeProvider plainProvider = FakeProvider.scripted(List.of(
                new LlmProvider.PTextDelta("Hello"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        List<RunEvent> plainEvents = collect(agentWith(plainProvider, null, null));
        assertTrue(plainEvents.stream().noneMatch(RunEvent.ContextInfo.class::isInstance),
                "without the flag no context_info is emitted");
    }

    @Test
    void runStartStampsTheProvidersModel() {
        // Card 87: every run records WHICH model answered it — the provider
        // reports its live model id and run_start carries it additively.
        FakeProvider provider = FakeProvider.scripted(List.of(
                new LlmProvider.PTextDelta("hi"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        List<RunEvent> events = collect(agentWith(provider, null, null));
        RunEvent.RunStart start = events.stream()
                .filter(RunEvent.RunStart.class::isInstance)
                .map(RunEvent.RunStart.class::cast)
                .findFirst().orElseThrow();
        assertEquals("fake-model-1", start.model());
    }

    @Test
    void contextPartTextIsCappedButTheCharCountStaysHonest() {
        // A whole conversation can be megabytes — the wire carries a capped
        // text with an honest marker while chars keeps the full truth.
        String huge = "x".repeat(40_000);
        FakeProvider provider = FakeProvider.scripted(List.of(
                new LlmProvider.PTextDelta("ok"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt(huge)
                .registry(new ToolRegistry())
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .introspection(true)
                .build());
        RunEvent.ContextInfo info = collect(agent).stream()
                .filter(RunEvent.ContextInfo.class::isInstance)
                .map(RunEvent.ContextInfo.class::cast)
                .findFirst().orElseThrow();
        RunEvent.ContextPart system = info.parts().get(0);
        assertEquals(40_000, system.chars(), "chars stay the full truth");
        assertTrue(system.text().length() < 20_000, "text is capped");
        assertTrue(system.text().endsWith("chars)"), "truncation marker names the size");
    }

    // ---------------------------------------------------------- attachments

    @Test
    void attachmentsReachTheRunStartAndLeadTheFirstUserMessage() {
        // A real blob, because the loop reloads the bytes for the provider request
        // (user.home is redirected into the build directory by the test task).
        SessionStore.StoredBlob blob = SessionStore.saveBlob(
                "agent-attach-test", new byte[] {(byte) 0x89, 'P', 'N', 'G'}, "image/png");
        RunEvent.Attachment attachment =
                new RunEvent.Attachment("image", "image/png", blob.blobPath(), blob.sha256());
        FakeProvider provider = FakeProvider.scripted(List.of(
                new LlmProvider.PTextDelta("A tiny PNG."),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));

        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agentWith(provider, null, null)
                .run("What is this?", new RunOptions(new CancelSignal(), List.of(attachment)))) {
            stream.forEach(events::add);
        }

        // The run_start event carries the reference — never the bytes.
        RunEvent.RunStart start = (RunEvent.RunStart) events.getFirst();
        assertEquals(List.of(attachment), start.attachments());

        // The provider saw the image block BEFORE the prompt text.
        LlmProvider.ProviderMessage firstUser = provider.requests.getFirst().messages().getFirst();
        LlmProvider.ImageContent image =
                assertInstanceOf(LlmProvider.ImageContent.class, firstUser.content().get(0));
        assertEquals("image/png", image.mediaType());
        assertEquals(Base64.getEncoder().encodeToString(new byte[] {(byte) 0x89, 'P', 'N', 'G'}),
                image.dataBase64());
        assertEquals("What is this?",
                ((LlmProvider.TextContent) firstUser.content().get(1)).text());
    }

    @Test
    void runsWithoutAttachmentsKeepTheFieldAbsent() {
        // The empty list normalizes to null, so @JsonInclude(NON_NULL) keeps the
        // JSONL line byte-identical to pre-bonus sessions — never `[]` on the wire.
        FakeProvider provider = FakeProvider.scripted(List.of(
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));

        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agentWith(provider, null, null)
                .run("hi", new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(events::add);
        }

        RunEvent.RunStart start = (RunEvent.RunStart) events.getFirst();
        assertEquals(null, start.attachments(), "empty list must normalize to null (absent field)");
        LlmProvider.ProviderMessage firstUser = provider.requests.getFirst().messages().getFirst();
        assertEquals(1, firstUser.content().size(), "text only — no empty image blocks");
    }

    // ---- transient retry (additive), end to end ---------------------

    /** Fails transiently a fixed number of times, then serves one scripted turn. */
    private static final class FlakyOnceProvider implements LlmProvider {
        private int failsRemaining;
        private final List<ProviderEvent> turn;

        FlakyOnceProvider(int failsRemaining, List<ProviderEvent> turn) {
            this.failsRemaining = failsRemaining;
            this.turn = turn;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (failsRemaining > 0) {
                failsRemaining--;
                throw new TransientProviderException("Ollama HTTP 503");
            }
            return turn;
        }
    }

    @Test
    void aTransientProviderFailureIsRetriedInvisibly() {
        // Zero backoff so the test is instant; one transient failure then a clean turn.
        RetryPolicy zeroDelay = new RetryPolicy(2, java.time.Duration.ZERO, java.time.Duration.ZERO, 0.0);
        LlmProvider flaky = RetryingProvider.wrap(new FlakyOnceProvider(1, List.of(
                new LlmProvider.PTextDelta("Hello"),
                new LlmProvider.PUsage(10, 5),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN))), zeroDelay);

        List<RunEvent> events = collect(agentWith(flaky, null, null));

        // Identical to a clean run: no ErrorEvent, no duplicated TextDelta.
        assertEquals(List.of(RunEvent.RunStart.class, RunEvent.TurnStart.class,
                        RunEvent.TextDelta.class, RunEvent.Usage.class, RunEvent.RunEnd.class),
                typesOf(events));
        assertEquals("end_turn", ((RunEvent.RunEnd) events.getLast()).stopReason());
        assertTrue(events.stream().noneMatch(RunEvent.ErrorEvent.class::isInstance),
                "a recovered transient failure must not surface as an error");
    }
}
