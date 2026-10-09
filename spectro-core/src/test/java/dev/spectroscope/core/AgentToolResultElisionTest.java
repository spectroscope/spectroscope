package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.PToolCall;
import dev.spectroscope.core.provider.LlmProvider.PUsage;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 467 in the loop: the scenario of the card, turn by turn.
 *
 * <pre>
 * Given read_file returned 56 kB of CLAUDE.md in turn 1
 * And the run is in turn 12
 * When the next request is built
 * Then the turn 1 result is a one-line stub in the request
 * And the transcript still holds the 56 kB
 * </pre>
 *
 * <p>The scripted provider records every request it is handed; the request is
 * the assertion. The llm wire half of the scenario is read off a real posted
 * body in {@code ToolResultElisionWireTest}.</p>
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class AgentToolResultElisionTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** 56,000 chars, every line recognisable, the size of the owner's CLAUDE.md. */
    private static final String CLAUDE_MD = "LINE-OF-CLAUDE-MD\n".repeat(56_000 / 18 + 1)
            .substring(0, 56_000);

    private static final String SUMMARY_SYSTEM_PREFIX = "You are a precise note-taker";

    /** Records turn requests and summarizer requests apart; turns come off a script. */
    private static final class Scripted implements LlmProvider {
        final List<ProviderRequest> requests = new ArrayList<>();
        final List<ProviderRequest> summaries = new ArrayList<>();
        final Queue<List<ProviderEvent>> script = new ArrayDeque<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (request.system().startsWith(SUMMARY_SYSTEM_PREFIX)) {
                summaries.add(request);
                return List.of(new PTextDelta("summary of the work so far"),
                        new PStop(PStop.StopReason.END_TURN));
            }
            requests.add(request);
            List<ProviderEvent> turn = script.poll();
            return turn != null ? turn
                    : List.of(new PTextDelta("done"), new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static Tool tool(String name, String output) {
        return new Tool() {
            public String name() { return name; }
            public String description() { return name; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return output; }
        };
    }

    /** A tool whose result is a person's answer: calling it again asks again. */
    private static Tool once(String name, String output) {
        Tool inner = tool(name, output);
        return new Tool() {
            public String name() { return inner.name(); }
            public String description() { return inner.description(); }
            public JsonNode inputSchema() { return inner.inputSchema(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return output; }
            @Override
            public boolean resultRepeatable() { return false; }
        };
    }

    /** Turn 1 reads CLAUDE.md, turns 2 to 11 call a small echo, turn 12 answers. */
    private static Scripted wholeFileReadThenTenSmallTurns(int bigUsageAtTurn) {
        Scripted provider = new Scripted();
        provider.script.add(List.of(
                new PToolCall("c1", "read_file", JSON.createObjectNode().put("path", "CLAUDE.md")),
                new PUsage(10, 2), new PStop(PStop.StopReason.TOOL_USE)));
        for (int turn = 2; turn <= 11; turn++) {
            provider.script.add(List.of(
                    new PToolCall("e" + turn, "echo", JSON.createObjectNode().put("value", turn)),
                    new PUsage(turn == bigUsageAtTurn ? 50_000 : 10, 2),
                    new PStop(PStop.StopReason.TOOL_USE)));
        }
        provider.script.add(List.of(new PTextDelta("done"), new PUsage(10, 2),
                new PStop(PStop.StopReason.END_TURN)));
        return provider;
    }

    private static AgentOptions.Builder options(LlmProvider provider, Tool... tools) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(tool("read_file", CLAUDE_MD));
        registry.register(tool("echo", "ok"));
        for (Tool extra : tools) {
            registry.register(extra);
        }
        return AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .maxTurns(20);
    }

    private static List<RunEvent> run(Agent agent) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("read CLAUDE.md and keep going",
                new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(events::add);
        }
        return events;
    }

    /** What one request sent for one call id. */
    private static String sent(ProviderRequest request, String callId) {
        for (ProviderMessage message : request.messages()) {
            for (ProviderContent content : message.content()) {
                if (content instanceof ToolResultContent result && result.callId().equals(callId)) {
                    return result.output();
                }
            }
        }
        throw new AssertionError("the request carries no result for " + callId);
    }

    @Test
    void aWholeFileReadTenTurnsAgoIsAOneLineStubInTheRequestOfTurnTwelve() {
        Scripted provider = wholeFileReadThenTenSmallTurns(-1);

        List<RunEvent> events = run(new Agent(options(provider).build()));

        assertEquals(12, provider.requests.size(), "premise: the run reached turn 12");
        String turnTwelve = sent(provider.requests.get(11), "c1");
        assertFalse(turnTwelve.contains("LINE-OF-CLAUDE-MD"),
                "turn 12 still carries the 56 kB read from turn 1");
        assertFalse(turnTwelve.contains("\n"), "the stub is one line: " + turnTwelve);
        assertTrue(turnTwelve.contains("read_file") && turnTwelve.contains("CLAUDE.md")
                && turnTwelve.contains("56,000"), "the stub names tool, path and size: " + turnTwelve);
        assertEquals(CLAUDE_MD, sent(provider.requests.get(1), "c1"),
                "turn 2 must still read the file it just asked for");

        RunEvent.ToolResult recorded = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance).map(RunEvent.ToolResult.class::cast)
                .filter(result -> "c1".equals(result.callId())).findFirst().orElseThrow();
        assertEquals(CLAUDE_MD, recorded.output(), "the event stream, which IS the transcript,"
                + " must carry the full result");
    }

    @Test
    void aStubbedResultReadsBackInFullFromTheTranscript() throws IOException {
        Scripted provider = wholeFileReadThenTenSmallTurns(-1);
        List<RunEvent> events = run(new Agent(options(provider).build()));
        assertFalse(sent(provider.requests.get(11), "c1").contains("LINE-OF-CLAUDE-MD"),
                "premise: the request of turn 12 was elided");

        SessionStore store = new SessionStore();
        events.forEach(store::append);
        List<ProviderMessage> resumed = SessionStore.loadSession(store.id());

        String readBack = resumed.stream().flatMap(message -> message.content().stream())
                .filter(ToolResultContent.class::isInstance).map(ToolResultContent.class::cast)
                .filter(result -> "c1".equals(result.callId())).map(ToolResultContent::output)
                .findFirst().orElseThrow();
        assertEquals(CLAUDE_MD, readBack, "the session file lost bytes of a result the request"
                + " only stubbed");
    }

    @Test
    void theAgentsOwnHistoryKeepsTheFullResultForTheNextRun() {
        Scripted provider = wholeFileReadThenTenSmallTurns(-1);
        Agent agent = new Agent(options(provider).build());
        run(agent);

        // A second run on the same agent: its history is the first run's, and
        // compacting it now hands the summarizer that history as it stands.
        agent.compactNow();

        assertEquals(1, provider.summaries.size(), "premise: the summarizer was asked");
        assertEquals(CLAUDE_MD, sent(provider.summaries.getFirst(), "c1"),
                "the agent's own history was rewritten by the request view");
    }

    @Test
    void twoConsecutiveRequestsWithNoNewElidableResultSendIdenticalHistory() {
        Scripted provider = wholeFileReadThenTenSmallTurns(-1);

        run(new Agent(options(provider).build()));

        // The stub lands at turn 7 (five assistant turns after the read, one more
        // than KEEP_TURNS = 4). Every later turn adds one small echo and nothing
        // elidable, so each request must start with the one before it, byte for
        // byte: that is what keeps an Anthropic cached prefix alive.
        int firstStubbed = -1;
        // Request 1 is the one that asks for the read, so it carries no result.
        for (int i = 1; i < provider.requests.size(); i++) {
            if (!sent(provider.requests.get(i), "c1").contains("LINE-OF-CLAUDE-MD")) {
                firstStubbed = i;
                break;
            }
        }
        assertTrue(firstStubbed > 0, "premise: some request stubbed the read");
        for (int i = firstStubbed + 1; i < provider.requests.size(); i++) {
            List<ProviderMessage> before = provider.requests.get(i - 1).messages();
            List<ProviderMessage> now = provider.requests.get(i).messages();
            assertEquals(before, now.subList(0, before.size()),
                    "request " + (i + 1) + " changed history request " + i + " had sent");
        }
    }

    @Test
    void theContextGaugeReadsTheSizeTheRequestCarries() {
        Scripted provider = wholeFileReadThenTenSmallTurns(-1);

        List<RunEvent> events = run(new Agent(options(provider).introspection(true).build()));

        List<RunEvent.ContextInfo> gauge = events.stream()
                .filter(RunEvent.ContextInfo.class::isInstance).map(RunEvent.ContextInfo.class::cast)
                .toList();
        assertEquals(12, gauge.size(), "one context_info per turn");
        int conversationAtTurnTwo = conversationChars(gauge.get(1));
        int conversationAtTurnTwelve = conversationChars(gauge.get(11));
        assertTrue(conversationAtTurnTwo >= CLAUDE_MD.length(),
                "premise: turn 2 carries the whole file, " + conversationAtTurnTwo);
        assertTrue(conversationAtTurnTwelve < CLAUDE_MD.length(),
                "the ring still counts the 56 kB the request no longer sends: "
                        + conversationAtTurnTwelve);
    }

    private static int conversationChars(RunEvent.ContextInfo info) {
        return info.parts().stream().filter(part -> "conversation".equals(part.label()))
                .mapToInt(RunEvent.ContextPart::chars).findFirst().orElseThrow();
    }

    @Test
    void aHistoryWithinTheBudgetReachesTheSummarizerWholeAndCompactsInTheSameTurnAsWithElisionOff() {
        // Usage crosses the threshold in turn 9, so compaction fires at the
        // top of turn 10, after the read was already stubbed in the requests.
        // The usage is scripted and does not follow the request's size, so the
        // same turn shows only that the trigger reads the same threshold option.
        // The whole 56 kB history fits the 40,000 token budget, which is why the
        // summarizer gets it whole; a history that does not fit is
        // aLongRunWhoseFullHistoryOutgrowsTheWindowStillCompacts.
        Scripted on = wholeFileReadThenTenSmallTurns(9);
        List<RunEvent> onEvents = run(new Agent(options(on).compactionThreshold(40_000).build()));
        Scripted off = wholeFileReadThenTenSmallTurns(9);
        List<RunEvent> offEvents = run(new Agent(options(off).compactionThreshold(40_000)
                .toolResultElision("off").build()));

        assertEquals(1, on.summaries.size(), "compaction did not fire with elision on");
        assertEquals(CLAUDE_MD, sent(on.summaries.getFirst(), "c1"),
                "the summarizer must see the full history, not the request view");
        assertEquals(compactionTurn(offEvents), compactionTurn(onEvents),
                "elision moved the turn compaction fires at");
    }

    @Test
    void theRequestOfTheTurnThatCompactedCarriesTheCompactedHistory() {
        // Compaction fires at the top of turn 10. The request view built
        // before it holds the old history; the request of turn 10 must be
        // built again from what compaction left.
        Scripted provider = wholeFileReadThenTenSmallTurns(9);

        List<RunEvent> events = run(new Agent(options(provider).compactionThreshold(40_000).build()));

        assertEquals(10, compactionTurn(events), "premise: compaction fired at the top of turn 10");
        ProviderRequest turnTen = provider.requests.get(9);
        boolean carriesTheSummary = turnTen.messages().stream()
                .flatMap(message -> message.content().stream())
                .filter(LlmProvider.TextContent.class::isInstance)
                .map(LlmProvider.TextContent.class::cast)
                .anyMatch(text -> text.text().contains("summary of the work so far"));
        assertTrue(carriesTheSummary, "turn 10 was sent without the summary compaction wrote");
        boolean carriesTheOldRead = turnTen.messages().stream()
                .flatMap(message -> message.content().stream())
                .anyMatch(content -> content instanceof LlmProvider.ToolCallContent call
                        && call.callId().equals("c1")
                        || content instanceof ToolResultContent result && result.callId().equals("c1"));
        assertFalse(carriesTheOldRead,
                "turn 10 still sent the history from before compaction, read of turn 1 included");
    }

    /** A backend with a window: usage is what the request holds at chars/4, and a larger request is refused. */
    private static final class Windowed implements LlmProvider {
        final List<ProviderRequest> summaries = new ArrayList<>();
        final List<Integer> refused = new ArrayList<>();
        final int window;
        final int readingTurns;
        int turns;

        Windowed(int window, int readingTurns) {
            this.window = window;
            this.readingTurns = readingTurns;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            int tokens = tokens(request);
            if (tokens > window) {
                refused.add(tokens);
                throw new IllegalStateException("context length exceeded: " + tokens + " > " + window);
            }
            if (request.system().startsWith(SUMMARY_SYSTEM_PREFIX)) {
                summaries.add(request);
                return List.of(new PTextDelta("summary of the work so far"),
                        new PStop(PStop.StopReason.END_TURN));
            }
            turns++;
            if (turns > readingTurns) {
                return List.of(new PTextDelta("done"), new PUsage(tokens, 2),
                        new PStop(PStop.StopReason.END_TURN));
            }
            return List.of(new PToolCall("p" + turns, "read_part",
                            JSON.createObjectNode().put("path", "part-" + turns)),
                    new PUsage(tokens, 2), new PStop(PStop.StopReason.TOOL_USE));
        }

        static int tokens(ProviderRequest request) {
            long chars = request.system().length();
            for (ProviderMessage message : request.messages()) {
                for (ProviderContent content : message.content()) {
                    chars += switch (content) {
                        case LlmProvider.TextContent text -> text.text().length();
                        case LlmProvider.ToolCallContent call -> call.name().length()
                                + call.input().toString().length();
                        case ToolResultContent result -> result.output().length();
                        default -> 0;
                    };
                }
            }
            return (int) (chars / 4);
        }
    }

    @Test
    void aLongRunWhoseFullHistoryOutgrowsTheWindowStillCompacts() {
        // Each turn reads 12,000 chars (3,000 tokens). The request keeps the
        // last five reads whole and stubs the rest, so it reaches the 16,000
        // token threshold only after about twenty stubs, when the full history
        // holds some 80,000 tokens: far more than the 30,000 the backend takes.
        Windowed provider = new Windowed(30_000, 32);
        String part = "PART-OF-A-FILE ".repeat(800);
        ToolRegistry registry = new ToolRegistry();
        registry.register(tool("read_part", part));

        List<RunEvent> events = run(new Agent(AgentOptions.builder()
                .provider(provider).systemPrompt("test").registry(registry).cwd(Path.of("."))
                .agentId("main").onPermission(request -> true).maxTurns(40)
                .compactionThreshold(16_000).build()));

        List<String> failures = events.stream().filter(RunEvent.ErrorEvent.class::isInstance)
                .map(RunEvent.ErrorEvent.class::cast).map(RunEvent.ErrorEvent::message).toList();
        assertEquals(List.of(), failures, "the run reported errors");
        assertTrue(events.stream().anyMatch(RunEvent.Compaction.class::isInstance),
                "premise: compaction fired");
        assertFalse(provider.summaries.isEmpty(), "premise: the summarizer was asked");
        assertEquals(List.of(), provider.refused,
                "the backend had to refuse requests larger than its window first");
    }

    private static int compactionTurn(List<RunEvent> events) {
        int turn = 0;
        for (RunEvent event : events) {
            if (event instanceof RunEvent.TurnStart start) {
                turn = start.turn();
            }
            if (event instanceof RunEvent.Compaction) {
                return turn;
            }
        }
        throw new AssertionError("no compaction in the run");
    }

    @Test
    void offSendsEveryResultInFull() {
        Scripted provider = wholeFileReadThenTenSmallTurns(-1);

        run(new Agent(options(provider).toolResultElision("off").build()));

        assertEquals(CLAUDE_MD, sent(provider.requests.get(11), "c1"),
                "toolResultElision off still stubbed a result");
    }

    @Test
    void aResultTheToolCannotGiveBackIsNeverStubbed() {
        Scripted provider = new Scripted();
        provider.script.add(List.of(
                new PToolCall("q1", "ask_person", JSON.createObjectNode().put("question", "which?")),
                new PUsage(10, 2), new PStop(PStop.StopReason.TOOL_USE)));
        for (int turn = 2; turn <= 11; turn++) {
            provider.script.add(List.of(
                    new PToolCall("e" + turn, "echo", JSON.createObjectNode().put("value", turn)),
                    new PUsage(10, 2), new PStop(PStop.StopReason.TOOL_USE)));
        }
        String answer = "ANSWER-OF-THE-PERSON ".repeat(1_000);

        run(new Agent(options(provider, once("ask_person", answer)).build()));

        assertEquals(answer, sent(provider.requests.get(11), "q1"),
                "a result that calling the tool again cannot give back was stubbed");
    }

    @Test
    void aResultOfAToolTheRegistryDoesNotHoldIsNeverStubbed() {
        // A resumed history names a tool this agent does not carry, so the
        // stub's promise to call it again would be false.
        String old = "OUTPUT-OF-A-TOOL-THAT-IS-GONE ".repeat(1_000);
        List<ProviderMessage> resumed = List.of(
                new ProviderMessage(ProviderMessage.Role.USER,
                        List.of(new LlmProvider.TextContent("earlier prompt"))),
                new ProviderMessage(ProviderMessage.Role.ASSISTANT,
                        List.of(new LlmProvider.ToolCallContent("g1", "gone_tool",
                                JSON.createObjectNode().put("path", "x")))),
                new ProviderMessage(ProviderMessage.Role.USER,
                        List.of(new ToolResultContent("g1", old, false))),
                new ProviderMessage(ProviderMessage.Role.ASSISTANT,
                        List.of(new LlmProvider.TextContent("noted"))));
        Scripted provider = new Scripted();
        for (int turn = 1; turn <= 10; turn++) {
            provider.script.add(List.of(
                    new PToolCall("e" + turn, "echo", JSON.createObjectNode().put("value", turn)),
                    new PUsage(10, 2), new PStop(PStop.StopReason.TOOL_USE)));
        }

        run(new Agent(options(provider).initialMessages(resumed).build()));

        assertEquals(old, sent(provider.requests.getLast(), "g1"),
                "a result of a tool this agent cannot call was stubbed");
    }
}
