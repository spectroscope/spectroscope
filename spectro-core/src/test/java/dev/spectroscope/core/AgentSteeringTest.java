package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.goal.GoalCheck;
import dev.spectroscope.core.goal.GoalVerdict;
import dev.spectroscope.core.goal.RunGoal;
import dev.spectroscope.core.goal.SessionGoal;
import dev.spectroscope.core.loop.ContinuationLeash;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.steering.SteeringInbox;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 380: a sentence the operator typed reaches the turn that was running.
 *
 * <p>Everything here runs against a scripted provider, so the turn the sentence
 * is submitted from is exact and no backend is needed. The submit happens from
 * INSIDE the provider call, which is literally "while that turn was working":
 * the loop is in the stream when the sentence arrives.</p>
 *
 * <p><b>Why turn 2 is a tool turn in criterion 2's test.</b> A run that reaches
 * the next turn through the tool round never touches the closing gate, so the
 * top-of-loop read is the only door the sentence can come through and the bite
 * on that read isolates it. With an answering turn 2 the gate would deliver the
 * same sentence and the bite would come back green on a broken read.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class AgentSteeringTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String SENTENCE = "use the cached list, not the API";

    /** A tool that always works. A turn that calls it reaches the next turn
     *  through the tool round and never through the closing gate. */
    private static class AlwaysWorks implements Tool {
        @Override public String name() {
            return "always_works";
        }

        @Override public String description() {
            return "does one small honest thing";
        }

        @Override public JsonNode inputSchema() {
            return JSON.createObjectNode().put("type", "object");
        }

        @Override public boolean needsPermission() {
            return false;
        }

        @Override public String execute(JsonNode input, ToolContext context) {
            return "done";
        }
    }

    /** A tool the gate is asked about, the positive half of criterion 7. */
    private static final class Gated extends AlwaysWorks {
        @Override public String name() {
            return "gated_tool";
        }

        @Override public boolean needsPermission() {
            return true;
        }
    }

    private static List<LlmProvider.ProviderEvent> toolTurn(String callId, String tool) {
        return List.of(new LlmProvider.PToolCall(callId, tool, JSON.createObjectNode()),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    private static List<LlmProvider.ProviderEvent> answerTurn() {
        return List.of(new LlmProvider.PTextDelta("All set."),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    /** Keeps every request, and runs a hook on the request's own thread before
     *  the turn streams, which is how a submit lands mid-turn. */
    private static final class Recording implements LlmProvider {
        private final List<List<LlmProvider.ProviderEvent>> script;
        private final java.util.function.IntConsumer duringTurn;
        final List<ProviderRequest> requests = new ArrayList<>();
        private final AtomicInteger next = new AtomicInteger();

        Recording(java.util.function.IntConsumer duringTurn,
                  List<List<LlmProvider.ProviderEvent>> script) {
            this.duringTurn = duringTurn;
            this.script = script;
        }

        @Override public String modelName() {
            return "fake-model-1";
        }

        @Override public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            int turn = next.incrementAndGet();
            duringTurn.accept(turn);
            return turn <= script.size() ? script.get(turn - 1) : answerTurn();
        }
    }

    private static Agent agent(LlmProvider provider, SteeringInbox inbox, Integer maxTurns,
                               Tool extra, PermissionBroker gate) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(new AlwaysWorks());
        if (extra != null) {
            registry.register(extra);
        }
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(gate != null ? gate : request -> true)
                .maxTurns(maxTurns)
                .steering(inbox)
                .build());
    }

    private static List<RunEvent> run(Agent agent) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("do it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static List<RunEvent.SteeringMessage> steerings(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.SteeringMessage.class::isInstance)
                .map(RunEvent.SteeringMessage.class::cast)
                .toList();
    }

    private static long turns(List<RunEvent> events) {
        return events.stream().filter(RunEvent.TurnStart.class::isInstance).count();
    }

    private static List<String> texts(ProviderMessage message) {
        return message.content().stream()
                .filter(TextContent.class::isInstance)
                .map(c -> ((TextContent) c).text())
                .toList();
    }

    private static String wholeHistory(ProviderRequest request) {
        StringBuilder all = new StringBuilder();
        for (ProviderMessage message : request.messages()) {
            for (ProviderContent content : message.content()) {
                if (content instanceof TextContent text) {
                    all.append(text.text()).append('\n');
                }
            }
        }
        return all.toString();
    }

    // ── criterion 2: the message reaches the turn that was running ─────────

    @Test
    void aSentenceTypedDuringTurnTwoIsInTheHistoryOfTurnThreeOfTheSameRun() {
        SteeringInbox inbox = new SteeringInbox();
        Recording provider = new Recording(
                turn -> {
                    if (turn == 2) {
                        inbox.submit(SENTENCE);
                    }
                },
                List.of(toolTurn("c1", "always_works"),
                        toolTurn("c2", "always_works"),
                        answerTurn()));

        List<RunEvent> events = run(agent(provider, inbox, null, null, null));

        assertEquals(3, provider.requests.size(),
                "turn 1 and 2 called a tool, turn 3 answered: " + provider.requests.size());
        assertTrue(wholeHistory(provider.requests.get(2)).contains(SENTENCE),
                "turn 3 reads what was typed during turn 2");
        assertFalse(wholeHistory(provider.requests.get(1)).contains(SENTENCE),
                "and turn 2's own request, built before the submit, does not");

        // Same run: nothing closed between the two turns.
        int steeringAt = -1;
        int runEndAt = -1;
        for (int i = 0; i < events.size(); i++) {
            if (events.get(i) instanceof RunEvent.SteeringMessage && steeringAt < 0) {
                steeringAt = i;
            }
            if (events.get(i) instanceof RunEvent.RunEnd && runEndAt < 0) {
                runEndAt = i;
            }
        }
        assertTrue(steeringAt >= 0, "the message is on the stream");
        assertTrue(runEndAt > steeringAt, "no run_end came between turn 2 and turn 3");
        assertEquals(1, steerings(events).size());
        assertTrue(steerings(events).getFirst().taken());
        assertEquals(3, steerings(events).getFirst().turn(),
                "recorded against the turn that read it");
    }

    // ── criterion 3: folded, never stacked ────────────────────────────────

    @Test
    void theSentenceIsFoldedIntoTheLastUserMessageRatherThanStackedBesideIt() {
        SteeringInbox inbox = new SteeringInbox();
        Recording provider = new Recording(
                turn -> {
                    if (turn == 2) {
                        inbox.submit(SENTENCE);
                    }
                },
                List.of(toolTurn("c1", "always_works"),
                        toolTurn("c2", "always_works"),
                        answerTurn()));

        run(agent(provider, inbox, null, null, null));
        List<ProviderMessage> history = provider.requests.get(2).messages();

        // The positive half first: without it the negative below is green on a
        // history that never received the message at all.
        ProviderMessage lastUser = null;
        for (ProviderMessage message : history) {
            if (message.role() == ProviderMessage.Role.USER) {
                lastUser = message;
            }
        }
        assertNotNull(lastUser, "the history ends on a user message");
        assertTrue(String.join("\n", texts(lastUser)).contains(SENTENCE),
                "and it is the one carrying the sentence");

        for (int i = 1; i < history.size(); i++) {
            assertFalse(history.get(i - 1).role() == ProviderMessage.Role.USER
                            && history.get(i).role() == ProviderMessage.Role.USER,
                    "two adjacent user messages reach Anthropic as 'roles must alternate', "
                            + "at index " + i);
        }
    }

    // ── criterion 4: the model is told who said it ────────────────────────

    @Test
    void theModelReadsTheSentenceAttributedAndQuotedAndNeverAsBareContent() {
        SteeringInbox inbox = new SteeringInbox();
        Recording provider = new Recording(
                turn -> {
                    if (turn == 2) {
                        inbox.submit(SENTENCE);
                    }
                },
                List.of(toolTurn("c1", "always_works"),
                        toolTurn("c2", "always_works"),
                        answerTurn()));

        run(agent(provider, inbox, null, null, null));

        String attributed = SteeringInbox.attributed(SENTENCE);
        assertTrue(wholeHistory(provider.requests.get(2)).contains(attributed),
                "the attributed sentence is what the model reads");

        // And the raw sentence never stands on its own as a content block. A
        // tool that printed a sentence and a person who typed one must not look
        // the same to the model. That is a prompt injection surface, not a
        // wording preference.
        for (ProviderMessage message : provider.requests.get(2).messages()) {
            for (String text : texts(message)) {
                assertFalse(text.equals(SENTENCE),
                        "the operator's words never travel as bare content: " + text);
            }
        }
    }

    // ── criterion 8: it keeps a run alive, exactly once ───────────────────

    @Test
    void aWaitingSentenceKeepsARunAliveThatWasAboutToEndAndBuysExactlyOneTurn() {
        SteeringInbox inbox = new SteeringInbox();
        Recording provider = new Recording(
                turn -> {
                    if (turn == 1) {
                        inbox.submit(SENTENCE);
                    }
                },
                List.of(answerTurn(), answerTurn()));

        List<RunEvent> events = run(agent(provider, inbox, null, null, null));

        assertEquals(2, turns(events),
                "turn 1 answered and would have ended; the sentence bought turn 2");
        assertEquals(1, steerings(events).size(),
                "one sentence, one continuation: a second turn would mean it was read twice");
        assertTrue(steerings(events).getFirst().taken());
        assertTrue(wholeHistory(provider.requests.get(1)).contains(SENTENCE));
    }

    // ── criterion 9: at the turn cap it loses, and says so ────────────────

    @Test
    void atTheTurnCapTheSentenceDoesNotContinueTheRunAndTheRecordSaysItWasNotTaken() {
        SteeringInbox inbox = new SteeringInbox();
        Recording provider = new Recording(
                turn -> {
                    if (turn == 1) {
                        inbox.submit(SENTENCE);
                    }
                },
                List.of(answerTurn(), answerTurn()));

        List<RunEvent> events = run(agent(provider, inbox, 1, null, null));

        assertEquals(1, turns(events), "the cap wins");
        assertEquals(1, steerings(events).size(), "and the refusal is on the record");
        assertFalse(steerings(events).getFirst().taken(),
                "nothing pretends the message was read");
        assertEquals(SENTENCE, steerings(events).getFirst().text());
    }

    // ── criterion 10: several fold in arrival order ───────────────────────

    @Test
    void threeSentencesReachTheModelAsOneTextInSubmissionOrder() {
        SteeringInbox inbox = new SteeringInbox();
        Recording provider = new Recording(
                turn -> {
                    if (turn == 1) {
                        inbox.submit("first");
                        inbox.submit("second");
                        inbox.submit("third");
                    }
                },
                List.of(toolTurn("c1", "always_works"), answerTurn()));

        run(agent(provider, inbox, null, null, null));

        List<ProviderMessage> history = provider.requests.get(1).messages();
        ProviderMessage lastUser = null;
        for (ProviderMessage message : history) {
            if (message.role() == ProviderMessage.Role.USER) {
                lastUser = message;
            }
        }
        assertNotNull(lastUser);
        assertTrue(texts(lastUser).contains(SteeringInbox.attributed("first\nsecond\nthird")),
                "one text, whole string, in submission order: " + texts(lastUser));
    }

    // ── criterion 11: blank changes nothing ───────────────────────────────

    @Test
    void aBlankSentenceProducesNoEventAndNoContinuationWhileARealOneDoesBoth() {
        SteeringInbox blankOnly = new SteeringInbox();
        Recording quiet = new Recording(
                turn -> {
                    if (turn == 1) {
                        blankOnly.submit("   ");
                    }
                },
                List.of(answerTurn(), answerTurn()));
        List<RunEvent> silent = run(agent(quiet, blankOnly, null, null, null));

        assertEquals(0, steerings(silent).size(), "blank leaves no line");
        assertEquals(1, turns(silent), "and buys no turn");

        // The positive twin on the same path: otherwise the negatives above are
        // green on a build that drops everything.
        SteeringInbox real = new SteeringInbox();
        Recording loud = new Recording(
                turn -> {
                    if (turn == 1) {
                        real.submit("  " + SENTENCE + "  ");
                    }
                },
                List.of(answerTurn(), answerTurn()));
        List<RunEvent> spoken = run(agent(loud, real, null, null, null));

        assertEquals(1, steerings(spoken).size(), "exactly one event for one sentence");
        assertEquals(SENTENCE, steerings(spoken).getFirst().text(), "trimmed at the edge");
        assertEquals(2, turns(spoken));
    }

    // ── criterion 7: it authorises nothing ────────────────────────────────

    @Test
    void aSteeringMessageDoesNotAnswerAPendingPermissionRequest() {
        // The positive first: the message WAS delivered, so the three negatives
        // below are not green on a tree where nothing happened at all.
        List<String> asked = new ArrayList<>();
        SteeringInbox inbox = new SteeringInbox();
        Recording provider = new Recording(
                turn -> {
                    if (turn == 1) {
                        inbox.submit(SENTENCE);
                    }
                },
                List.of(toolTurn("c1", "gated_tool"), answerTurn()));

        List<RunEvent> events = run(agent(provider, inbox, null, new Gated(), request -> {
            asked.add(request.name());
            return true;
        }));

        assertEquals(1, steerings(events).size(), "delivered");
        assertEquals(List.of("gated_tool"), asked,
                "the gate was still asked, so the sentence answered nothing for it");
    }

    // The loop has no allowlist and no permission mode of its own; it asks the
    // broker it was built with. The browser session's broker reads both off
    // SessionConnection, so the mode and the allowlist halves of criterion 7
    // are pinned there, in SessionSteeringAuthorisesNothingTest, against the
    // fields that broker reads. A test here used to assert on an Allowlist it
    // built itself and never handed to the agent, which no loop could change.

    @Test
    void aSteeringMessageDoesNotChangeWhatTheGateIsAskedAbout() {
        // What core can measure: a gated tool is gated the same number of times
        // whether a sentence arrived or not.
        List<String> withMessage = new ArrayList<>();
        SteeringInbox inbox = new SteeringInbox();
        run(agent(new Recording(turn -> {
            if (turn == 1) {
                inbox.submit(SENTENCE);
            }
        }, List.of(toolTurn("c1", "gated_tool"), toolTurn("c2", "gated_tool"), answerTurn())),
                inbox, null, new Gated(), request -> {
                    withMessage.add(request.name());
                    return true;
                }));

        List<String> without = new ArrayList<>();
        run(agent(new Recording(turn -> { },
                        List.of(toolTurn("c1", "gated_tool"), toolTurn("c2", "gated_tool"),
                                answerTurn())),
                new SteeringInbox(), null, new Gated(), request -> {
                    without.add(request.name());
                    return true;
                }));

        assertEquals(without, withMessage,
                "the same calls met the same gate, message or no message");
        assertEquals(2, without.size(), "and the gate was actually reached");
    }

    // ── fix round 2026-09-24: a sentence never outlives its run ──────────
    //
    // The audit of 2026-09-21 found the opposite of what owner call 3 asked
    // for: a sentence the run did not read stayed in the inbox and the NEXT
    // run folded it into its first request, attributed as "sent while you were
    // working" to a run that never saw it. One test per way a run can end,
    // because each exit is its own line in the loop and a fix at one of them
    // says nothing about the others.

    private static final String NEXT_PROMPT = "an unrelated second prompt";

    private static List<RunEvent> run(Agent agent, CancelSignal signal, String prompt) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run(prompt, new RunOptions(signal, null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static String stopReason(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.RunEnd.class::isInstance)
                .map(e -> ((RunEvent.RunEnd) e).stopReason())
                .reduce((first, second) -> second)
                .orElseThrow();
    }

    /**
     * The four facts every exit owes the operator, asserted together.
     *
     * <p>The positive half comes first on purpose: the record names the sentence
     * as not taken, INSIDE the run, before its run_end. Without that line the
     * negatives below would be green on a loop that silently threw the
     * sentence away, which is the one outcome worse than the defect.</p>
     */
    private static void assertTheRunGaveTheSentenceBack(List<RunEvent> events, SteeringInbox inbox,
                                                        Agent agent, Recording provider,
                                                        String expectedStop) {
        assertEquals(expectedStop, stopReason(events), "the exit under test");
        List<RunEvent.SteeringMessage> said = steerings(events);
        assertEquals(1, said.size(), "one line for the sentence the run did not read: " + said);
        assertFalse(said.getFirst().taken(), "nothing pretends it was read");
        assertEquals(SENTENCE, said.getFirst().text(), "the operator's own words, for the fallback");
        int lineAt = events.indexOf(said.getFirst());
        int endAt = events.indexOf(events.stream()
                .filter(RunEvent.RunEnd.class::isInstance).findFirst().orElseThrow());
        assertTrue(lineAt < endAt, "the line belongs to the run it missed, so it comes before run_end");

        assertFalse(inbox.waiting(), "the inbox is empty once the run is over");

        int before = provider.requests.size();
        List<RunEvent> next = run(agent, new CancelSignal(), NEXT_PROMPT);
        assertTrue(provider.requests.size() > before, "the next run did ask the provider");
        String firstRequest = wholeHistory(provider.requests.get(before));
        assertTrue(firstRequest.contains(NEXT_PROMPT), "the next run reads its own prompt");
        assertFalse(firstRequest.contains(SENTENCE),
                "and never the sentence the previous run missed: " + firstRequest);
        assertEquals(0, steerings(next).size(), "the next run records no steering at all");
    }

    @Test
    void endTurnAtTheCapGivesTheSentenceBackAndTheNextRunNeverReadsIt() {
        SteeringInbox inbox = new SteeringInbox();
        Recording provider = new Recording(
                turn -> {
                    if (turn == 1) {
                        inbox.submit(SENTENCE);
                    }
                },
                List.of(answerTurn(), answerTurn()));
        Agent agent = agent(provider, inbox, 1, null, null);

        List<RunEvent> events = run(agent, new CancelSignal(), "do it");

        assertTheRunGaveTheSentenceBack(events, inbox, agent, provider, "end_turn");
    }

    @Test
    void maxTurnsGivesTheSentenceBackAndTheNextRunNeverReadsIt() {
        // Turn 2 is the last permitted one and calls a tool, so the loop runs
        // out of turns rather than reaching the closing gate.
        SteeringInbox inbox = new SteeringInbox();
        Recording provider = new Recording(
                turn -> {
                    if (turn == 2) {
                        inbox.submit(SENTENCE);
                    }
                },
                List.of(toolTurn("c1", "always_works"), toolTurn("c2", "always_works")));
        Agent agent = agent(provider, inbox, 2, null, null);

        List<RunEvent> events = run(agent, new CancelSignal(), "do it");

        assertTheRunGaveTheSentenceBack(events, inbox, agent, provider, "max_turns");
    }

    @Test
    void maxTokensGivesTheSentenceBackAndTheNextRunNeverReadsIt() {
        SteeringInbox inbox = new SteeringInbox();
        Recording provider = new Recording(
                turn -> {
                    if (turn == 1) {
                        inbox.submit(SENTENCE);
                    }
                },
                List.of(List.of(new LlmProvider.PTextDelta("cut off mid"),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.MAX_TOKENS))));
        Agent agent = agent(provider, inbox, null, null, null);

        List<RunEvent> events = run(agent, new CancelSignal(), "do it");

        assertTheRunGaveTheSentenceBack(events, inbox, agent, provider, "max_tokens");
    }

    @Test
    void anErrorGivesTheSentenceBackAndTheNextRunNeverReadsIt() {
        SteeringInbox inbox = new SteeringInbox();
        Recording provider = new Recording(
                turn -> {
                    if (turn == 1) {
                        inbox.submit(SENTENCE);
                        throw new IllegalStateException("backend went away");
                    }
                },
                List.of());
        Agent agent = agent(provider, inbox, null, null, null);

        List<RunEvent> events = run(agent, new CancelSignal(), "do it");

        assertTheRunGaveTheSentenceBack(events, inbox, agent, provider, "error");
    }

    @Test
    void anAbortGivesTheSentenceBackAndTheNextRunNeverReadsIt() {
        // The stop path itself is not touched here. The cancel is flipped from
        // inside the turn, which is where the stop button's cancel lands too,
        // and the test only reads what the loop's existing abort exit leaves.
        SteeringInbox inbox = new SteeringInbox();
        CancelSignal signal = new CancelSignal();
        Recording provider = new Recording(
                turn -> {
                    if (turn == 1) {
                        inbox.submit(SENTENCE);
                        signal.cancel();
                    }
                },
                List.of(answerTurn()));
        Agent agent = agent(provider, inbox, null, null, null);

        List<RunEvent> events = run(agent, signal, "do it");

        assertTheRunGaveTheSentenceBack(events, inbox, agent, provider, "aborted");
    }

    @Test
    void aCancelThatNamesABudgetGivesTheSentenceBackAndTheNextRunNeverReadsIt() {
        // A run cut by a budget ends through a named cancel (card 270). The
        // reason is a different value on the same exit, and this pins that the
        // value does not change what happens to the sentence.
        SteeringInbox inbox = new SteeringInbox();
        CancelSignal signal = new CancelSignal();
        Recording provider = new Recording(
                turn -> {
                    if (turn == 1) {
                        inbox.submit(SENTENCE);
                        signal.cancel(dev.spectroscope.core.subagents.ChildBudget.STOP_BUDGET_EXHAUSTED);
                    }
                },
                List.of(answerTurn()));
        Agent agent = agent(provider, inbox, null, null, null);

        List<RunEvent> events = run(agent, signal, "do it");

        assertTheRunGaveTheSentenceBack(events, inbox, agent, provider,
                dev.spectroscope.core.subagents.ChildBudget.STOP_BUDGET_EXHAUSTED);
    }

    // ── fix round 2, 2026-09-24: a stated goal does not close the door ────
    //
    // With a card 267 goal stated, the goal's branch of the closing gate left
    // the gate on every end_turn (it returned, or continued when the leash let
    // a failed check buy a turn) before the steering gate was consulted, so a
    // waiting sentence never kept such a run alive (criterion 8, scenario 2).

    /** A goal check whose verdicts are scripted, one per call, the last one
     *  repeated. Counts its runs. */
    private static final class ScriptedCheck implements GoalCheck {
        private final List<GoalVerdict> script;
        private final AtomicInteger next = new AtomicInteger();
        final AtomicInteger runs = new AtomicInteger();

        ScriptedCheck(GoalVerdict... verdicts) {
            this.script = List.of(verdicts);
        }

        @Override public GoalVerdict run(RunGoal goal, Context context) {
            runs.incrementAndGet();
            return script.get(Math.min(next.getAndIncrement(), script.size() - 1));
        }
    }

    private static GoalVerdict met() {
        return new GoalVerdict(GoalVerdict.Outcome.MET, "node --test", 0, "ok 4", 12, null, null,
                "met: the check exited 0");
    }

    private static GoalVerdict failed(String output) {
        return new GoalVerdict(GoalVerdict.Outcome.FAILED, "node --test", 1, output, 12, null,
                null, "failed: the check exited 1");
    }

    private static SessionGoal goal(GoalCheck check) {
        SessionGoal session = new SessionGoal(check);
        session.state(new RunGoal("The auth tests pass.", "node --test"));
        return session;
    }

    private static Agent goalAgent(LlmProvider provider, SteeringInbox inbox, SessionGoal goal,
                                   ContinuationLeash leash, Integer maxTurns) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(new AlwaysWorks());
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .maxTurns(maxTurns)
                .goal(goal)
                .continuationLeash(leash)
                .steering(inbox)
                .build());
    }

    @Test
    void aWaitingSentenceKeepsARunWithAStatedGoalAliveAndTheNextRequestCarriesIt() {
        SteeringInbox inbox = new SteeringInbox();
        ScriptedCheck check = new ScriptedCheck(met());
        Recording provider = new Recording(
                turn -> {
                    if (turn == 1) {
                        inbox.submit(SENTENCE);
                    }
                },
                List.of(answerTurn(), answerTurn()));

        List<RunEvent> events = run(goalAgent(provider, inbox, goal(check), null, null));

        assertEquals(2, provider.requests.size(),
                "turn 1 answered with a goal stated; the waiting sentence buys turn 2");
        assertTrue(wholeHistory(provider.requests.get(1)).contains(SteeringInbox.attributed(SENTENCE)),
                "the request for turn 2 carries the sentence, attributed");
        assertEquals(1, steerings(events).size(), "one sentence, one line");
        assertTrue(steerings(events).getFirst().taken(), "and the line says it was read");

        List<RunEvent> ends = events.stream().filter(RunEvent.RunEnd.class::isInstance).toList();
        assertEquals(1, ends.size(), "one run, not two");
        assertTrue(events.indexOf(steerings(events).getFirst()) < events.indexOf(ends.getFirst()),
                "the sentence was read before the run ended");
        assertEquals(GoalVerdict.MET_STOP_REASON, stopReason(events),
                "the goal still decides the exit that ends the run");
        assertEquals(1, check.runs.get(),
                "the check ran once, at the exit that ended the run, not at the one the sentence kept open");
    }

    @Test
    void aGoalRunThatEndsByAbortOrErrorAfterASentenceKeptItOpenRunsNoCheck() {
        // The exit a sentence keeps open is not graded, and the abort and error
        // exits do not grade either. This pins what the loop does today; the
        // card lists it as a consequence the owner has not been asked about.
        record Ending(String name, boolean cancel, String stop) {
        }
        for (Ending ending : List.of(new Ending("abort", true, "aborted"),
                new Ending("error", false, "error"))) {
            SteeringInbox inbox = new SteeringInbox();
            CancelSignal signal = new CancelSignal();
            ScriptedCheck check = new ScriptedCheck(met());
            Recording provider = new Recording(
                    turn -> {
                        if (turn == 1) {
                            inbox.submit(SENTENCE);
                        }
                        if (turn == 2 && ending.cancel()) {
                            signal.cancel();
                        }
                        if (turn == 2 && !ending.cancel()) {
                            throw new IllegalStateException("backend went away");
                        }
                    },
                    List.of(answerTurn(), answerTurn()));

            List<RunEvent> events = run(goalAgent(provider, inbox, goal(check), null, null),
                    signal, "do it");

            // The positive half: the sentence did keep the first exit open.
            assertEquals(2, provider.requests.size(), ending.name() + ": turn 2 was asked for");
            assertEquals(1, steerings(events).size(), ending.name() + ": one sentence, one line");
            assertTrue(steerings(events).getFirst().taken(), ending.name() + ": the sentence was read");
            assertEquals(ending.stop(), stopReason(events), ending.name() + ": the exit under test");

            assertEquals(0, check.runs.get(), ending.name() + ": the check never ran");
            assertFalse(events.stream().anyMatch(RunEvent.GoalCheck.class::isInstance),
                    ending.name() + ": and no goal_check line is on the stream");
        }
    }

    @Test
    void atTheCapAndOnMaxTokensAStatedGoalGradesWhileTheSentenceWaitsAndTheSentenceIsHandedBack() {
        // The steering read at the closing gate runs only on an end_turn below
        // the cap. On these two exits it does not run, so the goal's check
        // grades the exit with the sentence still in the inbox.
        record Exit(String name, List<List<LlmProvider.ProviderEvent>> script, Integer maxTurns,
                    String stop) {
        }
        List<Exit> exits = List.of(
                new Exit("end_turn at the cap", List.of(answerTurn()), 1,
                        GoalVerdict.MET_STOP_REASON),
                new Exit("max_tokens", List.of(List.of(new LlmProvider.PTextDelta("cut off"),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.MAX_TOKENS))), null,
                        "max_tokens"));

        for (Exit exit : exits) {
            SteeringInbox inbox = new SteeringInbox();
            ScriptedCheck check = new ScriptedCheck(met());
            Recording provider = new Recording(
                    turn -> {
                        if (turn == 1) {
                            inbox.submit(SENTENCE);
                        }
                    },
                    exit.script());
            Agent agent = goalAgent(provider, inbox, goal(check), null, exit.maxTurns());

            List<RunEvent> events = run(agent, new CancelSignal(), "do it");

            assertEquals(1, provider.requests.size(), exit.name() + ": no turn was added");
            assertEquals(exit.stop(), stopReason(events), exit.name() + ": the exit under test");
            assertEquals(1, check.runs.get(), exit.name() + ": the check ran at this exit");
            RunEvent graded = events.stream().filter(RunEvent.GoalCheck.class::isInstance)
                    .findFirst().orElse(null);
            assertNotNull(graded, exit.name() + ": and its line is on the stream");
            assertEquals(1, steerings(events).size(), exit.name() + ": one line for the sentence");
            assertTrue(events.indexOf(graded) < events.indexOf(steerings(events).getFirst()),
                    exit.name() + ": the check ran before the sentence was handed back");
            assertTheRunGaveTheSentenceBack(events, inbox, agent, provider, exit.stop());
        }
    }

    /** The events of one run as the wire writes them, with the fields that come
     *  from the clock or from a random id set to fixed values. */
    private static List<String> wireLines(List<RunEvent> events) {
        List<String> lines = new ArrayList<>();
        for (RunEvent event : events) {
            com.fasterxml.jackson.databind.node.ObjectNode node = JSON.valueToTree(event);
            node.put("ts", 0L);
            if (node.has("runId")) {
                node.put("runId", "run");
            }
            if (node.hasNonNull("gateWaitMs")) {
                node.put("gateWaitMs", 0L);
            }
            if (node.hasNonNull("callId")
                    && node.get("callId").asText().matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")) {
                node.put("callId", "uuid");
            }
            lines.add(node.toString());
        }
        return lines;
    }

    /** Every request as text: the system prompt, the budget, the reasoning
     *  settings, the advertised tool names and every message with its role and
     *  content. The cancel signal and the wire tap are runtime handles and are
     *  left out. */
    private static List<String> requestLines(List<ProviderRequest> requests) {
        List<String> lines = new ArrayList<>();
        for (ProviderRequest request : requests) {
            lines.add("system: " + request.system());
            lines.add("maxTokens: " + request.maxTokens() + ", reasoning: " + request.reasoning()
                    + ", effort: " + request.effort());
            lines.add("tools: " + request.tools().stream().map(LlmProvider.ToolSpec::name).toList());
            for (ProviderMessage message : request.messages()) {
                lines.add(message.toString());
            }
        }
        return lines;
    }

    @Test
    void withAGoalAndNothingWaitingAnEmptyInboxChangesNoLineOfTheStreamAndNoRequest() {
        // Three exits of the goal's branch: a failed check that continues and
        // then a met one, the token ceiling, and the turn cap. Each is run
        // twice, once with an empty inbox wired and once with no inbox at all,
        // which is the loop as it was before card 380.
        record Scenario(String name, List<List<LlmProvider.ProviderEvent>> script,
                        java.util.function.Supplier<ScriptedCheck> check, boolean leash,
                        Integer maxTurns, String stop) {
        }
        List<List<LlmProvider.ProviderEvent>> maxTokens = List.of(List.of(
                new LlmProvider.PTextDelta("cut off"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.MAX_TOKENS)));
        List<Scenario> scenarios = List.of(
                new Scenario("failed then met", List.of(answerTurn(), answerTurn()),
                        () -> new ScriptedCheck(failed("expected 0.2, got 0.18432"), met()), true,
                        null, GoalVerdict.MET_STOP_REASON),
                new Scenario("token ceiling", maxTokens, () -> new ScriptedCheck(met()), true, null,
                        "max_tokens"),
                new Scenario("turn cap", List.of(answerTurn()),
                        () -> new ScriptedCheck(failed("still red")), true, 1,
                        GoalVerdict.UNMET_STOP_REASON));

        for (Scenario scenario : scenarios) {
            Recording withInbox = new Recording(turn -> { }, scenario.script());
            List<RunEvent> inboxEvents = run(goalAgent(withInbox, new SteeringInbox(),
                    goal(scenario.check().get()),
                    scenario.leash() ? new ContinuationLeash(3) : null, scenario.maxTurns()));

            Recording withoutInbox = new Recording(turn -> { }, scenario.script());
            List<RunEvent> plainEvents = run(goalAgent(withoutInbox, null,
                    goal(scenario.check().get()),
                    scenario.leash() ? new ContinuationLeash(3) : null, scenario.maxTurns()));

            // The positive half: the goal's branch really decided this run.
            assertEquals(scenario.stop(), stopReason(plainEvents), scenario.name());
            assertTrue(plainEvents.stream().anyMatch(RunEvent.GoalCheck.class::isInstance),
                    scenario.name() + ": the check ran and its line is on the stream");

            assertEquals(wireLines(plainEvents), wireLines(inboxEvents),
                    scenario.name() + ": an empty inbox changes no line of a goal run");
            assertEquals(requestLines(withoutInbox.requests), requestLines(withInbox.requests),
                    scenario.name() + ": and no request the model sees");
            assertEquals(0, steerings(inboxEvents).size(), scenario.name());
        }
    }

    // ── the null inbox leaves the loop as it was ──────────────────────────

    @Test
    void aRunWithNoInboxEmitsNoSteeringLineAtAll() {
        // Headless keeps its stream: spectro run, a cron fire and a fleet node
        // wire no inbox, so nothing about their events changes.
        Recording provider = new Recording(turn -> { },
                List.of(toolTurn("c1", "always_works"), answerTurn()));

        List<RunEvent> events = run(agent(provider, null, null, null, null));

        assertEquals(0, steerings(events).size());
        assertEquals(2, turns(events));
    }
}
