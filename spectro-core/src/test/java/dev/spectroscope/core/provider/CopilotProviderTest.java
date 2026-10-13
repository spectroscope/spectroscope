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
        awaitCount(delivered::size, 1);
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

        awaitCount(delivered::size, 1);
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

    /** How long a stopped turn may take to end (card 557's budget, card 583). */
    private static final long STOP_BUDGET_MS = 1_000;

    /** Reads a stream, presses stop at its first text delta, and returns the milliseconds from the stop to its end. */
    private static long stopAtTheFirstDelta(Iterable<ProviderEvent> stream, CancelSignal signal,
                                            List<ProviderEvent> events, String what) {
        long pressed = 0;
        for (ProviderEvent event : stream) {
            events.add(event);
            if (event instanceof PTextDelta && !signal.isCancelled()) {
                pressed = System.nanoTime();
                signal.cancel();
            }
        }
        long millis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - pressed);
        System.out.println("card 583 measured: stop with " + what + ": " + millis + " ms to the end of the stream");
        return millis;
    }

    /**
     * Card 583: the runtime answers the abort but goes idle only 1.5 s later.
     * The stopped turn ends at once; the wait for the idle goes on in the
     * background, a tool call the stopped turn parked is answered as an
     * error once the runtime is idle, and then the session takes the next prompt.
     */
    @Test
    void aStopEndsTheTurnBeforeALateIdleAndTheSessionIsKeptOnceItSettles() throws Exception {
        start("claude-sonnet-5");
        List<JsonNode> delivered = new CopyOnWriteArrayList<>();
        runtime.onSend(turn -> {
            String requestId = turn.requestTool("toolu_1", "read_file", Map.of("path", "a.txt"));
            turn.delta("x");
            delivered.add(turn.awaitToolResult(requestId, Duration.ofSeconds(10)));
        });
        runtime.onSend(turn -> {
            turn.delta("fresh");
            turn.usage(20, 1, 0, 0, "stop");
            turn.idle();
        });
        runtime.abortTail(turn -> {
            FakeCopilotRuntime.sleep(1_500);
            turn.delta("late");
        });

        CancelSignal signal = new CancelSignal();
        List<ProviderEvent> events = new ArrayList<>();
        List<ProviderMessage> history = new ArrayList<>(List.of(user("Write an essay.")));
        long millis = stopAtTheFirstDelta(provider.stream(ask(history, List.of(readFileSpec()), signal)), signal,
                events, "an idle 1.5 s after the abort");

        assertTrue(millis < STOP_BUDGET_MS, "the stop took " + millis + " ms while the runtime went idle 1.5 s"
                + " after the abort; the budget is " + STOP_BUDGET_MS + " ms");
        assertEquals(new PStop(PStop.StopReason.ABORTED), events.getLast());
        assertEquals(1, stops(events));
        assertTrue(events.stream().noneMatch(PToolCall.class::isInstance), events.toString());

        awaitCount(delivered::size, 1);
        assertEquals("error", delivered.getFirst().path("result").path("resultType").asText(),
                "the parked call of the stopped turn is answered as an error: " + delivered);

        history.add(user("Something short instead."));
        List<ProviderEvent> next = drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));
        assertEquals(List.of(new PTextDelta("fresh"), new PUsage(20, 1, 0, 0),
                new PStop(PStop.StopReason.END_TURN)), next);
        assertEquals(1, runtime.requests("session.create").size(),
                "the session the abort settled in the background takes the next prompt");
        assertTrue(runtime.scriptFailures().isEmpty(), runtime.scriptFailures().toString());
    }

    /**
     * Card 583: the next prompt comes while the stopped turn still waits for
     * the runtime's late idle. It does not wait, it gets a runtime session of
     * its own, and nothing the stopped turn's runtime session still sends
     * reaches it: the next turn is still streaming when the late deltas come
     * (1.5 s after the abort), and none of them is in it.
     */
    @Test
    void aPromptDuringALateSettleGetsAFreshSessionAndNothingOfTheStoppedTurn() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            for (int i = 0; i < 400 && !turn.aborted(); i++) {
                turn.delta("x");
                FakeCopilotRuntime.sleep(25);
            }
        });
        runtime.onSend(turn -> {
            turn.delta("fresh");
            FakeCopilotRuntime.sleep(2_000);
            turn.usage(20, 1, 0, 0, "stop");
            turn.idle();
        });
        runtime.abortTail(turn -> {
            FakeCopilotRuntime.sleep(1_500);
            turn.delta("late");
            turn.delta("late");
        });

        CancelSignal signal = new CancelSignal();
        List<ProviderEvent> events = new ArrayList<>();
        List<ProviderMessage> history = new ArrayList<>(List.of(user("Write an essay.")));
        long millis = stopAtTheFirstDelta(provider.stream(ask(history, List.of(), signal)), signal, events,
                "an idle 1.5 s after the abort");

        assertTrue(millis < STOP_BUDGET_MS, "the stop took " + millis + " ms while the runtime went idle 1.5 s"
                + " after the abort; the budget is " + STOP_BUDGET_MS + " ms");
        assertEquals(new PStop(PStop.StopReason.ABORTED), events.getLast());

        history.add(user("Something short instead."));
        List<ProviderEvent> next = drain(provider.stream(ask(history, List.of(), new CancelSignal())));
        assertEquals(List.of(new PTextDelta("fresh"), new PUsage(20, 1, 0, 0),
                new PStop(PStop.StopReason.END_TURN)), next);
        assertEquals(2, runtime.requests("session.create").size(),
                "the next prompt went to the runtime session that was still settling");
    }

    /**
     * Card 583: the stream no longer waits on the ping, so it must not send a
     * new one every half second while the runtime has not answered the last.
     * Each unanswered ping stays pending in the SDK until the runtime answers.
     */
    @Test
    void aRuntimeThatDoesNotAnswerThePingIsAskedOnceNotEveryHalfSecond() throws Exception {
        start("claude-sonnet-5");
        runtime.hold("ping");
        runtime.onSend(turn -> {
            turn.delta("thinking");
            FakeCopilotRuntime.sleep(1_800);
            turn.delta(" done");
            turn.usage(20, 2, 0, 0, "stop");
            turn.idle();
        });

        List<ProviderEvent> events = drain(provider.stream(ask(List.of(user("Think.")), List.of(),
                new CancelSignal())));

        assertEquals(new PStop(PStop.StopReason.END_TURN), events.getLast());
        assertEquals(1, runtime.requests("ping").size(),
                "pings sent during 1.8 s of silence while the first one had no answer");
    }

    /**
     * A ping that gets no answer within its timeout is a busy runtime, not a
     * dead one: the turn goes on and ends as the runtime says (card 583 moved
     * the wait off the stream, this pins what the timeout still means).
     */
    @Test
    void aPingThatTimesOutIsABusyRuntimeNotADeadOne() throws Exception {
        start("claude-sonnet-5");
        runtime.hold("ping");
        runtime.onSend(turn -> {
            turn.delta("thinking");
            FakeCopilotRuntime.sleep(3_000);
            turn.delta(" done");
            turn.usage(20, 2, 0, 0, "stop");
            turn.idle();
        });

        List<ProviderEvent> events = drain(provider.stream(ask(List.of(user("Think hard.")), List.of(),
                new CancelSignal())));

        assertEquals(List.of(new PTextDelta("thinking"), new PTextDelta(" done"), new PUsage(20, 2, 0, 0),
                new PStop(PStop.StopReason.END_TURN)), events);
    }

    /**
     * Card 583: the runtime dies right after it answered the abort, while a
     * ping is still waiting. The stop ends the turn as aborted, not as an
     * error, and the dead runtime is let go, so the next prompt starts a new
     * one instead of failing on the old. The same death with no ping in
     * flight is the next test but one. Because the ping already found the
     * runtime gone, the stop does not wait out its 200 ms grace, and the
     * runtime is dropped at once: a call that is not a prompt (the sign-in
     * sheet's) reaches a new runtime too.
     */
    @Test
    void aRuntimeThatDiesWhileAPingIsPendingDuringTheStopIsStartedAgain() throws Exception {
        start("claude-sonnet-5");
        runtime.hold("ping");
        runtime.onSend(turn -> turn.delta("partial"));
        runtime.onSend(says("back"));
        runtime.abortTail(FakeCopilotRuntime.Turn::die);

        CancelSignal signal = new CancelSignal();
        List<ProviderEvent> events = new CopyOnWriteArrayList<>();
        List<Throwable> failures = new CopyOnWriteArrayList<>();
        long[] endedAt = new long[1];
        Thread reader = Thread.ofVirtual().start(() -> {
            try {
                provider.stream(ask(List.of(user("hi")), List.of(), signal)).forEach(events::add);
            } catch (Throwable failure) {
                failures.add(failure);
            } finally {
                endedAt[0] = System.nanoTime();
            }
        });
        runtime.await("ping", Duration.ofSeconds(10));
        long pressed = System.nanoTime();
        signal.cancel();
        boolean ended = reader.join(Duration.ofSeconds(4));
        long millis = ended ? TimeUnit.NANOSECONDS.toMillis(endedAt[0] - pressed) : -1;
        System.out.println("card 583 measured: stop with a runtime that dies while a ping is pending: " + millis
                + " ms to the end of the stream");
        assertTrue(ended && millis < STOP_BUDGET_MS, "the stopped turn took " + (ended ? millis : "more than 4000")
                + " ms to end; the budget is " + STOP_BUDGET_MS + " ms");
        assertTrue(millis < 150, "the stop took " + millis + " ms although a ping had found the runtime gone;"
                + " it waited out the grace");

        assertEquals(List.of(), failures, "a stop is not an error");
        assertEquals(new PStop(PStop.StopReason.ABORTED), events.getLast());
        assertFalse(provider.authStatus().authenticated(), "the fake runtime's sign-in answer");
        assertEquals(2, runtime.requests("connect").size(), "the dead runtime was not dropped at the stop");
        List<ProviderEvent> next = drain(provider.stream(ask(List.of(user("hi again")), List.of(),
                new CancelSignal())));
        assertEquals(List.of(new PTextDelta("back"), new PUsage(10, 1, 0, 0),
                new PStop(PStop.StopReason.END_TURN)), next);
        assertEquals(2, runtime.requests("connect").size(), "a second runtime connection");
    }

    /**
     * A stop that comes after the provider closed the turn's runtime session
     * (the session's provider was replaced mid-run) ends the turn as aborted:
     * the SDK refuses {@code abort} on a closed session, and that is not an
     * error the operator should see.
     */
    @Test
    void aStopAfterTheProviderClosedTheSessionEndsAsAbortedNotAsAnError() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            for (int i = 0; i < 400 && !turn.aborted(); i++) {
                turn.delta("x");
                FakeCopilotRuntime.sleep(25);
            }
        });

        CancelSignal signal = new CancelSignal();
        List<ProviderEvent> events = new ArrayList<>();
        for (ProviderEvent event : provider.stream(ask(List.of(user("Write an essay.")), List.of(), signal))) {
            events.add(event);
            if (event instanceof PTextDelta && !signal.isCancelled()) {
                provider.close();
                signal.cancel();
            }
        }

        assertEquals(new PStop(PStop.StopReason.ABORTED), events.getLast());
        assertEquals(1, stops(events));
    }

    /** A turn that streams until the runtime hears the abort. */
    private static Consumer<FakeCopilotRuntime.Turn> streamsUntilAborted() {
        return turn -> {
            for (int i = 0; i < 400 && !turn.aborted(); i++) {
                turn.delta("x");
                FakeCopilotRuntime.sleep(25);
            }
        };
    }

    /** A turn that parks one call of the harness's read_file, streams one delta and waits for the call's answer. */
    private static Consumer<FakeCopilotRuntime.Turn> parksACall(List<JsonNode> delivered) {
        return turn -> {
            String requestId = turn.requestTool("toolu_1", "read_file", Map.of("path", "a.txt"));
            turn.delta("x");
            delivered.add(turn.awaitToolResult(requestId, Duration.ofSeconds(10)));
        };
    }

    private static ProviderMessage assistant(String text) {
        return new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent(text)));
    }

    /** Waits up to five seconds until the fake runtime's connection has ended {@code count} times. */
    private void awaitDeaths(int count) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (runtime.clientsGone() < count && System.nanoTime() < deadline) {
            Thread.sleep(5);
        }
        assertEquals(count, runtime.clientsGone(), "runtime connections that ended");
    }

    /** Waits up to {@code seconds} until the runtime saw {@code session.detach} for {@code sessionId}. */
    private boolean detachedWithin(String sessionId, int seconds) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        while (runtime.requests("session.detach").stream()
                .noneMatch(detach -> sessionId.equals(detach.path("sessionId").asText()))
                && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        return runtime.requests("session.detach").stream()
                .anyMatch(detach -> sessionId.equals(detach.path("sessionId").asText()));
    }

    /**
     * Card 583 (review D1): the runtime dies right after it answered the abort,
     * while the turn was streaming, so no ping is in flight and nothing tells
     * the provider. The next prompt meets the dead client when it creates its
     * session; the provider drops that client and creates the session once
     * more on a new runtime. The stopped turn's settle runs out 5 s after the
     * abort, and a prompt after that still finds the new runtime.
     */
    @Test
    void aRuntimeThatDiesAtTheAbortWithNoPingInFlightIsReplacedForTheNextPrompt() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(streamsUntilAborted());
        runtime.onSend(says("back"));
        runtime.onSend(says("back later"));
        runtime.abortTail(FakeCopilotRuntime.Turn::die);

        CancelSignal signal = new CancelSignal();
        List<ProviderEvent> events = new ArrayList<>();
        long millis = stopAtTheFirstDelta(provider.stream(ask(List.of(user("Write an essay.")), List.of(), signal)),
                signal, events, "a runtime that dies at the abort, no ping in flight");
        assertTrue(millis < STOP_BUDGET_MS, "the stop took " + millis + " ms; the budget is " + STOP_BUDGET_MS + " ms");
        assertEquals(new PStop(PStop.StopReason.ABORTED), events.getLast());
        assertEquals(0, runtime.requests("ping").size(), "a ping went out, so this is not the case without one");
        awaitDeaths(1);

        List<ProviderEvent> next = drain(provider.stream(ask(List.of(user("hi again")), List.of(),
                new CancelSignal())));
        assertEquals(List.of(new PTextDelta("back"), new PUsage(10, 1, 0, 0),
                new PStop(PStop.StopReason.END_TURN)), next);
        assertEquals(2, runtime.requests("connect").size(), "the next prompt runs on a new runtime");

        Thread.sleep(6_000);
        List<ProviderEvent> later = drain(provider.stream(ask(List.of(user("hi later")), List.of(),
                new CancelSignal())));
        assertEquals(List.of(new PTextDelta("back later"), new PUsage(10, 1, 0, 0),
                new PStop(PStop.StopReason.END_TURN)), later);
        assertEquals(2, runtime.requests("connect").size(), "the prompt 6 s later started yet another runtime");
    }

    /**
     * Card 583 (review D1): one provider serves every chat of a model
     * ({@code CopilotAccount.shared}). The runtime dies between prompts. Each
     * chat's next prompt continues its own runtime session, finds it dead,
     * and is answered on one new runtime, in a fresh session that gets the
     * chat's history.
     */
    @Test
    void everyChatThatSharesTheProviderIsAnsweredOnTheNewRuntime() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(says("one"));
        runtime.onSend(turn -> {
            says("two").accept(turn);
            FakeCopilotRuntime.sleep(100);
            turn.die();
        });
        runtime.onSend(says("one again"));
        runtime.onSend(says("two again"));
        List<ProviderMessage> chatOne = new ArrayList<>(List.of(user("chat one")));
        List<ProviderMessage> chatTwo = new ArrayList<>(List.of(user("chat two")));
        drain(provider.stream(ask(chatOne, List.of(), new CancelSignal())));
        drain(provider.stream(ask(chatTwo, List.of(), new CancelSignal())));
        awaitDeaths(1);

        chatOne.addAll(List.of(assistant("one"), user("more")));
        chatTwo.addAll(List.of(assistant("two"), user("more")));
        List<ProviderEvent> one = drain(provider.stream(ask(chatOne, List.of(), new CancelSignal())));
        List<ProviderEvent> two = drain(provider.stream(ask(chatTwo, List.of(), new CancelSignal())));

        assertEquals(List.of(new PTextDelta("one again"), new PUsage(10, 1, 0, 0),
                new PStop(PStop.StopReason.END_TURN)), one);
        assertEquals(List.of(new PTextDelta("two again"), new PUsage(10, 1, 0, 0),
                new PStop(PStop.StopReason.END_TURN)), two);
        assertEquals(2, runtime.requests("connect").size(), "both chats run on one new runtime");
        List<JsonNode> sends = runtime.requests("session.send");
        assertTrue(sends.get(sends.size() - 2).path("prompt").asText().contains("chat one"),
                "the fresh session of chat one did not get its history: " + sends.get(sends.size() - 2));
    }

    /**
     * Card 583 (review D1): a chat waits on a turn when the runtime dies, and
     * another chat's prompt replaces the dead runtime before the waiting chat
     * pings. The waiting chat asks its own runtime, not the provider's new
     * one, so its turn ends with an error instead of waiting forever.
     */
    @Test
    void aChatWaitingOnADeadRuntimeEndsEvenWhenAnotherChatAlreadyStartedANewOne() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            turn.delta("thinking");
            FakeCopilotRuntime.sleep(100);
            turn.die();
        });
        runtime.onSend(says("hello"));
        List<Throwable> failures = new CopyOnWriteArrayList<>();
        long[] endedAt = new long[1];
        Thread waiting = Thread.ofVirtual().start(() -> {
            try {
                drain(provider.stream(ask(List.of(user("Think.")), List.of(), new CancelSignal())));
            } catch (Throwable failure) {
                failures.add(failure);
            } finally {
                endedAt[0] = System.nanoTime();
            }
        });
        awaitDeaths(1);
        long died = System.nanoTime();

        List<ProviderEvent> other = drain(provider.stream(ask(List.of(user("Hello.")), List.of(),
                new CancelSignal())));
        assertEquals(List.of(new PTextDelta("hello"), new PUsage(10, 1, 0, 0),
                new PStop(PStop.StopReason.END_TURN)), other);
        assertEquals(2, runtime.requests("connect").size(), "the other chat runs on a new runtime");

        boolean ended = waiting.join(Duration.ofSeconds(3));
        long millis = ended ? TimeUnit.NANOSECONDS.toMillis(endedAt[0] - died) : -1;
        assertTrue(ended, "the waiting chat still waits more than 3000 ms after its runtime died");
        System.out.println("card 583 measured: a chat on a dead runtime ended " + millis + " ms after the death");
        assertEquals(1, failures.size(), "the waiting chat's turn ends with an error");
        assertTrue(failures.getFirst().getMessage().contains("copilot runtime"), failures.getFirst().getMessage());
    }

    /**
     * Card 583 (review D2): the runtime goes idle within the stop's grace (50 ms
     * after the abort), so the stop settles on the run's thread. The call the
     * stopped turn parked is answered as an error, and the session takes the
     * next prompt.
     */
    @Test
    void aStopThatSettlesWithinTheGraceAnswersTheParkedCallAndKeepsTheSession() throws Exception {
        start("claude-sonnet-5");
        List<JsonNode> delivered = new CopyOnWriteArrayList<>();
        runtime.onSend(parksACall(delivered));
        runtime.onSend(says("fresh"));
        runtime.abortTail(turn -> FakeCopilotRuntime.sleep(50));

        CancelSignal signal = new CancelSignal();
        List<ProviderEvent> events = new ArrayList<>();
        List<ProviderMessage> history = new ArrayList<>(List.of(user("Write an essay.")));
        long millis = stopAtTheFirstDelta(provider.stream(ask(history, List.of(readFileSpec()), signal)), signal,
                events, "an idle within the grace and one parked call");

        assertTrue(millis < STOP_BUDGET_MS, "the stop took " + millis + " ms; the budget is " + STOP_BUDGET_MS + " ms");
        assertEquals(new PStop(PStop.StopReason.ABORTED), events.getLast());
        awaitCount(delivered::size, 1);
        assertEquals("error", delivered.getFirst().path("result").path("resultType").asText(), delivered.toString());
        history.add(user("Something short instead."));
        List<ProviderEvent> next = drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));
        assertEquals(List.of(new PTextDelta("fresh"), new PUsage(10, 1, 0, 0),
                new PStop(PStop.StopReason.END_TURN)), next);
        assertEquals(1, runtime.requests("session.create").size(),
                "the session of a stop that settled within the grace was not reused");
    }

    /**
     * Card 583 (review D2): the runtime never answers the abort. Once the
     * settle runs out (5 s), the session closes, and the call the stopped
     * turn parked is answered as an error before it does.
     */
    @Test
    void aStopTheRuntimeNeverSettlesAnswersTheParkedCallWhenTheSessionCloses() throws Exception {
        start("claude-sonnet-5");
        runtime.hold("session.abort");
        List<JsonNode> delivered = new CopyOnWriteArrayList<>();
        runtime.onSend(parksACall(delivered));

        CancelSignal signal = new CancelSignal();
        List<ProviderEvent> events = new ArrayList<>();
        long millis = stopAtTheFirstDelta(provider.stream(ask(List.of(user("Write an essay.")),
                List.of(readFileSpec()), signal)), signal, events, "a runtime that ignores the abort and one parked call");
        String stopped = runtime.requests("session.send").getFirst().path("sessionId").asText();

        assertTrue(millis < STOP_BUDGET_MS, "the stop took " + millis + " ms; the budget is " + STOP_BUDGET_MS + " ms");
        assertEquals(new PStop(PStop.StopReason.ABORTED), events.getLast());
        awaitCount(delivered::size, 1);
        assertEquals("error", delivered.getFirst().path("result").path("resultType").asText(), delivered.toString());
        assertTrue(detachedWithin(stopped, 3), "the session whose abort never settled is still open");
    }

    /**
     * Card 583 (review D2): the run's thread is interrupted while the stop
     * waits out its grace. The wait ends without the idle, the session goes,
     * and the call the stopped turn parked is answered as an error.
     */
    @Test
    void aStopInterruptedDuringTheGraceAnswersTheParkedCallWhenTheSessionCloses() throws Exception {
        start("claude-sonnet-5");
        runtime.hold("session.abort");
        List<JsonNode> delivered = new CopyOnWriteArrayList<>();
        runtime.onSend(parksACall(delivered));

        CancelSignal signal = new CancelSignal();
        List<ProviderEvent> events = new CopyOnWriteArrayList<>();
        List<Throwable> failures = new CopyOnWriteArrayList<>();
        // A platform thread: an interrupt must not close the runtime's socket.
        Thread reader = new Thread(() -> {
            try {
                for (ProviderEvent event : provider.stream(ask(List.of(user("Write an essay.")),
                        List.of(readFileSpec()), signal))) {
                    events.add(event);
                    if (event instanceof PTextDelta && !signal.isCancelled()) {
                        Thread self = Thread.currentThread();
                        Thread.ofVirtual().start(() -> {
                            FakeCopilotRuntime.sleep(50);
                            self.interrupt();
                        });
                        signal.cancel();
                    }
                }
            } catch (Throwable failure) {
                failures.add(failure);
            }
        }, "copilot-test-reader");
        reader.start();

        assertTrue(reader.join(Duration.ofSeconds(1)), "the interrupted stop did not end within one second");
        assertEquals(List.of(), failures, "a stop is not an error");
        assertEquals(new PStop(PStop.StopReason.ABORTED), events.getLast());
        awaitCount(delivered::size, 1);
        assertEquals("error", delivered.getFirst().path("result").path("resultType").asText(), delivered.toString());
        assertTrue(detachedWithin(runtime.requests("session.send").getFirst().path("sessionId").asText(), 3),
                "the session of the interrupted stop is still open");
    }

    /** Waits up to five seconds until the runtime saw {@code count} requests of {@code method}. */
    private void awaitRequests(String method, int count) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (runtime.requests(method).size() < count && System.nanoTime() < deadline) {
            Thread.sleep(5);
        }
        assertEquals(count, runtime.requests(method).size(), "requests of " + method);
    }

    /** One chat's request, read on its own thread so the test can press stop in it. */
    private final class Chat {
        final CancelSignal signal = new CancelSignal();
        final List<ProviderEvent> events = new CopyOnWriteArrayList<>();
        final List<Throwable> failures = new CopyOnWriteArrayList<>();
        final Thread thread;
        volatile long endedAt;

        Chat(List<ProviderMessage> history) {
            thread = Thread.ofVirtual().start(() -> {
                try {
                    provider.stream(ask(history, List.of(readFileSpec()), signal)).forEach(events::add);
                } catch (Throwable failure) {
                    failures.add(failure);
                } finally {
                    endedAt = System.nanoTime();
                }
            });
        }

        /** Presses stop; returns the milliseconds from the stop to the end, or -1 when it did not end in time. */
        long stop(Duration giveUp) throws InterruptedException {
            long pressed = System.nanoTime();
            signal.cancel();
            return thread.join(giveUp) ? TimeUnit.NANOSECONDS.toMillis(endedAt - pressed) : -1;
        }
    }

    /**
     * Card 583 (second review F1; the owner's rule that a stop never waits):
     * chat C's runtime dies, chat A's next prompt starts the new runtime, and
     * that start gets no answer. A stop in chat C ends C within one second; it
     * does not wait for A's start, and neither does a stop in A.
     */
    @Test
    void aStopInOneChatDoesNotWaitWhileAnotherChatStartsTheNewRuntime() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            turn.delta("thinking");
            turn.die();
        });
        Chat c = new Chat(List.of(user("chat c")));
        awaitDeaths(1);
        runtime.hold("connect");
        Chat a = new Chat(List.of(user("chat a")));
        awaitRequests("connect", 2);

        long pressed = System.nanoTime();
        c.signal.cancel();
        c.thread.join(Duration.ofSeconds(3));
        long aMillis = a.stop(Duration.ofSeconds(5));
        boolean cEnded = c.thread.join(Duration.ofSeconds(5));
        long cMillis = cEnded ? TimeUnit.NANOSECONDS.toMillis(c.endedAt - pressed) : -1;
        System.out.println("card 583 measured: stop of a chat while another chat starts the runtime: " + cMillis
                + " ms to the end of the stream; the starting chat's own stop: " + aMillis + " ms");

        assertTrue(cEnded && cMillis < STOP_BUDGET_MS, "the stop of chat C took " + (cEnded ? cMillis : "more than 8000")
                + " ms while chat A started a new runtime; the budget is " + STOP_BUDGET_MS + " ms");
        assertEquals(List.of(), c.failures, "a stop is not an error");
        assertEquals(new PStop(PStop.StopReason.ABORTED), c.events.getLast());
        assertTrue(aMillis >= 0 && aMillis < STOP_BUDGET_MS, "the stop of chat A, whose runtime start gets no answer,"
                + " took " + (aMillis < 0 ? "more than 5000" : aMillis) + " ms");
        assertEquals(new PStop(PStop.StopReason.ABORTED), a.events.getLast());
    }

    /**
     * Card 583 (second review F1): chat A starts the runtime and the start
     * gets no answer; chat B's prompt waits for that start. A stop in chat B
     * ends B within one second instead of waiting for A's start.
     */
    @Test
    void aStopInAChatWaitingForAnotherChatsRuntimeStartEndsAtOnce() throws Exception {
        start("claude-sonnet-5");
        runtime.hold("connect");
        Chat a = new Chat(List.of(user("chat a")));
        awaitRequests("connect", 1);
        Chat b = new Chat(List.of(user("chat b")));
        Thread.sleep(200);

        long pressed = System.nanoTime();
        b.signal.cancel();
        b.thread.join(Duration.ofSeconds(3));
        long aMillis = a.stop(Duration.ofSeconds(5));
        boolean bEnded = b.thread.join(Duration.ofSeconds(5));
        long millis = bEnded ? TimeUnit.NANOSECONDS.toMillis(b.endedAt - pressed) : -1;
        System.out.println("card 583 measured: stop of a chat waiting for another chat's runtime start: "
                + millis + " ms to the end of the stream");

        assertTrue(bEnded && millis < STOP_BUDGET_MS, "the stop of chat B took "
                + (bEnded ? millis : "more than 8000") + " ms while it waited for chat A's runtime start;"
                + " the budget is " + STOP_BUDGET_MS + " ms");
        assertEquals(List.of(), b.failures, "a stop is not an error");
        assertEquals(List.of(new PStop(PStop.StopReason.ABORTED)), b.events);
        assertTrue(aMillis >= 0 && aMillis < STOP_BUDGET_MS, "the stop of chat A took " + aMillis + " ms");
        assertEquals(1, runtime.requests("connect").size(), "chat B started a runtime of its own");
    }

    /**
     * Card 583 (second review F2): a runtime that refuses {@code session.create}
     * with a JSON-RPC error is alive. The refusal reaches the caller once, no
     * new runtime starts, and another chat's session takes its next prompt.
     */
    @Test
    void aRuntimeThatRefusesTheSessionCreateIsKeptAndTheRefusalReachesTheCaller() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(says("one"));
        List<ProviderMessage> chatOne = new ArrayList<>(List.of(user("chat one")));
        drain(provider.stream(ask(chatOne, List.of(), new CancelSignal())));
        runtime.refuseNext("session.create", "the model is not available");

        RuntimeException refused = assertThrows(RuntimeException.class,
                () -> drain(provider.stream(ask(List.of(user("chat two")), List.of(), new CancelSignal()))));

        assertTrue(refused.getMessage().contains("the model is not available"), refused.getMessage());
        assertEquals(2, runtime.requests("session.create").size(), "the refused session create was asked again");
        assertEquals(1, runtime.requests("connect").size(), "a refusal started a new runtime");
        runtime.onSend(says("one again"));
        chatOne.addAll(List.of(assistant("one"), user("more")));
        assertEquals(List.of(new PTextDelta("one again"), new PUsage(10, 1, 0, 0),
                new PStop(PStop.StopReason.END_TURN)), drain(provider.stream(ask(chatOne, List.of(),
                new CancelSignal()))));
        assertEquals(2, runtime.requests("session.create").size(), "the other chat lost its session to the refusal");
    }

    /**
     * Card 583 (second review F2): a runtime that refuses {@code session.send}
     * with a JSON-RPC error is alive. The refusal reaches the caller once, the
     * message is not sent again, no new runtime starts, and another chat's
     * session takes its next prompt.
     */
    @Test
    void aRuntimeThatRefusesTheSendIsKeptAndTheRefusalReachesTheCaller() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(says("one"));
        runtime.onSend(says("two"));
        List<ProviderMessage> chatOne = new ArrayList<>(List.of(user("chat one")));
        List<ProviderMessage> chatTwo = new ArrayList<>(List.of(user("chat two")));
        drain(provider.stream(ask(chatOne, List.of(), new CancelSignal())));
        drain(provider.stream(ask(chatTwo, List.of(), new CancelSignal())));
        runtime.refuseNext("session.send", "you are rate limited");
        chatOne.addAll(List.of(assistant("one"), user("more")));

        RuntimeException refused = assertThrows(RuntimeException.class,
                () -> drain(provider.stream(ask(chatOne, List.of(), new CancelSignal()))));

        assertTrue(refused.getMessage().contains("you are rate limited"), refused.getMessage());
        assertEquals(3, runtime.requests("session.send").size(), "the refused message was sent again");
        assertEquals(1, runtime.requests("connect").size(), "a refusal started a new runtime");
        runtime.onSend(says("two again"));
        chatTwo.addAll(List.of(assistant("two"), user("more")));
        assertEquals(List.of(new PTextDelta("two again"), new PUsage(10, 1, 0, 0),
                new PStop(PStop.StopReason.END_TURN)), drain(provider.stream(ask(chatTwo, List.of(),
                new CancelSignal()))));
        assertEquals(2, runtime.requests("session.create").size(), "the other chat lost its session to the refusal");
    }

    /**
     * Card 583 (second review F3): a continued prompt finds its runtime dead,
     * and the send retry starts a new runtime that gets no answer. A stop
     * reaches that start and ends the turn as aborted within one second.
     */
    @Test
    void aStopReachesTheRuntimeStartOfTheSendRetry() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(turn -> {
            says("one").accept(turn);
            FakeCopilotRuntime.sleep(100);
            turn.die();
        });
        List<ProviderMessage> history = new ArrayList<>(List.of(user("chat one")));
        drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));
        history.addAll(List.of(assistant("one"), user("more")));
        awaitDeaths(1);
        runtime.hold("connect");
        Chat chat = new Chat(history);
        awaitRequests("connect", 2);

        long millis = chat.stop(Duration.ofSeconds(4));
        System.out.println("card 583 measured: stop while the send retry starts a new runtime: " + millis
                + " ms to the end of the stream");

        assertTrue(millis >= 0 && millis < STOP_BUDGET_MS, "the stop took " + (millis < 0 ? "more than 4000" : millis)
                + " ms while the send retry started a runtime that gets no answer; the budget is "
                + STOP_BUDGET_MS + " ms");
        assertEquals(List.of(), chat.failures, "a stop is not an error");
        assertEquals(new PStop(PStop.StopReason.ABORTED), chat.events.getLast());
    }

    /**
     * Card 583 (second review F4): the dead session streamed a delta and asked
     * for a tool while the send waited, then the runtime died. The send runs
     * again in a fresh session, and the retried turn streams only what that
     * session sends: no stale text, no call the live session never made.
     */
    @Test
    void whatTheDeadSessionSentBeforeTheSendFailedDoesNotReachTheRetriedTurn() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(says("one"));
        List<ProviderMessage> history = new ArrayList<>(List.of(user("chat one")));
        drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));
        history.addAll(List.of(assistant("one"), user("more")));
        runtime.hold("session.send");
        Chat chat = new Chat(history);
        awaitRequests("session.send", 2);
        String dying = runtime.requests("session.send").get(1).path("sessionId").asText();
        runtime.release("session.send");
        runtime.onSend(says("fresh"));

        FakeCopilotRuntime.Turn old = runtime.new Turn(dying);
        old.delta("stale ");
        old.requestTool("toolu_stale", "read_file", Map.of("path", "stale.txt"));
        Thread.sleep(300);
        old.die();

        assertTrue(chat.thread.join(Duration.ofSeconds(10)), "the retried turn did not end");
        assertEquals(List.of(), chat.failures);
        assertEquals(List.of(new PTextDelta("fresh"), new PUsage(10, 1, 0, 0),
                new PStop(PStop.StopReason.END_TURN)), chat.events);
    }

    /**
     * Card 583 (second review F5): the provider is closed while a continued
     * send waits (the credential choice changed). The send fails with the
     * closed connection, and the turn ends with that error instead of starting
     * a runtime on the closed provider.
     */
    @Test
    void aProviderClosedDuringAContinuedSendStartsNoNewRuntime() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(says("one"));
        List<ProviderMessage> history = new ArrayList<>(List.of(user("chat one")));
        drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));
        history.addAll(List.of(assistant("one"), user("more")));
        runtime.hold("session.send");
        Chat chat = new Chat(history);
        awaitRequests("session.send", 2);
        runtime.release("session.send");
        runtime.onSend(says("after close"));

        provider.close();

        assertTrue(chat.thread.join(Duration.ofSeconds(5)), "the turn in flight did not end after close()");
        assertEquals(1, runtime.requests("connect").size(),
                "the closed provider started a new runtime for the turn in flight: " + chat.events);
        assertEquals(1, chat.failures.size(), "the turn in flight ends with an error: " + chat.events);
    }

    /**
     * Card 583 (second review F5): the provider is closed while a new chat's
     * session create waits. The create fails with the closed connection, and
     * the prompt ends with that error instead of starting a runtime on the
     * closed provider.
     */
    @Test
    void aProviderClosedDuringASessionCreateStartsNoNewRuntime() throws Exception {
        start("claude-sonnet-5");
        runtime.onSend(says("one"));
        drain(provider.stream(ask(List.of(user("chat one")), List.of(), new CancelSignal())));
        runtime.hold("session.create");
        Chat chat = new Chat(List.of(user("chat two")));
        awaitRequests("session.create", 2);
        runtime.release("session.create");
        runtime.onSend(says("after close"));

        provider.close();

        assertTrue(chat.thread.join(Duration.ofSeconds(5)), "the prompt in flight did not end after close()");
        assertEquals(1, runtime.requests("connect").size(),
                "the closed provider started a new runtime for the prompt in flight: " + chat.events);
        assertEquals(1, chat.failures.size(), "the prompt in flight ends with an error: " + chat.events);
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
        awaitCount(delivered::size, 1);
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

        awaitCount(delivered::size, 1);
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
        awaitCount(delivered::size, 2);
        assertEquals("ay", delivered.get("toolu_a").path("result").path("textResultForLlm").asText());
        assertEquals("bee", delivered.get("toolu_b").path("result").path("textResultForLlm").asText());
    }

    @Test
    void twoToolCallsThatArriveInTheOtherOrderStreamInTheOrderOfTheAssistantMessage() throws Exception {
        // The SDK runs each tool handler on a thread of its own, so the call the
        // model gave second can reach the provider first (the 0.15.2 and 0.15.3
        // tag runs). This runtime asks for toolu_b first and asks for toolu_a only
        // once the reader has seen a call, or after one second.
        start("claude-sonnet-5");
        Map<String, JsonNode> delivered = new java.util.concurrent.ConcurrentHashMap<>();
        java.util.concurrent.CountDownLatch sawACall = new java.util.concurrent.CountDownLatch(1);
        runtime.onSend(turn -> {
            turn.usage(538, 80, 0, 0, "tool_calls");
            turn.message("", List.of(
                    Map.of("toolCallId", "toolu_a", "name", "read_file", "arguments", Map.of("path", "a.txt"),
                            "type", "function"),
                    Map.of("toolCallId", "toolu_b", "name", "read_file", "arguments", Map.of("path", "b.txt"),
                            "type", "function")));
            turn.askPermission(Map.of("kind", "custom-tool", "toolCallId", "toolu_b", "toolName", "read_file"));
            turn.askPermission(Map.of("kind", "custom-tool", "toolCallId", "toolu_a", "toolName", "read_file"));
            String b = turn.requestTool("toolu_b", "read_file", Map.of("path", "b.txt"));
            try {
                sawACall.await(1, TimeUnit.SECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            String a = turn.requestTool("toolu_a", "read_file", Map.of("path", "a.txt"));
            delivered.put("toolu_a", turn.awaitToolResult(a, Duration.ofSeconds(20)));
            delivered.put("toolu_b", turn.awaitToolResult(b, Duration.ofSeconds(20)));
            turn.delta("Both read.");
            turn.usage(700, 3, 538, 0, "stop");
            turn.idle();
        });
        // Answers only if the second request opens a fresh session, so that case
        // fails on the session count below instead of waiting for the timeout.
        runtime.onSend(says("A fresh session."));
        List<ProviderMessage> history = new ArrayList<>(List.of(user("Read a.txt and b.txt")));
        List<ProviderEvent> first = new ArrayList<>();
        for (ProviderEvent event : provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal()))) {
            first.add(event);
            if (event instanceof PToolCall) {
                sawACall.countDown();
            }
        }

        assertEquals(List.of(
                new PUsage(538, 80, 0, 0),
                new PToolCall("toolu_a", "read_file", JSON.valueToTree(Map.of("path", "a.txt"))),
                new PToolCall("toolu_b", "read_file", JSON.valueToTree(Map.of("path", "b.txt"))),
                new PStop(PStop.StopReason.TOOL_USE)), first);

        // The history the harness builds from that stream is the one the runtime
        // session has seen: the results go to the parked calls of the same session.
        history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.<ProviderContent>of(
                new ToolCallContent("toolu_a", "read_file", JSON.valueToTree(Map.of("path", "a.txt"))),
                new ToolCallContent("toolu_b", "read_file", JSON.valueToTree(Map.of("path", "b.txt"))))));
        history.add(new ProviderMessage(ProviderMessage.Role.USER, List.<ProviderContent>of(
                new ToolResultContent("toolu_a", "ay", false),
                new ToolResultContent("toolu_b", "bee", false))));
        List<ProviderEvent> second = drain(provider.stream(ask(history, List.of(readFileSpec()), new CancelSignal())));

        assertEquals(1, runtime.requests("session.create").size(), "one runtime session for both turns");
        assertEquals(1, runtime.requests("session.send").size(), "the results are no new message");
        assertEquals(new PStop(PStop.StopReason.END_TURN), second.getLast());
        awaitCount(delivered::size, 2);
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
        // fixture-switch-model lists none, low and high and names low as its
        // default: ON must not be read as "send the default".
        start("fixture-switch-model");
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

    /**
     * The fake runtime records a delivered tool result on its own thread,
     * after the provider's stream may already have ended; on a slow runner
     * the list was still empty when the assertions read it (0.15.2 gate).
     * Waits up to ten seconds for {@code n} entries, then fails.
     */
    private static void awaitCount(java.util.function.IntSupplier size, int n) throws InterruptedException {
        long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
        while (size.getAsInt() < n && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        assertEquals(n, size.getAsInt(), "tool results the fake runtime recorded");
    }
}
