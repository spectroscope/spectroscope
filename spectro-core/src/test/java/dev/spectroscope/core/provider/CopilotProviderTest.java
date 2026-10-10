package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.PThinkingDelta;
import dev.spectroscope.core.provider.LlmProvider.PToolCall;
import dev.spectroscope.core.provider.LlmProvider.PUsage;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.DocumentContent;
import dev.spectroscope.core.provider.LlmProvider.ImageContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest.Reasoning;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolCallContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.wire.LlmWireTap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 494: {@link CopilotProvider} against a fake Copilot runtime that speaks
 * the SDK's JSON-RPC. The real SDK client runs in every test; only the runtime
 * process is replaced. Event and request shapes come from card 478's live logs.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CopilotProviderTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String MAC = "Mac OS X";

    private FakeCopilotRuntime runtime;
    private CopilotProvider provider;

    @AfterEach
    void tearDown() throws Exception {
        if (provider != null) {
            provider.close();
        }
        if (runtime != null) {
            runtime.close();
        }
    }

    private CopilotProvider start(String model) throws Exception {
        runtime = new FakeCopilotRuntime();
        provider = new CopilotProvider(new CopilotProvider.Options(model, null, null, false), MAC, runtime.cliUrl());
        return provider;
    }

    private static ProviderRequest ask(List<ProviderMessage> history, List<ToolSpec> tools, CancelSignal signal) {
        return new ProviderRequest("You are a test assistant.", history, tools, 4096, signal);
    }

    private static ProviderMessage user(String text) {
        return new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent(text)));
    }

    private static ToolSpec readFileSpec() {
        return new ToolSpec("read_file", "Reads a file.", JSON.valueToTree(Map.of("type", "object",
                "properties", Map.of("path", Map.of("type", "string")), "required", List.of("path"))));
    }

    private static List<ProviderEvent> drain(Iterable<ProviderEvent> stream) {
        List<ProviderEvent> events = new ArrayList<>();
        stream.forEach(events::add);
        return events;
    }

    private static long stops(List<ProviderEvent> events) {
        return events.stream().filter(e -> e instanceof PStop).count();
    }

    // ---- a text turn -------------------------------------------------------

    @Test
    void aTextTurnStreamsReasoningTextOneUsageAndExactlyOneStop() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            turn.reasoning("Counting.");
            turn.delta("Hel");
            turn.delta("lo");
            turn.usage(5346, 6, 5286, 0, "stop");
            turn.message("Hello", List.of());
            turn.idle();
        });

        List<ProviderEvent> events = drain(provider.stream(ask(List.of(user("Say hello.")), List.of(),
                new CancelSignal())));

        assertEquals(List.of(
                new PThinkingDelta("Counting."),
                new PTextDelta("Hel"),
                new PTextDelta("lo"),
                // inputTokens on the Copilot wire counts the cached part too: 5346 - 5286
                new PUsage(60, 6, 5286, 0),
                new PStop(PStop.StopReason.END_TURN)), events);
        assertEquals(1, stops(events));
        assertEquals("Say hello.", runtime.requests("session.send").getFirst().path("prompt").asText());
    }

    // ---- card 496: AI credits ------------------------------------------------

    @Test
    void aCompleteUsageEventCarriesItsAiCreditsAsTotalNanoAiuOverOneBillion() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            turn.delta("Hi");
            // card 478's live event: 1.03609E9 nano units, status complete, cost 1.0
            turn.usageWithCredits(5294, 34, "complete", 1.03609E9);
            turn.message("Hi", List.of());
            turn.idle();
        });

        PUsage usage = usageOf(drain(provider.stream(ask(List.of(user("Hi.")), List.of(), new CancelSignal()))));

        assertEquals(1.03609, usage.aiCredits().doubleValue(), 1e-9);
    }

    @Test
    void noCreditsAreClaimedWhenTheRuntimeSaysTheyAreIncompleteOrSendsNone() throws Exception {
        for (String status : new String[] {"partial", "unavailable"}) {
            start("claude-sonnet-5");
            runtime.onSend(turn -> {
                turn.delta("Hi");
                turn.usageWithCredits(10, 1, status, 5.0E8);
                turn.message("Hi", List.of());
                turn.idle();
            });
            PUsage usage = usageOf(drain(provider.stream(ask(List.of(user("Hi.")), List.of(),
                    new CancelSignal()))));
            assertNull(usage.aiCredits(), status + " credits are not a number to show");
            provider.close();
            runtime.close();
        }
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            turn.delta("Hi");
            turn.usageWithCredits(10, 1, null, null);
            turn.message("Hi", List.of());
            turn.idle();
        });
        PUsage none = usageOf(drain(provider.stream(ask(List.of(user("Hi.")), List.of(), new CancelSignal()))));
        assertNull(none.aiCredits(), "no copilotUsage, no credits");
        assertEquals(10, none.inputTokens(), "the tokens still arrive");
    }

    @Test
    void eachCallOfOneRuntimeSessionCarriesItsOwnCreditsSoTheirSumIsTheSessionTotal() throws Exception {
        // Card 478's run with claude-sonnet-5 (tools.log, review of 2026-10-10):
        // three assistant.usage events in ONE runtime session carried
        // totalNanoAiu 1.576E8, 1.312E8 and 1.53E8, each equal to its own call's
        // tokens at the model's price, and the runtime's session.usage_checkpoint
        // after the third read 4.418E8, their sum. So the field is per call, and
        // adding the calls up is the session total.
        double[] perCall = {1.576E8, 1.312E8, 1.53E8};
        start("claude-sonnet-5");
        for (double nano : perCall) {
            runtime.onSend(turn -> {
                turn.delta("ok");
                turn.usageWithCredits(10, 1, "complete", nano);
                turn.message("ok", List.of());
                turn.idle();
            });
        }
        List<ProviderMessage> history = new ArrayList<>(List.of(user("One.")));
        double sum = 0;
        for (int call = 0; call < perCall.length; call++) {
            PUsage usage = usageOf(drain(provider.stream(ask(history, List.of(), new CancelSignal()))));
            assertEquals(perCall[call] / 1e9, usage.aiCredits().doubleValue(), 1e-12, "call " + (call + 1));
            sum += usage.aiCredits();
            history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent("ok"))));
            history.add(user("Again."));
        }
        assertEquals(1, runtime.requests("session.create").size(), "one runtime session for all three calls");
        assertEquals(4.418E8 / 1e9, sum, 1e-12, "the checkpoint's session total");
    }

    private static PUsage usageOf(List<ProviderEvent> events) {
        return events.stream().filter(e -> e instanceof PUsage).map(e -> (PUsage) e).findFirst().orElseThrow();
    }

    @Test
    void theSessionIsCreatedWithBuiltInToolsOffAndTheHarnessPromptInPlaceOfCopilots() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            turn.delta("ok");
            turn.usage(10, 1, 0, 0, "stop");
            turn.idle();
        });

        drain(provider.stream(ask(List.of(user("hi")), List.of(readFileSpec()), new CancelSignal())));

        JsonNode create = runtime.createParams();
        assertEquals("claude-sonnet-5", create.path("model").asText());
        assertEquals(List.of("custom:*"), strings(create.path("availableTools")));
        assertTrue(strings(create.path("excludedTools")).containsAll(List.of("builtin:*", "mcp:*")),
                create.path("excludedTools").toString());
        assertEquals("replace", create.path("systemMessage").path("mode").asText());
        assertEquals("You are a test assistant.", create.path("systemMessage").path("content").asText());
        assertTrue(create.path("streaming").asBoolean(), create.toString());
        List<String> toolNames = new ArrayList<>();
        create.path("tools").forEach(t -> toolNames.add(t.path("name").asText()));
        assertEquals(List.of("read_file"), toolNames);
    }

    @Test
    void everyHarnessToolOverridesTheBuiltInOfTheSameName() throws Exception {
        // Card 496, live: the runtime refused the first turn of a real chat with
        // 'External tool "glob" conflicts with a built-in tool of the same name.
        // Set overridesBuiltInTool: true to explicitly override it.' The harness
        // has glob, grep and more under the built-ins' own names, and runs them itself.
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            turn.delta("ok");
            turn.usage(10, 1, 0, 0, "stop");
            turn.idle();
        });
        ToolSpec glob = new ToolSpec("glob", "Finds files.", JSON.valueToTree(Map.of("type", "object")));

        drain(provider.stream(ask(List.of(user("hi")), List.of(readFileSpec(), glob), new CancelSignal())));

        JsonNode tools = runtime.createParams().path("tools");
        assertEquals(2, tools.size(), tools.toString());
        tools.forEach(t -> assertTrue(t.path("overridesBuiltInTool").asBoolean(false), t.toString()));
    }

    private static List<String> strings(JsonNode array) {
        List<String> out = new ArrayList<>();
        array.forEach(n -> out.add(n.asText()));
        return out;
    }

    // ---- a tool call turn ----------------------------------------------------

    @Test
    void aToolCallEndsTheStreamAndTheNextStreamDeliversTheHarnessResult() throws Exception {
        start("claude-sonnet-5");
        List<String> permissionKinds = new CopyOnWriteArrayList<>();
        List<JsonNode> delivered = new CopyOnWriteArrayList<>();
        runtime.onSend(turn -> {
            turn.usage(538, 50, 0, 0, "tool_calls");
            turn.message("", List.of(Map.of("toolCallId", "toolu_1", "name", "read_file",
                    "arguments", Map.of("path", "a.txt"), "type", "function")));
            permissionKinds.add(turn.askPermission(Map.of("kind", "custom-tool", "toolCallId", "toolu_1",
                    "toolName", "read_file", "args", Map.of("path", "a.txt"))));
            String requestId = turn.requestTool("toolu_1", "read_file", Map.of("path", "a.txt"));
            delivered.add(turn.awaitToolResult(requestId, Duration.ofSeconds(20)));
            turn.event("external_tool.completed", FakeCopilotRuntime.object(Map.of("requestId", requestId)));
            turn.delta("The file says hi.");
            turn.usage(620, 6, 538, 0, "stop");
            turn.idle();
        });

        List<ProviderMessage> history = new ArrayList<>(List.of(user("What is in a.txt?")));
        List<ProviderEvent> first = drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));

        assertEquals(List.of(
                new PUsage(538, 50, 0, 0),
                new PToolCall("toolu_1", "read_file", JSON.valueToTree(Map.of("path", "a.txt"))),
                new PStop(PStop.StopReason.TOOL_USE)), first);
        assertEquals(List.of("approve-once"), permissionKinds);

        // The harness ran the tool itself and hands the result back in the next request.
        history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.<ProviderContent>of(
                new ToolCallContent("toolu_1", "read_file", JSON.valueToTree(Map.of("path", "a.txt"))))));
        history.add(new ProviderMessage(ProviderMessage.Role.USER, List.<ProviderContent>of(
                new ToolResultContent("toolu_1", "hi", false))));
        List<ProviderEvent> second = drain(provider.stream(ask(history, List.of(readFileSpec()),
                new CancelSignal())));

        assertEquals(List.of(
                new PTextDelta("The file says hi."),
                new PUsage(82, 6, 538, 0),
                new PStop(PStop.StopReason.END_TURN)), second);
        assertEquals(1, runtime.requests("session.send").size(), "a tool result is not a new user message");
        assertEquals(1, runtime.requests("session.create").size(), "one runtime session for the whole turn");
        assertEquals("hi", delivered.getFirst().path("result").path("textResultForLlm").asText());
        assertEquals("success", delivered.getFirst().path("result").path("resultType").asText());
        assertTrue(runtime.scriptFailures().isEmpty(), runtime.scriptFailures().toString());
    }

    @Test
    void aFailedHarnessToolReachesTheModelAsAFailure() throws Exception {
        start("claude-sonnet-5");
        List<JsonNode> delivered = new CopyOnWriteArrayList<>();
        runtime.onSend(turn -> {
            turn.usage(538, 50, 0, 0, "tool_calls");
            turn.message("", List.of(Map.of("toolCallId", "toolu_9", "name", "read_file",
                    "arguments", Map.of("path", "missing.txt"), "type", "function")));
            turn.askPermission(Map.of("kind", "custom-tool", "toolCallId", "toolu_9", "toolName", "read_file"));
            String requestId = turn.requestTool("toolu_9", "read_file", Map.of("path", "missing.txt"));
            delivered.add(turn.awaitToolResult(requestId, Duration.ofSeconds(20)));
            turn.delta("No such file.");
            turn.usage(600, 4, 538, 0, "stop");
            turn.idle();
        });
        List<ProviderMessage> history = new ArrayList<>(List.of(user("Read missing.txt")));
        drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));
        history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.<ProviderContent>of(
                new ToolCallContent("toolu_9", "read_file", JSON.valueToTree(Map.of("path", "missing.txt"))))));
        history.add(new ProviderMessage(ProviderMessage.Role.USER, List.<ProviderContent>of(
                new ToolResultContent("toolu_9", "ERROR: no such file", true))));
        drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));

        JsonNode result = delivered.getFirst().path("result");
        assertEquals("failure", result.path("resultType").asText(), delivered.toString());
        assertEquals("ERROR: no such file", result.path("textResultForLlm").asText());
    }

    // ---- permissions: deny by default -----------------------------------------

    @Test
    void theRuntimeMayNotRunAToolOfItsOwn() throws Exception {
        start("claude-sonnet-5");
        Map<String, String> answers = new HashMap<>();
        runtime.onSend(turn -> {
            answers.put("shell", turn.askPermission(Map.of("kind", "shell", "toolCallId", "c1",
                    "fullCommandText", "ls")));
            answers.put("write", turn.askPermission(Map.of("kind", "write", "toolCallId", "c2",
                    "fileName", "x.txt")));
            answers.put("unregistered custom tool", turn.askPermission(Map.of("kind", "custom-tool",
                    "toolCallId", "c3", "toolName", "bash")));
            answers.put("url", turn.askPermission(Map.of("kind", "url", "toolCallId", "c4",
                    "url", "https://example.com")));
            turn.delta("NO_SHELL_TOOL");
            turn.usage(40, 4, 0, 0, "stop");
            turn.idle();
        });

        List<ProviderEvent> events = drain(provider.stream(ask(List.of(user("Run ls.")),
                List.of(readFileSpec()), new CancelSignal())));

        assertEquals(new PStop(PStop.StopReason.END_TURN), events.getLast());
        assertEquals(4, answers.size(), answers.toString());
        answers.forEach((kind, answer) -> assertEquals("reject", answer, kind));
    }

    // ---- cancel ------------------------------------------------------------------

    @Test
    void cancelAbortsTheRuntimeTurnAndNoFurtherEventArrives() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            for (int i = 0; i < 400 && !turn.aborted(); i++) {
                turn.delta("x");
                FakeCopilotRuntime.sleep(25);
            }
        });
        runtime.onSend(turn -> {
            // Slower than the abort's own tail below: anything of the aborted
            // turn that the provider did not wait for would land in this turn.
            FakeCopilotRuntime.sleep(300);
            turn.delta("fresh");
            turn.usage(20, 1, 0, 0, "stop");
            turn.idle();
        });
        runtime.abortTail(turn -> {
            FakeCopilotRuntime.sleep(100);
            turn.delta("late");
            turn.delta("late");
        });

        CancelSignal signal = new CancelSignal();
        List<ProviderEvent> events = new ArrayList<>();
        List<ProviderMessage> history = new ArrayList<>(List.of(user("Write an essay.")));
        for (ProviderEvent event : provider.stream(ask(history, List.of(), signal))) {
            events.add(event);
            if (event instanceof PTextDelta && !signal.isCancelled()) {
                signal.cancel();
            }
        }

        assertEquals(new PStop(PStop.StopReason.ABORTED), events.getLast());
        assertEquals(1, stops(events));
        assertFalse(events.contains(new PTextDelta("late")), events.toString());
        assertEquals(1, runtime.requests("session.abort").size());

        history.add(user("Something short instead."));
        List<ProviderEvent> next = drain(provider.stream(ask(history, List.of(), new CancelSignal())));
        assertEquals(List.of(new PTextDelta("fresh"), new PUsage(20, 1, 0, 0),
                new PStop(PStop.StopReason.END_TURN)), next);
    }

    // ---- the model list --------------------------------------------------------

    @Test
    void theModelListWindowAndVisionComeFromTheRuntime() throws Exception {
        start("claude-sonnet-5");
        List<CopilotProvider.CopilotModel> models = provider.models();

        assertEquals(List.of("auto", "claude-sonnet-5", "fixture-blind-model", "fixture-switch-model"),
                models.stream().map(CopilotProvider.CopilotModel::id).toList());
        assertEquals(936_000, provider.contextWindow(), "max_prompt_tokens of the chosen model");
        assertEquals(LlmProvider.Vision.SEES, provider.vision());
        assertEquals(1, runtime.requests("models.list").size(), "asked once, then remembered");
    }

    @Test
    void aBlindModelSaysSoAndAWindowFallsBackToTheContextWindow() throws Exception {
        start("fixture-blind-model");
        assertEquals(LlmProvider.Vision.BLIND, provider.vision());
        assertEquals(128_000, provider.contextWindow());
    }

    @Test
    void autoHasNoCapabilitiesSoNothingIsClaimed() throws Exception {
        start("auto");
        assertEquals(LlmProvider.Vision.UNKNOWN, provider.vision());
        assertEquals(0, provider.contextWindow());
    }

    // ---- the runtime dies --------------------------------------------------------

    @Test
    void aRuntimeThatDiesMidStreamIsAnErrorNotASilentEnd() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            turn.delta("partial");
            FakeCopilotRuntime.sleep(100);
            turn.die();
        });

        Iterator<ProviderEvent> stream = provider.stream(ask(List.of(user("hi")), List.of(),
                new CancelSignal())).iterator();
        assertEquals(new PTextDelta("partial"), stream.next());
        RuntimeException failure = assertThrows(RuntimeException.class, () -> {
            while (stream.hasNext()) {
                stream.next();
            }
        });
        assertTrue(failure.getMessage().contains("copilot runtime"), failure.getMessage());
    }

    @Test
    void aSessionErrorFromTheRuntimeIsRaisedWithItsMessage() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> turn.event("session.error", FakeCopilotRuntime.object(Map.of(
                "errorType", "quota", "message", "You have no AI credits left."))));

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> drain(provider.stream(ask(List.of(user("hi")), List.of(), new CancelSignal()))));
        assertTrue(failure.getMessage().contains("You have no AI credits left."), failure.getMessage());
    }

    // ---- history the runtime did not see ---------------------------------------

    @Test
    void aHistoryTheRuntimeDidNotSeeStartsANewSessionCarryingTheTranscript() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            turn.delta("Blue.");
            turn.usage(10, 1, 0, 0, "stop");
            turn.idle();
        });
        runtime.onSend(turn -> {
            turn.delta("Green.");
            turn.usage(30, 1, 0, 0, "stop");
            turn.idle();
        });
        drain(provider.stream(ask(List.of(user("Pick a colour.")), List.of(), new CancelSignal())));

        // A history the runtime never saw: the harness compacted, or a session was resumed.
        List<ProviderMessage> other = List.of(
                user("Summary of earlier work: the user likes trees."),
                new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent("Noted."))),
                user("Pick another colour."));
        drain(provider.stream(ask(other, List.of(), new CancelSignal())));

        assertEquals(2, runtime.requests("session.create").size());
        String prompt = runtime.requests("session.send").get(1).path("prompt").asText();
        assertTrue(prompt.contains("the user likes trees"), prompt);
        assertTrue(prompt.contains("Noted."), prompt);
        assertTrue(prompt.endsWith("Pick another colour."), prompt);
    }

    @Test
    void aContinuationOfTheSameConversationReusesTheRuntimeSession() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            turn.delta("Blue.");
            turn.usage(10, 1, 0, 0, "stop");
            turn.idle();
        });
        runtime.onSend(turn -> {
            turn.delta("Green.");
            turn.usage(30, 1, 0, 0, "stop");
            turn.idle();
        });
        List<ProviderMessage> history = new ArrayList<>(List.of(user("Pick a colour.")));
        drain(provider.stream(ask(history, List.of(), new CancelSignal())));
        history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent("Blue."))));
        history.add(user("Another one."));
        drain(provider.stream(ask(history, List.of(), new CancelSignal())));

        assertEquals(1, runtime.requests("session.create").size());
        assertEquals("Another one.", runtime.requests("session.send").get(1).path("prompt").asText());
    }

    @Test
    void anOldToolResultSentAsAStubStillContinuesTheSameRuntimeSession() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            turn.usage(538, 50, 0, 0, "tool_calls");
            turn.message("", List.of(Map.of("toolCallId", "toolu_2", "name", "read_file",
                    "arguments", Map.of("path", "big.txt"), "type", "function")));
            turn.askPermission(Map.of("kind", "custom-tool", "toolCallId", "toolu_2", "toolName", "read_file"));
            String requestId = turn.requestTool("toolu_2", "read_file", Map.of("path", "big.txt"));
            turn.awaitToolResult(requestId, Duration.ofSeconds(20));
            turn.delta("Read it.");
            turn.usage(900, 3, 538, 0, "stop");
            turn.idle();
        });
        runtime.onSend(turn -> {
            turn.delta("Still here.");
            turn.usage(950, 3, 900, 0, "stop");
            turn.idle();
        });
        JsonNode input = JSON.valueToTree(Map.of("path", "big.txt"));
        List<ProviderMessage> history = new ArrayList<>(List.of(user("Read big.txt")));
        drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));
        history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.<ProviderContent>of(
                new ToolCallContent("toolu_2", "read_file", input))));
        history.add(new ProviderMessage(ProviderMessage.Role.USER, List.<ProviderContent>of(
                new ToolResultContent("toolu_2", "x".repeat(5000), false))));
        drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));
        history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent("Read it."))));
        history.add(user("Are you still there?"));

        // Card 467: the harness now sends the old result as a one-line stub.
        List<ProviderMessage> elided = new ArrayList<>(history);
        elided.set(2, new ProviderMessage(ProviderMessage.Role.USER, List.<ProviderContent>of(
                new ToolResultContent("toolu_2", "[elided: call read_file again to read it]", false))));
        drain(provider.stream(ask(elided, List.of(readFileSpec()), new CancelSignal())));

        assertEquals(1, runtime.requests("session.create").size(), "the stub is not a different history");
        assertEquals("Are you still there?", runtime.requests("session.send").get(1).path("prompt").asText());
    }

    // ---- credentials and the wire record ---------------------------------------

    @Test
    void theTokenReachesTheRuntimeThroughTheCallbackAndNowhereElse() throws Exception {
        runtime = new FakeCopilotRuntime();
        String token = "gho_" + "fixtureTokenNotReal0123456789";
        List<String> askedFor = new CopyOnWriteArrayList<>();
        CopilotProvider.TokenSource source = (host, reason) -> {
            askedFor.add(host + " " + reason);
            return new CopilotProvider.Token(token, 3600);
        };
        provider = new CopilotProvider(new CopilotProvider.Options("claude-sonnet-5", null, source, false),
                MAC, runtime.cliUrl());
        List<JsonNode> tokenAnswers = new CopyOnWriteArrayList<>();
        runtime.onSend(turn -> {
            tokenAnswers.add(turn.callClient("gitHubToken.getToken", FakeCopilotRuntime.object(Map.of(
                    "registrationId", runtime.createParams().path("gitHubTokenProviderRegistrationId").asText(),
                    "host", "https://github.com", "sessionId", turn.sessionId(), "reason", "initial"))));
            turn.delta("ok");
            turn.usage(10, 1, 0, 0, "stop");
            turn.idle();
        });
        RecordingTap tap = new RecordingTap();

        drain(provider.stream(new ProviderRequest("system", List.of(user("hi")), List.of(), 4096,
                LlmProvider.ProviderRequest.Reasoning.DEFAULT, null, new CancelSignal(), tap)));

        assertEquals(List.of("https://github.com initial"), askedFor);
        assertTrue(tokenAnswers.getFirst().toString().contains(token), "the runtime got the token");
        assertFalse(tap.everything().contains(token), "the wire record carries no token");
        assertFalse(tap.everything().contains("fixtureTokenNotReal"), "not even a part of it");
        assertFalse(new CopilotProvider.Token(token, 3600).toString().contains("fixtureTokenNotReal"));
        assertTrue(tap.everything().contains("\"prompt\":\"hi\""), tap.everything());
        assertEquals("copilot", tap.requests.getFirst().provider());
        assertEquals(1, tap.outcomes.size());
    }

    @Test
    void theRuntimeEnvironmentCarriesNoTokenVariables() {
        Map<String, String> env = Map.of("PATH", "/usr/bin", "COPILOT_GITHUB_TOKEN", "a", "GH_TOKEN", "b",
                "GITHUB_TOKEN", "c", "GITHUB_COPILOT_API_TOKEN", "d", "COPILOT_API_URL", "https://example.com",
                "HOME", "/home/someone");
        assertEquals(Map.of("PATH", "/usr/bin", "HOME", "/home/someone"), CopilotProvider.runtimeEnvironment(env));
    }

    // ---- platform ----------------------------------------------------------------

    @Test
    void onlyMacOsIsSupportedAndEveryOtherPlatformSaysSo() {
        assertTrue(CopilotProvider.supportedPlatform("Mac OS X"));
        for (String os : List.of("Linux", "Windows 11", "FreeBSD")) {
            assertFalse(CopilotProvider.supportedPlatform(os), os);
            CopilotProvider elsewhere = new CopilotProvider(
                    new CopilotProvider.Options("claude-sonnet-5", null, null, false), os, null);
            UnsupportedOperationException streamed = assertThrows(UnsupportedOperationException.class,
                    () -> elsewhere.stream(ask(List.of(user("hi")), List.of(), new CancelSignal())).iterator());
            assertTrue(streamed.getMessage().contains("not supported on this platform"), streamed.getMessage());
            assertThrows(UnsupportedOperationException.class, elsewhere::models);
            assertEquals(0, elsewhere.contextWindow());
            assertEquals(LlmProvider.Vision.UNKNOWN, elsewhere.vision());
        }
    }

    // ---- the scenario: the harness loop runs the tool ------------------------------

    @Test
    void copilotAnswersThroughTheHarnessLoop() throws Exception {
        start("claude-sonnet-5");
        Map<String, String> builtInAnswer = new HashMap<>();
        runtime.onSend(turn -> {
            builtInAnswer.put("shell", turn.askPermission(Map.of("kind", "shell", "toolCallId", "b1",
                    "fullCommandText", "cat a.txt")));
            turn.usage(538, 50, 0, 0, "tool_calls");
            turn.message("", List.of(Map.of("toolCallId", "toolu_7", "name", "read_file",
                    "arguments", Map.of("path", "a.txt"), "type", "function")));
            turn.askPermission(Map.of("kind", "custom-tool", "toolCallId", "toolu_7", "toolName", "read_file"));
            String requestId = turn.requestTool("toolu_7", "read_file", Map.of("path", "a.txt"));
            JsonNode result = turn.awaitToolResult(requestId, Duration.ofSeconds(20));
            turn.delta("It says: " + result.path("result").path("textResultForLlm").asText());
            turn.usage(620, 6, 538, 0, "stop");
            turn.idle();
        });
        List<JsonNode> ranWith = new CopyOnWriteArrayList<>();
        Tool readFile = new Tool() {
            public String name() { return "read_file"; }
            public String description() { return "Reads a file."; }
            public JsonNode inputSchema() { return readFileSpec().inputSchema(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) {
                ranWith.add(input);
                return "hello from the harness";
            }
        };
        ToolRegistry registry = new ToolRegistry();
        registry.register(readFile);
        Agent agent = new Agent(AgentOptions.builder().provider(provider).systemPrompt("test")
                .registry(registry).cwd(Path.of(".")).onPermission(request -> true).build());

        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("What is in a.txt?", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }

        assertEquals(List.of(JSON.valueToTree(Map.of("path", "a.txt"))), ranWith, "the harness ran the tool");
        assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.ToolCall c && c.name().equals("read_file")));
        String text = events.stream().filter(e -> e instanceof RunEvent.TextDelta)
                .map(e -> ((RunEvent.TextDelta) e).text()).reduce("", String::concat);
        assertEquals("It says: hello from the harness", text);
        assertEquals("reject", builtInAnswer.get("shell"), "the built-in request was refused");
        assertNotEquals("error", ((RunEvent.RunEnd) events.getLast()).stopReason());
    }

    // ---- review of 2026-10-09: reasoning control -------------------------------

    private static ProviderRequest ask(String system, List<ProviderMessage> history, List<ToolSpec> tools,
                                       Reasoning reasoning, String effort, CancelSignal signal) {
        return new ProviderRequest(system, history, tools, 4096, reasoning, effort, signal);
    }

    private static Consumer<FakeCopilotRuntime.Turn> says(String text) {
        return turn -> {
            turn.delta(text);
            turn.usage(10, 1, 0, 0, "stop");
            turn.idle();
        };
    }

    private JsonNode createParams(int index) {
        return runtime.requests("session.create").get(index);
    }

    @Test
    void anEffortTheModelListsIsSetWhenTheSessionOpens() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(says("ok"));
        drain(provider.stream(ask("s", List.of(user("hi")), List.of(), Reasoning.DEFAULT, "high", new CancelSignal())));
        assertEquals("high", createParams(0).path("reasoningEffort").asText(), createParams(0).toString());
    }

    @Test
    void anEffortTheModelDoesNotListIsNotSent() throws Exception {
        start("claude-sonnet-5"); // the fixture lists low, medium and high for it
        runtime.onSend(says("ok"));
        List<ProviderEvent> events = drain(provider.stream(ask("s", List.of(user("hi")), List.of(),
                Reasoning.DEFAULT, "max", new CancelSignal())));
        assertEquals(new PStop(PStop.StopReason.END_TURN), events.getLast());
        assertTrue(createParams(0).path("reasoningEffort").isMissingNode()
                || createParams(0).path("reasoningEffort").isNull(), createParams(0).toString());
    }

    @Test
    void reasoningOffSendsNoneWhereTheModelListsIt() throws Exception {
        start("fixture-switch-model");
        runtime.onSend(says("ok"));
        drain(provider.stream(ask("s", List.of(user("hi")), List.of(), Reasoning.OFF, "high", new CancelSignal())));
        assertEquals("none", createParams(0).path("reasoningEffort").asText(), createParams(0).toString());
    }

    @Test
    void reasoningOffSendsNothingWhereTheModelHasNoOffSwitch() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(says("ok"));
        List<ProviderEvent> events = drain(provider.stream(ask("s", List.of(user("hi")), List.of(),
                Reasoning.OFF, "high", new CancelSignal())));
        assertEquals(new PStop(PStop.StopReason.END_TURN), events.getLast());
        assertTrue(createParams(0).path("reasoningEffort").isMissingNode()
                || createParams(0).path("reasoningEffort").isNull(), createParams(0).toString());
    }

    @Test
    void aModelTheListDoesNotDescribeGetsNoEffort() throws Exception {
        start("auto");
        runtime.onSend(says("ok"));
        drain(provider.stream(ask("s", List.of(user("hi")), List.of(), Reasoning.ON, "high", new CancelSignal())));
        assertEquals("auto", createParams(0).path("model").asText());
        assertTrue(createParams(0).path("reasoningEffort").isMissingNode()
                || createParams(0).path("reasoningEffort").isNull(), createParams(0).toString());
    }

    @Test
    void theReasoningCapabilityIsReadFromTheModelList() throws Exception {
        start("fixture-switch-model");
        ReasoningCapability withOff = provider.reasoningCapability();
        assertEquals("effort", withOff.control());
        assertTrue(withOff.offSwitch());
        assertEquals(List.of("none", "low", "high"), withOff.efforts());
        assertEquals("low", withOff.defaultEffort());
        assertEquals("api", withOff.source());

        // The fake serves one client at a time: the first provider lets go before the next one asks.
        provider.close();
        provider = new CopilotProvider(new CopilotProvider.Options("claude-sonnet-5", null, null, false),
                MAC, runtime.cliUrl());
        ReasoningCapability noOff = provider.reasoningCapability();
        assertEquals("effort", noOff.control());
        assertFalse(noOff.offSwitch());
        assertEquals(List.of("low", "medium", "high"), noOff.efforts());
    }

    @Test
    void aLaterRequestWithAnotherListedEffortSwitchesTheSessionsEffort() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(says("Blue."));
        runtime.onSend(says("Green."));
        List<ProviderMessage> history = new ArrayList<>(List.of(user("Pick a colour.")));
        drain(provider.stream(ask("s", history, List.of(), Reasoning.DEFAULT, "low", new CancelSignal())));
        history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent("Blue."))));
        history.add(user("Another one."));
        drain(provider.stream(ask("s", history, List.of(), Reasoning.DEFAULT, "high", new CancelSignal())));

        assertEquals(1, runtime.requests("session.create").size());
        List<JsonNode> switches = runtime.requests("session.model.switchTo");
        assertEquals(1, switches.size(), runtime.requests().toString());
        assertEquals("claude-sonnet-5", switches.getFirst().path("modelId").asText());
        assertEquals("high", switches.getFirst().path("reasoningEffort").asText());
    }

    // ---- review of 2026-10-09: guarantees no test pinned ----------------------

    @Test
    void toolsThatChangeMidConversationAreSetOnTheRuntimeSessionAndApproved() throws Exception {
        start("claude-sonnet-5");
        Map<String, String> answers = new HashMap<>();
        runtime.onSend(says("one"));
        runtime.onSend(turn -> {
            answers.put("write_file", turn.askPermission(Map.of("kind", "custom-tool", "toolCallId", "w1",
                    "toolName", "write_file")));
            turn.delta("two");
            turn.usage(10, 1, 0, 0, "stop");
            turn.idle();
        });
        ToolSpec writeFile = new ToolSpec("write_file", "Writes a file.", JSON.valueToTree(Map.of("type", "object")));
        List<ProviderMessage> history = new ArrayList<>(List.of(user("first")));
        drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));
        history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent("one"))));
        history.add(user("second"));
        drain(provider.stream(ask(history, List.of(readFileSpec(), writeFile), new CancelSignal())));

        assertEquals(1, runtime.requests("session.create").size());
        List<JsonNode> sets = runtime.requests("session.tools.set");
        assertEquals(1, sets.size(), runtime.requests().toString());
        List<String> names = new ArrayList<>();
        sets.getFirst().path("tools").forEach(t -> names.add(t.path("name").asText()));
        assertEquals(List.of("read_file", "write_file"), names);
        assertEquals("approve-once", answers.get("write_file"));
    }

    @Test
    void aFailingTokenSourceDoesNotPassItsMessageOn() throws Exception {
        runtime = new FakeCopilotRuntime();
        String secret = "gho_" + "fixtureSecretInAMessage42";
        CopilotProvider.TokenSource source = (host, reason) -> {
            throw new IllegalStateException("keychain said " + secret);
        };
        provider = new CopilotProvider(new CopilotProvider.Options("claude-sonnet-5", null, source, false),
                MAC, runtime.cliUrl());
        List<JsonNode> answers = new CopyOnWriteArrayList<>();
        runtime.onSend(turn -> {
            answers.add(turn.callClient("gitHubToken.getToken", FakeCopilotRuntime.object(Map.of(
                    "registrationId", runtime.createParams().path("gitHubTokenProviderRegistrationId").asText(),
                    "host", "https://github.com", "sessionId", turn.sessionId(), "reason", "initial"))));
            turn.delta("ok");
            turn.usage(10, 1, 0, 0, "stop");
            turn.idle();
        });

        drain(provider.stream(ask(List.of(user("hi")), List.of(), new CancelSignal())));

        JsonNode answer = answers.getFirst();
        assertTrue(answer.has("error"), answer.toString());
        assertTrue(answer.path("error").path("message").asText().contains("the token source gave no token"),
                answer.toString());
        assertFalse(answer.toString().contains("fixtureSecretInAMessage"), answer.toString());
    }

    @Test
    void aTurnCutOffByTheOutputLimitStopsWithMaxTokens() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            turn.delta("Once upon");
            turn.usage(10, 4096, 0, 0, "length");
            turn.idle();
        });
        List<ProviderEvent> events = drain(provider.stream(ask(List.of(user("Tell a long story.")), List.of(),
                new CancelSignal())));
        assertEquals(new PStop(PStop.StopReason.MAX_TOKENS), events.getLast());
        assertEquals(1, stops(events));
    }

    @Test
    void aConversationWithoutASystemPromptStillReusesItsRuntimeSession() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(says("Blue."));
        runtime.onSend(says("Green."));
        List<ProviderMessage> history = new ArrayList<>(List.of(user("Pick a colour.")));
        drain(provider.stream(ask(null, history, List.of(), Reasoning.DEFAULT, null, new CancelSignal())));
        history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent("Blue."))));
        history.add(user("Another one."));
        drain(provider.stream(ask(null, history, List.of(), Reasoning.DEFAULT, null, new CancelSignal())));

        assertEquals(1, runtime.requests("session.create").size(), "one runtime session for both turns");
        assertEquals("Another one.", runtime.requests("session.send").get(1).path("prompt").asText());
        assertEquals("", createParams(0).path("systemMessage").path("content").asText());
    }

    @Test
    void aFailedModelListIsNotAskedAgainOnEveryCapabilityQuestion() throws Exception {
        start("claude-sonnet-5");
        runtime.failModels();

        assertEquals(LlmProvider.Vision.UNKNOWN, provider.vision());
        assertEquals(0, provider.contextWindow());
        assertEquals(LlmProvider.Vision.UNKNOWN, provider.vision());
        assertEquals("none", provider.reasoningCapability().control());
        assertEquals(1, runtime.requests("models.list").size(), "the getters ask once, then wait");

        // An explicit call still asks, and says why it failed.
        IllegalStateException failure = assertThrows(IllegalStateException.class, provider::models);
        assertTrue(failure.getMessage().contains("not signed in"), failure.getMessage());
        assertEquals(2, runtime.requests("models.list").size());
    }

    @Test
    void aRuntimeThatDiedIsStartedAgainForTheNextRequest() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            turn.delta("partial");
            FakeCopilotRuntime.sleep(100);
            turn.die();
        });
        runtime.onSend(says("back"));

        assertThrows(IllegalStateException.class,
                () -> drain(provider.stream(ask(List.of(user("hi")), List.of(), new CancelSignal()))));
        List<ProviderEvent> next = drain(provider.stream(ask(List.of(user("hi again")), List.of(),
                new CancelSignal())));

        assertEquals(List.of(new PTextDelta("back"), new PUsage(10, 1, 0, 0),
                new PStop(PStop.StopReason.END_TURN)), next);
        assertEquals(2, runtime.requests("connect").size(), "a second runtime connection");
    }

    @Test
    void aRuntimeThatDiesUnderTheAgentEndsTheRunWithAnErrorTheOperatorSees() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            turn.delta("partial");
            FakeCopilotRuntime.sleep(100);
            turn.die();
        });
        Agent agent = new Agent(AgentOptions.builder().provider(provider).systemPrompt("test")
                .registry(new ToolRegistry()).cwd(Path.of(".")).onPermission(request -> true).build());

        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("hi", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }

        RunEvent.ErrorEvent error = events.stream().filter(e -> e instanceof RunEvent.ErrorEvent)
                .map(e -> (RunEvent.ErrorEvent) e).findFirst().orElseThrow(() -> new AssertionError(events));
        assertTrue(error.message().contains("copilot runtime"), error.message());
        assertEquals("error", ((RunEvent.RunEnd) events.getLast()).stopReason());
    }

    @Test
    void aToolTurnTheHarnessWalkedAwayFromIsClosedNotLeftWaiting() throws Exception {
        start("claude-sonnet-5");
        List<JsonNode> delivered = new CopyOnWriteArrayList<>();
        runtime.onSend(turn -> {
            turn.usage(538, 50, 0, 0, "tool_calls");
            turn.message("", List.of(Map.of("toolCallId", "toolu_5", "name", "read_file",
                    "arguments", Map.of("path", "a.txt"), "type", "function")));
            turn.askPermission(Map.of("kind", "custom-tool", "toolCallId", "toolu_5", "toolName", "read_file"));
            String requestId = turn.requestTool("toolu_5", "read_file", Map.of("path", "a.txt"));
            delivered.add(turn.awaitToolResult(requestId, Duration.ofSeconds(20)));
        });
        runtime.onSend(says("hi"));

        List<ProviderMessage> history = new ArrayList<>(List.of(user("What is in a.txt?")));
        List<ProviderEvent> first = drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));
        assertEquals(new PStop(PStop.StopReason.TOOL_USE), first.getLast());

        // The run was cancelled while the tool ran; the operator's next message carries no result.
        history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.<ProviderContent>of(
                new ToolCallContent("toolu_5", "read_file", JSON.valueToTree(Map.of("path", "a.txt"))))));
        history.add(user("Never mind, say hi."));
        List<ProviderEvent> second = drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));

        assertEquals(new PStop(PStop.StopReason.END_TURN), second.getLast());
        String stranded = createParams(0).path("sessionId").asText();
        assertTrue(runtime.requests("session.detach").stream()
                .anyMatch(d -> stranded.equals(d.path("sessionId").asText())), runtime.requests().toString());
        JsonNode failed = delivered.getFirst().path("result");
        assertEquals("error", failed.path("resultType").asText(), delivered.toString());
        assertEquals("the conversation was closed", failed.path("error").asText());
    }

    @Test
    void atMostEightRuntimeSessionsStayOpenAndTheOldestClosesFirst() throws Exception {
        start("claude-sonnet-5");
        for (int i = 0; i < 9; i++) {
            runtime.onSend(says("ok " + i));
        }
        for (int i = 0; i < 9; i++) {
            drain(provider.stream(ask(List.of(user("conversation " + i)), List.of(), new CancelSignal())));
        }

        List<JsonNode> detached = runtime.requests("session.detach");
        assertEquals(1, detached.size(), detached.toString());
        assertEquals(createParams(0).path("sessionId").asText(), detached.getFirst().path("sessionId").asText());
    }

    @Test
    void aStreamNobodyFinishedReadingDoesNotKeepOlderSessionsOpen() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            turn.delta("a");
            FakeCopilotRuntime.sleep(200);
            turn.idle();
        });
        for (int i = 1; i < 9; i++) {
            runtime.onSend(says("ok " + i));
        }
        Iterator<ProviderEvent> abandoned = provider.stream(ask(List.of(user("conversation 0")), List.of(),
                new CancelSignal())).iterator();
        assertEquals(new PTextDelta("a"), abandoned.next());
        for (int i = 1; i < 9; i++) {
            drain(provider.stream(ask(List.of(user("conversation " + i)), List.of(), new CancelSignal())));
        }

        // Nine sessions, one of them still marked as streaming: the oldest idle one closes.
        List<JsonNode> detached = runtime.requests("session.detach");
        assertEquals(1, detached.size(), detached.toString());
        assertEquals(createParams(1).path("sessionId").asText(), detached.getFirst().path("sessionId").asText());
    }

    @Test
    void imagesAndDocumentsInAUserMessageGoAsBlobAttachments() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(says("A chart."));
        ProviderMessage message = new ProviderMessage(ProviderMessage.Role.USER, List.<ProviderContent>of(
                new TextContent("What is this?"),
                new ImageContent("image/png", "aW1hZ2U="),
                new DocumentContent("application/pdf", "cGRm", "report.pdf")));
        drain(provider.stream(ask(List.of(message), List.of(), new CancelSignal())));

        JsonNode send = runtime.requests("session.send").getFirst();
        assertEquals("What is this?", send.path("prompt").asText());
        JsonNode attachments = send.path("attachments");
        assertEquals(2, attachments.size(), send.toString());
        assertEquals("blob", attachments.get(0).path("type").asText());
        assertEquals("aW1hZ2U=", attachments.get(0).path("data").asText());
        assertEquals("image/png", attachments.get(0).path("mimeType").asText());
        assertEquals("cGRm", attachments.get(1).path("data").asText());
        assertEquals("application/pdf", attachments.get(1).path("mimeType").asText());
        assertEquals("report.pdf", attachments.get(1).path("displayName").asText());
    }

    @Test
    void anImageBesideAToolResultRidesOnItAndTextBesideItIsAppended() throws Exception {
        start("claude-sonnet-5");
        List<JsonNode> delivered = new CopyOnWriteArrayList<>();
        runtime.onSend(turn -> {
            turn.usage(538, 50, 0, 0, "tool_calls");
            turn.message("", List.of(Map.of("toolCallId", "toolu_3", "name", "read_file",
                    "arguments", Map.of("path", "shot.png"), "type", "function")));
            turn.askPermission(Map.of("kind", "custom-tool", "toolCallId", "toolu_3", "toolName", "read_file"));
            String requestId = turn.requestTool("toolu_3", "read_file", Map.of("path", "shot.png"));
            delivered.add(turn.awaitToolResult(requestId, Duration.ofSeconds(20)));
            turn.delta("Seen.");
            turn.usage(700, 2, 538, 0, "stop");
            turn.idle();
        });
        List<ProviderMessage> history = new ArrayList<>(List.of(user("Look at shot.png")));
        drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));
        history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.<ProviderContent>of(
                new ToolCallContent("toolu_3", "read_file", JSON.valueToTree(Map.of("path", "shot.png"))))));
        history.add(new ProviderMessage(ProviderMessage.Role.USER, List.<ProviderContent>of(
                new ToolResultContent("toolu_3", "an image of 10 by 10 pixels", false),
                new ImageContent("image/png", "cGl4ZWxz"),
                new DocumentContent("application/pdf", "cGRm", "notes.pdf"),
                new TextContent("Operator: hurry up."))));
        drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));

        JsonNode result = delivered.getFirst().path("result");
        String text = result.path("textResultForLlm").asText();
        assertTrue(text.startsWith("an image of 10 by 10 pixels\n\n"), text);
        assertTrue(text.contains("Operator: hurry up."), text);
        assertTrue(text.contains("notes.pdf"), text);
        JsonNode binaries = result.path("binaryResultsForLlm");
        assertEquals(1, binaries.size(), result.toString());
        assertEquals("cGl4ZWxz", binaries.get(0).path("data").asText());
        assertEquals("image/png", binaries.get(0).path("mimeType").asText());
        assertEquals("image", binaries.get(0).path("type").asText());
    }

    @Test
    void twoToolCallsInOneTurnYieldTwoCallsOneStopAndBothResultsGoBackByCallId() throws Exception {
        start("claude-sonnet-5");
        Map<String, JsonNode> delivered = new java.util.concurrent.ConcurrentHashMap<>();
        runtime.onSend(turn -> {
            turn.usage(538, 80, 0, 0, "tool_calls");
            turn.message("", List.of(
                    Map.of("toolCallId", "toolu_a", "name", "read_file", "arguments", Map.of("path", "a.txt"),
                            "type", "function"),
                    Map.of("toolCallId", "toolu_b", "name", "read_file", "arguments", Map.of("path", "b.txt"),
                            "type", "function")));
            turn.askPermission(Map.of("kind", "custom-tool", "toolCallId", "toolu_a", "toolName", "read_file"));
            turn.askPermission(Map.of("kind", "custom-tool", "toolCallId", "toolu_b", "toolName", "read_file"));
            String a = turn.requestTool("toolu_a", "read_file", Map.of("path", "a.txt"));
            String b = turn.requestTool("toolu_b", "read_file", Map.of("path", "b.txt"));
            delivered.put("toolu_a", turn.awaitToolResult(a, Duration.ofSeconds(20)));
            delivered.put("toolu_b", turn.awaitToolResult(b, Duration.ofSeconds(20)));
            turn.delta("Both read.");
            turn.usage(700, 3, 538, 0, "stop");
            turn.idle();
        });
        List<ProviderMessage> history = new ArrayList<>(List.of(user("Read a.txt and b.txt")));
        List<ProviderEvent> first = drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));

        assertEquals(List.of(
                new PUsage(538, 80, 0, 0),
                new PToolCall("toolu_a", "read_file", JSON.valueToTree(Map.of("path", "a.txt"))),
                new PToolCall("toolu_b", "read_file", JSON.valueToTree(Map.of("path", "b.txt"))),
                new PStop(PStop.StopReason.TOOL_USE)), first);

        history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.<ProviderContent>of(
                new ToolCallContent("toolu_a", "read_file", JSON.valueToTree(Map.of("path", "a.txt"))),
                new ToolCallContent("toolu_b", "read_file", JSON.valueToTree(Map.of("path", "b.txt"))))));
        // Results in the other order: each goes back to its own call.
        history.add(new ProviderMessage(ProviderMessage.Role.USER, List.<ProviderContent>of(
                new ToolResultContent("toolu_b", "bee", false),
                new ToolResultContent("toolu_a", "ay", false))));
        List<ProviderEvent> second = drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));

        assertEquals(new PStop(PStop.StopReason.END_TURN), second.getLast());
        assertEquals("ay", delivered.get("toolu_a").path("result").path("textResultForLlm").asText());
        assertEquals("bee", delivered.get("toolu_b").path("result").path("textResultForLlm").asText());
    }

    // ---- final round, 2026-10-10: the reasoning contract and the reviewer's open pins ----

    @Test
    void theCompletionBudgetNeverReachesTheRuntime() throws Exception {
        // ProviderRequest#maxTokens has no counterpart in the SDK: it is dropped, and nothing claims otherwise.
        start("claude-sonnet-5");
        runtime.onSend(says("ok"));
        drain(provider.stream(new ProviderRequest("s", List.of(user("hi")), List.of(), 7777, Reasoning.DEFAULT,
                null, new CancelSignal())));
        String everything = runtime.requests().toString();
        assertTrue(runtime.requests("session.send").size() == 1, everything);
        assertFalse(everything.contains("7777"), everything);
        assertFalse(everything.toLowerCase(java.util.Locale.ROOT).contains("maxtokens")
                || everything.contains("max_tokens") || everything.contains("maxOutputTokens"), everything);
    }

    @Test
    void reasoningOnWithoutAnEffortSendsNoLevelBecauseThereIsNoOnSwitch() throws Exception {
        start("claude-sonnet-5"); // lists low, medium and high
        runtime.onSend(says("ok"));
        drain(provider.stream(ask("s", List.of(user("hi")), List.of(), Reasoning.ON, null, new CancelSignal())));
        assertTrue(createParams(0).path("reasoningEffort").isMissingNode()
                || createParams(0).path("reasoningEffort").isNull(), createParams(0).toString());
        assertEquals(1, runtime.requests("session.create").size());
    }

    @Test
    void reasoningOnWithAListedEffortSendsThatEffortAndNothingMore() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(says("ok"));
        drain(provider.stream(ask("s", List.of(user("hi")), List.of(), Reasoning.ON, "medium", new CancelSignal())));
        assertEquals("medium", createParams(0).path("reasoningEffort").asText(), createParams(0).toString());
    }

    @Test
    void aLaterRequestThatResolvesToNoLevelKeepsTheLevelTheSessionRunsAt() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(says("Blue."));
        runtime.onSend(says("Green."));
        List<ProviderMessage> history = new ArrayList<>(List.of(user("Pick a colour.")));
        drain(provider.stream(ask("s", history, List.of(), Reasoning.DEFAULT, "high", new CancelSignal())));
        history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent("Blue."))));
        history.add(user("Another one."));
        drain(provider.stream(ask("s", history, List.of(), Reasoning.DEFAULT, "max", new CancelSignal())));

        assertEquals("high", createParams(0).path("reasoningEffort").asText());
        assertEquals(1, runtime.requests("session.create").size());
        assertEquals(List.of(), runtime.requests("session.model.switchTo"), runtime.requests().toString());
        assertEquals(2, runtime.requests("session.send").size());
    }

    @Test
    void theRuntimeStartsWithNoTokenInAnyEnvironmentVariableOrClientOption() {
        Map<String, String> env = new HashMap<>(Map.of("PATH", "/usr/bin", "HOME", "/home/someone"));
        CopilotProvider.TOKEN_VARIABLES.forEach(name -> env.put(name, "fixtureTokenNotReal-" + name));
        CopilotProvider.TokenSource source = (host, reason) -> new CopilotProvider.Token("fixtureTokenNotReal", 60);

        var withSource = CopilotProvider.clientOptions(
                new CopilotProvider.Options("claude-sonnet-5", "/opt/homebrew/bin/copilot", source, false), env);
        var storedLogin = CopilotProvider.clientOptions(
                new CopilotProvider.Options("claude-sonnet-5", "/opt/homebrew/bin/copilot", null, true), env);
        var neither = CopilotProvider.clientOptions(
                new CopilotProvider.Options("claude-sonnet-5", "/opt/homebrew/bin/copilot", null, false), env);

        for (var options : List.of(withSource, storedLogin, neither)) {
            assertEquals(Map.of("PATH", "/usr/bin", "HOME", "/home/someone"), options.getEnvironment());
            assertNull(options.getGitHubToken(), "a token is never a client option");
            assertEquals("/opt/homebrew/bin/copilot", options.getCliPath());
            assertFalse(String.valueOf(options.getCliArgs() == null ? "" : String.join(" ", options.getCliArgs()))
                    .contains("fixtureTokenNotReal"));
        }
        assertEquals(java.util.Optional.of(false), withSource.getUseLoggedInUser(),
                "a token source means the stored login is never read");
        assertEquals(java.util.Optional.of(true), storedLogin.getUseLoggedInUser(),
                "the stored login only when the user chose it");
        assertEquals(java.util.Optional.of(false), neither.getUseLoggedInUser());
    }

    @Test
    void theRealHarnessToolsKeepTheirNamesAndOverrideTheBuiltInsWithoutSkippingThePermissionCheck()
            throws Exception {
        List<ToolSpec> belt = dev.spectroscope.core.tools.StandardTools.all(60).stream()
                .map(tool -> new ToolSpec(tool.name(), tool.description(), tool.inputSchema()))
                .toList();
        List<String> names = belt.stream().map(ToolSpec::name).toList();
        assertTrue(names.contains("glob") && names.contains("grep"), names.toString());
        start("claude-sonnet-5");
        Map<String, String> answers = new HashMap<>();
        runtime.onSend(turn -> {
            answers.put("glob", turn.askPermission(Map.of("kind", "custom-tool", "toolCallId", "c1",
                    "toolName", "glob")));
            answers.put("shell", turn.askPermission(Map.of("kind", "shell", "toolCallId", "c2",
                    "fullCommandText", "ls")));
            turn.delta("ok");
            turn.usage(10, 1, 0, 0, "stop");
            turn.idle();
        });

        drain(provider.stream(ask(List.of(user("hi")), belt, new CancelSignal())));

        JsonNode tools = runtime.createParams().path("tools");
        List<String> registered = new ArrayList<>();
        tools.forEach(t -> registered.add(t.path("name").asText()));
        assertEquals(names, registered, "every harness tool, under its own name, in the belt's order");
        tools.forEach(t -> {
            assertTrue(t.path("overridesBuiltInTool").asBoolean(false), t.toString());
            assertFalse(t.path("skipPermission").asBoolean(false), "the permission request still comes: " + t);
        });
        assertEquals("approve-once", answers.get("glob"), answers.toString());
        assertEquals("reject", answers.get("shell"), answers.toString());
    }

    @Test
    void theHostTheRuntimeReportsForTheAccountIsKeptForTheFaces() throws Exception {
        start("claude-sonnet-5");
        runtime.authStatus(Map.of("isAuthenticated", true, "authType", "user", "login", "octo-fixture",
                "host", "https://octocorp.ghe.com"));
        provider.authStatus();
        assertEquals("https://octocorp.ghe.com", CopilotProvider.lastAuthHost());
        java.nio.file.Path dir = java.nio.file.Files.createTempDirectory("copilot-host");
        assertEquals("octocorp.ghe.com", dev.spectroscope.core.config.SpectroConfig.load(
                new dev.spectroscope.core.config.SpectroConfig.Overrides("copilot", "auto", null, null, null, null),
                dir).providerHost(), "the config names the host the runtime reported");
        runtime.authStatus(Map.of("isAuthenticated", true, "authType", "user", "login", "octo-fixture",
                "host", "https://github.com"));
        provider.authStatus();
        assertEquals("https://github.com", CopilotProvider.lastAuthHost());
    }

    /** Collects what the provider puts on the wire record. */
    private static final class RecordingTap implements LlmWireTap {
        final List<WireRequest> requests = new CopyOnWriteArrayList<>();
        final List<String> lines = new CopyOnWriteArrayList<>();
        final List<WireOutcome> outcomes = new CopyOnWriteArrayList<>();

        @Override
        public Exchange begin(WireRequest request) {
            requests.add(request);
            return new Exchange() {
                @Override
                public void line(String rawLine) {
                    lines.add(rawLine);
                }

                @Override
                public void end(WireOutcome outcome) {
                    outcomes.add(outcome);
                }
            };
        }

        String everything() {
            return requests + " " + lines + " " + outcomes;
        }
    }
}
