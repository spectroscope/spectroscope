package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.loop.ContinuationLeash;
import dev.spectroscope.core.progress.ProgressGuard;
import dev.spectroscope.core.progress.ProgressSettings;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.tools.UpdatePlanTool;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 266 inside the loop: the harness keeps an unfinished run going, on a
 * leash.
 *
 * <p>Everything here runs against a scripted provider and the real
 * {@link UpdatePlanTool}, so the ledger the leash reads is written the way a
 * live model writes it — through the tool, onto the wire, past the loop. The
 * count is therefore deterministic and no backend is needed, which is criterion
 * 9's whole demand.</p>
 *
 * <p><b>The interaction this file exists to pin.</b> Card 262's guard pauses a
 * run that MOVES without progressing; this card's leash re-enters a run that
 * stopped without finishing. Two hands on one steering wheel, and the rule is
 * positional: the guard runs INSIDE a turn (before the provider call, and around
 * every tool call), the leash runs at the terminal exit AFTER the turn is over.
 * So the guard always speaks first, its END ends the run before the leash is
 * consulted at all, and a tool call the guard blocked — or one that came back an
 * error — is not progress. That last line is what stops a continuation from
 * manufacturing card 262's own spin under a nicer name.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class AgentContinuationTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** 283 characters of the same thing — the shape card 262 was measured on. */
    private static final String BODY = "// spring toward the target, damped each step\n"
            + "export function stepParticle(p, tx, ty, k, dt) {\n"
            + "  const ax = (tx - p.x) * k;\n"
            + "  const ay = (ty - p.y) * k;\n"
            + "  p.vx = (p.vx + ax * dt) * 0.9;\n"
            + "  p.vy = (p.vy + ay * dt) * 0.9;\n"
            + "  p.x = p.x + p.vx * dt;\n"
            + "  p.y = p.y + p.vy * dt;\n"
            + "  return p;\n"
            + "}\n";

    private static ObjectNode planInput(String... statuses) {
        var steps = JSON.createArrayNode();
        for (int i = 0; i < statuses.length; i++) {
            steps.addObject().put("text", "step " + (i + 1)).put("status", statuses[i]);
        }
        return (ObjectNode) JSON.createObjectNode().set("steps", steps);
    }

    private static List<LlmProvider.ProviderEvent> planTurn(String callId, String... statuses) {
        return List.of(new LlmProvider.PToolCall(callId, "update_plan", planInput(statuses)),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    private static List<LlmProvider.ProviderEvent> answerTurn() {
        return List.of(new LlmProvider.PTextDelta("All set."),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    private static List<LlmProvider.ProviderEvent> callTurn(String callId, String tool,
                                                            JsonNode input) {
        return List.of(new LlmProvider.PToolCall(callId, tool, input),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    private static List<LlmProvider.ProviderEvent> writeTurn(String callId, String path) {
        return callTurn(callId, "write_file",
                JSON.createObjectNode().put("path", path).put("content", BODY));
    }

    /** A tool whose every call fails the same way — a test command that never passes. */
    private static final class AlwaysFails implements Tool {
        @Override public String name() {
            return "always_fails";
        }

        @Override public String description() {
            return "runs something that never passes";
        }

        @Override public JsonNode inputSchema() {
            return JSON.createObjectNode().put("type", "object");
        }

        @Override public boolean needsPermission() {
            return false;
        }

        @Override public String execute(JsonNode input, ToolContext context) {
            return "ERROR: 1 test failed — expected 0.2, got 0.18432";
        }
    }

    /** A tool that always works — one clean call is what "something happened" means. */
    private static final class AlwaysWorks implements Tool {
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

    /** Keeps every request so the harness-authored message can be read back. */
    private static final class Recording implements LlmProvider {
        private final LlmProvider inner;
        final List<ProviderRequest> requests = new ArrayList<>();

        Recording(LlmProvider inner) {
            this.inner = inner;
        }

        @Override public String modelName() {
            return "fake-model-1";
        }

        @Override public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            return inner.stream(request);
        }
    }

    /** The scripted turns, in order; anything past the script is a plain answer. */
    @SafeVarargs
    private static LlmProvider scripted(List<LlmProvider.ProviderEvent>... turns) {
        List<List<LlmProvider.ProviderEvent>> script = List.of(turns);
        AtomicInteger next = new AtomicInteger();
        return request -> {
            if (request.signal().isCancelled()) {
                return List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.ABORTED));
            }
            int index = next.getAndIncrement();
            return index < script.size() ? script.get(index) : answerTurn();
        };
    }

    /** A model that never finishes: it re-plans, answers, re-plans, answers. Each
     *  plan is genuinely different, so nothing here is refused for standing still. */
    private static LlmProvider neverFinishes() {
        AtomicInteger turn = new AtomicInteger();
        return request -> {
            int n = turn.incrementAndGet();
            if (n % 2 == 1) {
                var steps = JSON.createArrayNode();
                steps.addObject().put("text", "attempt " + n).put("status", "pending");
                steps.addObject().put("text", "verify " + n).put("status", "pending");
                return List.of(new LlmProvider.PToolCall("c" + n, "update_plan",
                                JSON.createObjectNode().set("steps", steps)),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
            }
            return answerTurn();
        };
    }

    /**
     * A model that answers every continuation by re-writing the SAME ledger,
     * byte for byte, and doing nothing else.
     *
     * <p>The shape the live AC-8 run took, and the reason this file's review
     * came back blocking: {@code update_plan} is itself a tool, and the
     * harness's own continuation message asks the model to "mark it and say
     * why" — i.e. to call it. A ledger re-emitted unchanged must therefore not
     * count as the work half of the signature, or the leash buys its next turn
     * with its own instruction.</p>
     */
    private static LlmProvider reWritesTheIdenticalPlan() {
        AtomicInteger turn = new AtomicInteger();
        return request -> {
            int n = turn.incrementAndGet();
            return n % 2 == 1 ? planTurn("c" + n, "pending", "pending") : answerTurn();
        };
    }

    /** Writes a ledger on its very first turn and never touches one again — so
     *  the agent's latest-wins {@code lastPlan} outlives the run that wrote it. */
    private static LlmProvider plansOnceAndThenNeverAgain() {
        AtomicInteger turn = new AtomicInteger();
        return request -> turn.incrementAndGet() == 1
                ? planTurn("c1", "pending", "pending")
                : answerTurn();
    }

    private static Agent agent(LlmProvider provider, ContinuationLeash leash) {
        return agent(provider, leash, null, null, null, Path.of("."), false);
    }

    private static Agent agent(LlmProvider provider, ContinuationLeash leash, Integer maxTurns,
                               ProgressGuard guard, Tool extra, Path cwd, boolean standardTools) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(new UpdatePlanTool());
        if (standardTools) {
            StandardTools.all().forEach(registry::register);
        }
        if (extra != null) {
            registry.register(extra);
        }
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(cwd)
                .onPermission(request -> true)
                .continuationLeash(leash)
                .maxTurns(maxTurns)
                .progressGuard(guard)
                .build());
    }

    private static List<RunEvent> run(Agent agent) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("do it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static String lastStopReason(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.RunEnd.class::isInstance)
                .map(RunEvent.RunEnd.class::cast)
                .reduce((first, second) -> second)
                .orElseThrow()
                .stopReason();
    }

    private static List<RunEvent.Continuation> continuations(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.Continuation.class::isInstance)
                .map(RunEvent.Continuation.class::cast)
                .toList();
    }

    private static List<String> decisions(List<RunEvent> events) {
        return continuations(events).stream().map(RunEvent.Continuation::decision).toList();
    }

    private static long turns(List<RunEvent> events) {
        return events.stream().filter(RunEvent.TurnStart.class::isInstance).count();
    }

    // ── criterion 1: the loop starts another turn ──────────────────────────

    @Test
    void aRunThatStopsWithStepsOpenIsStartedAgain() {
        List<RunEvent> events = run(agent(scripted(
                planTurn("c1", "completed", "completed", "in_progress",
                        "pending", "pending", "pending"),
                answerTurn(),
                answerTurn()), new ContinuationLeash(3)));

        assertEquals(List.of("continued", "no_progress"), decisions(events),
                "the first stop is continued; the second, with nothing changed, is not");
        assertEquals(3, turns(events),
                "turn 1 planned, turn 2 stopped, turn 3 is the harness's own");
        RunEvent.Continuation first = continuations(events).getFirst();
        assertEquals(4, first.openSteps());
        assertEquals(6, first.totalSteps());
        assertEquals(1, first.continuation());
        assertEquals(3, first.budget());
    }

    @Test
    void theHarnessAuthorsTheContinuationAndTheModelReadsIt() {
        // Criterion 1's whole point: the model needs no tool and no cooperation.
        // The message is written by the loop and lands in the history as user
        // content, which is the one place the next turn is certain to read.
        Recording provider = new Recording(scripted(
                planTurn("c1", "completed", "in_progress", "pending"),
                answerTurn(),
                answerTurn()));
        run(agent(provider, new ContinuationLeash(3)));

        String lastUserText = provider.requests.getLast().messages().stream()
                .filter(message -> message.role() == LlmProvider.ProviderMessage.Role.USER)
                .flatMap(message -> message.content().stream())
                .filter(LlmProvider.TextContent.class::isInstance)
                .map(content -> ((LlmProvider.TextContent) content).text())
                .reduce((first, second) -> second)
                .orElseThrow();

        assertTrue(lastUserText.contains("step 2"), lastUserText);
        assertTrue(lastUserText.contains("step 3"), lastUserText);
        assertTrue(lastUserText.contains("in_progress"), lastUserText);
        assertTrue(lastUserText.contains("2 of 3"), lastUserText);
        assertFalse(lastUserText.contains("step 1"),
                "step 1 is completed and naming it invites a redo: " + lastUserText);
    }

    @Test
    void aFinishedPlanEndsExactlyAsItAlwaysDid() {
        List<RunEvent> events = run(agent(scripted(
                planTurn("c1", "completed", "completed"),
                answerTurn()), new ContinuationLeash(3)));

        assertEquals("end_turn", lastStopReason(events));
        assertEquals(List.of(), decisions(events), "a clean finish is not a leash event");
        assertEquals(2, turns(events));
    }

    @Test
    void aRunWithNoPlanAtAllIsNeverContinued() {
        // The house backend's normal case: a model with no tool belt writes no
        // ledger, so card 264's verdict is UNKNOWN — and nobody can grade a run
        // that never said what it was doing. Continuing one would be the harness
        // guessing, which is exactly what card 264 refused to invent.
        List<RunEvent> events = run(agent(scripted(answerTurn()), new ContinuationLeash(3)));

        assertEquals("end_turn", lastStopReason(events));
        assertEquals(List.of(), decisions(events));
        assertEquals(1, turns(events));
    }

    @Test
    void withoutALeashTheLoopIsExactlyWhatItWasBefore() {
        List<RunEvent> events = run(agent(scripted(
                planTurn("c1", "pending", "pending"),
                answerTurn()), null));

        assertEquals("unfinished", lastStopReason(events), "card 264's word, untouched");
        assertEquals(List.of(), decisions(events));
        assertEquals(2, turns(events));
    }

    // ── criterion 2: the bound is real and sits on the feedback path ───────

    @Test
    void theBudgetIsSpentAndThenTheRunEndsSayingSo() {
        List<RunEvent> events = run(agent(neverFinishes(), new ContinuationLeash(2)));

        assertEquals(List.of("continued", "continued", "budget_exhausted"), decisions(events));
        assertEquals(ContinuationLeash.STOP_REASON, lastStopReason(events),
                "criterion 4: distinct from a clean finish AND from card 264's plain"
                        + " unfinished — this run was held twice and still has steps open");
        RunEvent.Continuation last = continuations(events).getLast();
        assertEquals(2, last.continuation());
        assertEquals(2, last.budget());
        assertEquals(2, last.openSteps());
        assertEquals(2, last.totalSteps());
    }

    @Test
    void aContinuationCannotBuyItselfMoreTurns() {
        // The bound that matters most, because a continuation effectively raises
        // the ceiling: the turn counter keeps counting ACROSS continuations —
        // the leash re-enters the same `for`, it does not restart it. With a
        // budget of ten and a cap of four, four is what the run gets.
        List<RunEvent> events = run(agent(neverFinishes(), new ContinuationLeash(10), 4,
                null, null, Path.of("."), false));

        assertEquals(4, turns(events), "ten continuations may not buy an eleventh turn");
        assertEquals(1, continuations(events).size(),
                "the leash is consulted BELOW the cap and never AT it: a continuation"
                        + " recorded on the last permitted turn is a line that lies, because"
                        + " the run it promises can never start. Got " + decisions(events));
    }

    @Test
    void theCapIsAnOptionAndNotAPrivateConstant() {
        // MAX_TURNS joins maxTokens and compactionThreshold in AgentOptions
        // (criterion 2). Three turns is enough to prove the number is read AND
        // that the brake keeps its own name.
        List<RunEvent> events = run(agent(neverFinishes(), new ContinuationLeash(10), 3,
                null, null, Path.of("."), false));

        assertEquals(3, turns(events));
        assertEquals("max_turns", lastStopReason(events),
                "losing 'this run hit the cap' would trade one silence for another");
    }

    @Test
    void aSecondPromptOnTheSameAgentGetsItsWholeBudgetBack() {
        // One agent serves every prompt of a browser session, so a budget that
        // outlived the run would leave the second prompt of an evening with
        // nothing left. Card 262's review found exactly this shape in the
        // guard's memory; the leash carries the same reset for the same reason.
        Agent agent = agent(neverFinishes(), new ContinuationLeash(1));

        assertEquals(List.of("continued", "budget_exhausted"), decisions(run(agent)));
        assertEquals(List.of("continued", "budget_exhausted"), decisions(run(agent)),
                "the second prompt is its own task and gets its own budget");
    }

    @Test
    void anUnrelatedSecondPromptIsNotContinuedAgainstTheFirstPromptsAbandonedLedger() {
        // Card 264 keeps the ledger with the AGENT, latest-wins, so the footer and
        // the Plan panel agree — a decision about REPORTING. This card turns the
        // same ledger into ACTION, and an inherited one buys a provider exchange
        // telling the model "you stopped, but the plan you wrote still has 2 of 2
        // steps open" about a task the user has already moved on from. So the
        // leash is graded by a plan THIS run wrote; a run that wrote none is
        // PlanVerdict.UNKNOWN territory, which card 264 already refuses to grade.
        Agent agent = agent(plansOnceAndThenNeverAgain(), new ContinuationLeash(3));

        assertEquals(List.of("continued", "no_progress"), decisions(run(agent)),
                "the premise: the first prompt did write a ledger and was held on it");

        List<RunEvent> second = run(agent);
        assertEquals(List.of(), decisions(second),
                "the second prompt wrote no ledger of its own, so there is nothing here"
                        + " for the harness to hold it to");
        assertEquals(PlanVerdict.UNFINISHED_STOP_REASON, lastStopReason(second),
                "card 264's reporting is deliberately untouched: the ledger still says"
                        + " unfinished, and only the leash stops acting on it");
    }

    // ── criterion 5: it cannot spin ────────────────────────────────────────

    @Test
    void aRunThatStopsTwiceWithTheSamePlanAndNoToolCallsIsNotContinuedAThirdTime() {
        // The scenario on the card, word for word.
        List<RunEvent> events = run(agent(scripted(
                planTurn("c1", "pending", "pending"),
                answerTurn(), answerTurn(), answerTurn(), answerTurn()),
                new ContinuationLeash(5)));

        assertEquals(List.of("continued", "no_progress"), decisions(events));
        assertEquals(3, turns(events), "the third turn is the last one this run gets");
        assertEquals(ContinuationLeash.STOP_REASON, lastStopReason(events));
    }

    @Test
    void aLedgerReEmittedUnchangedIsNotWorkAndBuysNoFurtherContinuation() {
        // The review's blocking finding, replayed as a test. In the live AC-8 run
        // (~/.spectro/sessions/20260819-014333-f072f411.jsonl) continuation 2 was
        // granted after a denied write and an update_plan whose ledger hashed
        // identically to turn 1's — the plan half of the signature said "unchanged"
        // and the work half flipped anyway, because the plan tool was counted in
        // BOTH halves. Criterion 5 names "a plan that has not advanced" as the
        // thing that must not earn another turn.
        List<RunEvent> events = run(agent(reWritesTheIdenticalPlan(), new ContinuationLeash(3)));

        List<RunEvent.Plan> ledgers = events.stream()
                .filter(RunEvent.Plan.class::isInstance)
                .map(RunEvent.Plan.class::cast)
                .toList();
        assertTrue(ledgers.size() >= 2,
                "the premise: the model wrote its ledger more than once, " + ledgers.size());
        assertEquals(PlanVerdict.planSignature(ledgers.get(0)),
                PlanVerdict.planSignature(ledgers.get(1)),
                "the premise: the second ledger is byte-identical to the first");

        assertEquals(List.of("continued", "no_progress"), decisions(events),
                "the plan tool is the leash's own instruction answered back — the plan"
                        + " half already grades it, so counting it as work too lets the"
                        + " harness buy its own next turn");
        assertEquals(ContinuationLeash.STOP_REASON, lastStopReason(events));
    }

    @Test
    void aToolCallThatKeepsFailingIsNotProgress() {
        // Card 262's second detector in the leash's language: the same command
        // failing on unchanged input has moved nothing, so a continuation that
        // follows it is a continuation into the same wall.
        List<RunEvent> events = run(agent(scripted(
                planTurn("c1", "pending", "pending"),
                answerTurn(),
                callTurn("f1", "always_fails", JSON.createObjectNode()),
                answerTurn(), answerTurn()),
                new ContinuationLeash(5), null, null, new AlwaysFails(), Path.of("."), false));

        assertEquals(List.of("continued", "no_progress"), decisions(events));
    }

    @Test
    void oneCleanToolCallIsProgressAndEarnsAnotherContinuation() {
        // The other direction of the same pin, and it is what makes the pin mean
        // anything: a run that DID something gets held again.
        List<RunEvent> events = run(agent(scripted(
                planTurn("c1", "pending", "pending"),
                answerTurn(),
                callTurn("w1", "always_works", JSON.createObjectNode()),
                answerTurn(), answerTurn()),
                new ContinuationLeash(5), null, null, new AlwaysWorks(), Path.of("."), false));

        assertEquals(List.of("continued", "continued", "no_progress"), decisions(events));
    }

    // ── the two hands on one wheel: card 262 × card 266 ────────────────────

    @Test
    void theGuardsEndIsFinalAndTheLeashNeverOverturnsIt() {
        // Both mechanics apply to this run: the plan sits still (the guard's
        // third detector) AND the run is continuable (steps open, budget left).
        // The guard runs inside the turn and the leash at the exit, so an END
        // ends the run there and then. A run the operator stopped must not be
        // restarted by the harness one line later.
        ProgressGuard guard = new ProgressGuard(new ProgressSettings(0, 0, 1),
                question -> new Asker.Answer(List.of(ProgressGuard.END_LABEL)));
        List<RunEvent> events = run(agent(scripted(
                planTurn("c1", "pending", "pending"),
                answerTurn(), answerTurn(), answerTurn()),
                new ContinuationLeash(5), null, guard, null, Path.of("."), false));

        assertEquals(ProgressGuard.STOP_REASON, lastStopReason(events));
        assertEquals(1, events.stream().filter(RunEvent.RunEnd.class::isInstance).count(),
                "exactly one ending, whatever the two mechanics think of each other");
        int ended = indexOf(events, RunEvent.NoProgress.class);
        int lastHeld = lastIndexOf(events, RunEvent.Continuation.class);
        assertTrue(lastHeld < ended,
                "every leash decision of this run is BEFORE the guard ended it: "
                        + decisions(events));
    }

    @Test
    void aCallTheGuardStoppedIsNotProgressForTheLeash(@TempDir Path cwd) {
        // The shared signal, from the other side. Three honest writes are
        // progress; the fourth identical one is refused by card 262's first
        // detector, never runs, and therefore counts for nothing — so the stop
        // that follows it is refused instead of continued. Without this the
        // leash would keep feeding turns to exactly the loop the guard just
        // blocked, which is card 262's own failure mode under a nicer name.
        ProgressGuard guard = new ProgressGuard(new ProgressSettings(3, 0, 0),
                question -> new Asker.Answer(List.of(ProgressGuard.CHANGE_COURSE_LABEL)));
        List<RunEvent> events = run(agent(scripted(
                planTurn("c1", "pending", "pending"),
                writeTurn("w1", "src/particleEngine.js"),
                writeTurn("w2", "src/particleEngine2.js"),
                writeTurn("w3", "src/particleEngine3.js"),
                answerTurn(),
                writeTurn("w4", "src/particleEngine4.js"),
                answerTurn(), answerTurn()),
                new ContinuationLeash(5), null, guard, null, cwd, true));

        assertTrue(events.stream().anyMatch(RunEvent.NoProgress.class::isInstance),
                "the guard saw the fourth copy — without that this pins nothing");
        assertEquals(List.of("continued", "no_progress"), decisions(events));
    }

    // ── criterion 6: cancel and close reach it ─────────────────────────────

    @Test
    @Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
    void anAbortAtTheContinuationEndsTheRunAndDoesNotReEnter() throws InterruptedException {
        // The provider PARKS on the turn the leash bought, so the producer
        // cannot run ahead of the consumer's stop. A race here would make the
        // count a coin toss, and a race test that is "tidied up" goes blind
        // without anything turning red.
        AtomicInteger call = new AtomicInteger();
        LlmProvider parksAfterTheContinuation = request -> {
            int n = call.incrementAndGet();
            if (n == 1) {
                return planTurn("c1", "pending", "pending");
            }
            if (n == 2) {
                return answerTurn();
            }
            for (int spin = 0; spin < 2_000 && !request.signal().isCancelled(); spin++) {
                try {
                    Thread.sleep(5);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            return List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.ABORTED));
        };

        CancelSignal signal = new CancelSignal();
        Agent agent = agent(parksAfterTheContinuation, new ContinuationLeash(10));
        List<RunEvent> events = new ArrayList<>();
        EventStream stream = agent.run("do it", new RunOptions(signal, null));
        try (stream) {
            for (RunEvent event : stream) {
                events.add(event);
                if (event instanceof RunEvent.Continuation) {
                    signal.cancel(); // stop pressed the moment the harness holds on
                }
            }
        }

        assertEquals("aborted", lastStopReason(events),
                "how it stopped is the more urgent fact, and the leash must not eat it");
        assertEquals(1, events.stream().filter(RunEvent.RunEnd.class::isInstance).count());
        assertEquals(1, continuations(events).size(),
                "a cancelled run is not continued a second time");

        // Criterion 6's third clause, in words on the card and until the review
        // asserted by nothing: "leaves no producer thread alive". A leash that
        // re-entered the loop after the cancel would strand exactly this thread,
        // and the consumer side could not tell — the END sentinel arrives either
        // way. The wait is bounded because the producer unwinds asynchronously;
        // it is not a sleep that hides a race, it is the join this API has no
        // method for.
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (((QueueEventStream) stream).producerAlive() && System.nanoTime() < deadline) {
            Thread.sleep(5);
        }
        assertFalse(((QueueEventStream) stream).producerAlive(),
                "the run is over, so the virtual thread that produced it must be gone");
    }

    @Test
    void aRunCancelledBeforeTheExitIsNotContinuedAtAll() {
        // The cancel lands INSIDE the provider, which the run loop calls on its
        // own thread, so it is ordered strictly before the leash consult that
        // ends the turn. It used to be raised from the consumer loop when the
        // Plan event arrived — and that raced the run: on a loaded machine the
        // consumer was late, the leash was consulted first, and the assertion
        // below saw [continued]. Measured in the integration gate of
        // 2026-08-19, green 5 of 5 in isolation and red under five parallel
        // module suites.
        //
        // WHICH guard this actually holds, measured rather than assumed. Not the
        // `!signal.isCancelled()` in the leash arm — that one is belt and braces
        // and the code says so in its own comment; replacing it with `true`
        // leaves this test green. The guarantee comes from the loop's abort
        // exit, which returns on a cancelled signal before a turn can reach the
        // leash at all. Deleting the `|| signal.isCancelled()` there turns this
        // test red, which is the bite that earns its name.
        //
        // Nothing about the production code moved. What was wrong was a test
        // that raced its own precondition, which this project counts as a test
        // that cannot fail honestly.
        CancelSignal signal = new CancelSignal();
        Agent agent = agent(cancellingAfterThePlan(signal), new ContinuationLeash(3));
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("do it", new RunOptions(signal, null))) {
            stream.forEach(events::add);
        }

        assertEquals("aborted", lastStopReason(events));
        assertEquals(List.of(), decisions(events),
                "a run whose signal was already cancelled must not buy a continuation");
    }

    /** Plans on the first turn, then cancels ON THE RUN LOOP'S OWN THREAD and
     *  stops — so "cancelled before the exit" is an ordering, not a hope.
     *  @param signal the run's signal, cancelled from inside the second call
     *  @return the provider */
    private static LlmProvider cancellingAfterThePlan(CancelSignal signal) {
        AtomicInteger next = new AtomicInteger();
        return request -> {
            if (next.getAndIncrement() == 0) {
                return planTurn("c1", "pending", "pending");
            }
            signal.cancel();
            // END_TURN, deliberately, NOT an aborted stop. An aborted stop leaves
            // the loop before the leash is ever consulted, so a test built that
            // way stays green with the cancel check deleted — measured. The run
            // has to arrive at the exit the ordinary way, with an unfinished plan
            // and a cancelled signal, because that arrival is the only place the
            // check can be the thing that stops the continuation.
            return answerTurn();
        };
    }

    // ── criterion 4: the exit says how often it held on ────────────────────

    @Test
    void theExitSaysHowOftenItHeldTheRunAndWhereThatLeftThePlan() {
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(Agent.class);
        ch.qos.logback.classic.Level before = logger.getLevel();
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> records =
                new ch.qos.logback.core.read.ListAppender<>();
        records.start();
        logger.setLevel(ch.qos.logback.classic.Level.INFO);
        logger.addAppender(records);
        try {
            run(agent(neverFinishes(), new ContinuationLeash(2)));
            List<String> lines = records.list.stream()
                    .map(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage)
                    .filter(line -> line.startsWith("continuation leash "))
                    .toList();
            assertEquals(List.of("continuation leash held this run 2 times, "
                    + "and it ended unfinished (2 of 2 steps open)"), lines);
        } finally {
            logger.detachAppender(records);
            logger.setLevel(before);
        }
    }

    private static int indexOf(List<RunEvent> events, Class<? extends RunEvent> type) {
        for (int i = 0; i < events.size(); i++) {
            if (type.isInstance(events.get(i))) {
                return i;
            }
        }
        return -1;
    }

    private static int lastIndexOf(List<RunEvent> events, Class<? extends RunEvent> type) {
        for (int i = events.size() - 1; i >= 0; i--) {
            if (type.isInstance(events.get(i))) {
                return i;
            }
        }
        return -1;
    }
}
