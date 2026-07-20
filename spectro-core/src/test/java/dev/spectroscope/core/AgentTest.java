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
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

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
        assertEquals(15, turnCount, "the loop must stop exactly at the turn brake");
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
            assertEquals(100_000, info.threshold(), "threshold defaults to 100000");
        }

        // Without the flag the stream stays exactly as before — no context_info at all.
        FakeProvider plainProvider = FakeProvider.scripted(List.of(
                new LlmProvider.PTextDelta("Hello"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        List<RunEvent> plainEvents = collect(agentWith(plainProvider, null, null));
        assertTrue(plainEvents.stream().noneMatch(RunEvent.ContextInfo.class::isInstance),
                "without the flag no context_info is emitted");
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
