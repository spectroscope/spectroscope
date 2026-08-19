package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.goal.CommandGoalCheck;
import dev.spectroscope.core.goal.GoalCheck;
import dev.spectroscope.core.goal.GoalVerdict;
import dev.spectroscope.core.goal.RunGoal;
import dev.spectroscope.core.goal.SessionGoal;
import dev.spectroscope.core.loop.ContinuationLeash;
import dev.spectroscope.core.progress.ProgressGuard;
import dev.spectroscope.core.progress.ProgressSettings;

import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.tools.UpdatePlanTool;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 267 inside the loop: a goal with a check that has teeth.
 *
 * <p>Everything here runs against a scripted provider and a stub check, so no
 * backend is needed — criterion 9's demand. The stub is what lets the run end
 * met, failed and untested on command, which a real {@code node --test} could
 * only do by having a Node installed on every machine that runs the gate.</p>
 *
 * <p><b>Where the check sits, and why it is there and not elsewhere.</b> Three
 * mechanics now share the loop and their order is positional, not negotiable:</p>
 * <ul>
 *   <li>card 262's guard runs INSIDE a turn (before the provider call, and
 *       around every tool call). It speaks first, and its END ends the run
 *       before anything below is consulted at all.</li>
 *   <li>card 263's compaction runs at the head of a turn and rewrites
 *       {@code messages}. It never touches the system prompt, which is why the
 *       goal survives it.</li>
 *   <li>THIS card's check runs at the terminal exit, BEFORE card 266's leash —
 *       and where a goal is stated, INSTEAD of it. The leash reads a plan
 *       ledger; the check reads the world. Criterion 7 says the verdict is
 *       derived from the check and the two never disagree in the record, and the
 *       only way two graders never disagree is if exactly one of them grades.
 *       A failing check then BUYS its continuation from the same budget, so the
 *       bound stays one number an operator can read (criterion 6).</li>
 * </ul>
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class AgentGoalTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String SYSTEM = "test";

    private static final String OUTCOME = "The auth tests pass, including refresh tokens.";

    // ── fixtures ──────────────────────────────────────────────────────────

    /** A check whose verdicts are scripted, so a run can be driven to any of the
     *  three endings without a Node, a Gradle or a network. */
    private static final class ScriptedCheck implements GoalCheck {
        private final List<GoalVerdict> script;
        private final AtomicInteger next = new AtomicInteger();
        final AtomicInteger runs = new AtomicInteger();

        ScriptedCheck(GoalVerdict... verdicts) {
            this.script = List.of(verdicts);
        }

        @Override public GoalVerdict run(RunGoal goal, Context context) {
            runs.incrementAndGet();
            int index = next.getAndIncrement();
            return script.get(Math.min(index, script.size() - 1));
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

    private static GoalVerdict untested() {
        return new GoalVerdict(GoalVerdict.Outcome.UNTESTED, "node --test", null, "", 3, null,
                null, "untested: the check could not be run — no such file");
    }

    /** Keeps every request, so the system prompt of EVERY turn can be read back. */
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

    private static List<LlmProvider.ProviderEvent> answerTurn() {
        return List.of(new LlmProvider.PTextDelta("I did what I could."),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    /** Answers, every time, without calling anything — the shape the house
     *  backend actually takes, and the entire reason placement (a) exists. */
    private static LlmProvider alwaysJustAnswers() {
        return request -> answerTurn();
    }

    /** Does one clean tool call, then answers — so the leash's own progress half
     *  moves and a refusal cannot be blamed on a standing-still model. */
    private static LlmProvider worksThenAnswers() {
        AtomicInteger turn = new AtomicInteger();
        return request -> turn.incrementAndGet() % 2 == 1
                ? List.of(new LlmProvider.PToolCall("c" + turn.get(), "always_works",
                        JSON.createObjectNode()),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE))
                : answerTurn();
    }

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

    private static SessionGoal goal(GoalCheck check, String outcome, String command) {
        SessionGoal session = new SessionGoal(check);
        session.state(new RunGoal(outcome, command));
        return session;
    }

    private static Agent agent(LlmProvider provider, SessionGoal goal, ContinuationLeash leash) {
        return agent(provider, goal, leash, Path.of("."), request -> true, null);
    }

    private static Agent agent(LlmProvider provider, SessionGoal goal, ContinuationLeash leash,
                               Path cwd, PermissionBroker broker, Integer maxTurns) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(new UpdatePlanTool());
        registry.register(new AlwaysWorks());
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt(SYSTEM)
                .registry(registry)
                .cwd(cwd)
                .onPermission(broker)
                .goal(goal)
                .continuationLeash(leash)
                .maxTurns(maxTurns)
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

    private static List<RunEvent.GoalCheck> checks(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.GoalCheck.class::isInstance)
                .map(RunEvent.GoalCheck.class::cast)
                .toList();
    }

    private static List<RunEvent.Continuation> continuations(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.Continuation.class::isInstance)
                .map(RunEvent.Continuation.class::cast)
                .toList();
    }

    // ── criterion 2: the goal reaches the model on EVERY turn ─────────────

    @Test
    void theGoalIsInEveryRequestsSystemPromptByteForByte() {
        Recording provider = new Recording(worksThenAnswers());
        run(agent(provider, goal(new ScriptedCheck(met()), OUTCOME, "node --test"),
                new ContinuationLeash(0)));
        assertTrue(provider.requests.size() >= 2, "needs more than one turn to be a test");
        for (LlmProvider.ProviderRequest request : provider.requests) {
            assertTrue(request.system().contains(OUTCOME),
                    "a turn without the goal: " + request.system());
        }
    }

    @Test
    void aRunWithoutAGoalCarriesNotOneExtraByte() {
        // The null-goal path has to leave the loop exactly as card 266 left it,
        // or every existing session pays a token bill for a feature it does not
        // use.
        Recording provider = new Recording(alwaysJustAnswers());
        run(agent(provider, null, null));
        assertEquals(SYSTEM, provider.requests.get(0).system());
        assertEquals(List.of(), checks(run(agent(new Recording(alwaysJustAnswers()), null, null))));
    }

    @Test
    void theGoalSurvivesCompaction() {
        // THE test on the card. Compaction rewrites `messages` and summarises
        // history; a goal that lived only in the first user message is a goal
        // the harness summarises away on exactly the long runs that need it.
        //
        // It asserts the PROPERTY and not the number: card 263 moves the
        // threshold under this test, so the run is driven past whatever
        // threshold is in force by reporting an input-token count above it, and
        // the assertion is that a Compaction event happened AND the late turns
        // still carry the goal.
        CompactingProvider provider = new CompactingProvider();
        List<RunEvent> events = run(new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt(SYSTEM)
                .registry(registryWithWorks())
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .compactionThreshold(1_000) // an explicit number: this test is not about deriving one
                .goal(goal(new ScriptedCheck(met()), OUTCOME, "node --test"))
                .maxTurns(6)
                .build()));
        assertTrue(events.stream().anyMatch(RunEvent.Compaction.class::isInstance),
                "the run never crossed the threshold, so it proves nothing");
        assertTrue(provider.turnRequests.size() >= 3, "too few turns to have a late one");
        LlmProvider.ProviderRequest last =
                provider.turnRequests.get(provider.turnRequests.size() - 1);
        assertTrue(last.system().contains(OUTCOME),
                "the last turn lost the goal: " + last.system());
        assertFalse(last.messages().stream().anyMatch(message -> message.content().stream()
                        .anyMatch(part -> part instanceof LlmProvider.TextContent text
                                && text.text().contains(OUTCOME))),
                "this test would pass for the wrong reason if the goal were also in the history");
    }

    private static ToolRegistry registryWithWorks() {
        ToolRegistry registry = new ToolRegistry();
        registry.register(new UpdatePlanTool());
        registry.register(new AlwaysWorks());
        return registry;
    }

    /** Reports a big input-token count so compaction fires, and keeps the TURN
     *  requests apart from the summarizer's own call by the system prompt's
     *  prefix — the goal makes the two no longer comparable by equality. */
    private static final class CompactingProvider implements LlmProvider {
        final List<ProviderRequest> turnRequests = new ArrayList<>();
        private int turn;

        @Override public String modelName() {
            return "fake-model-1";
        }

        @Override public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (!request.system().startsWith(SYSTEM)) {
                return List.of(new PTextDelta("the story so far"),
                        new PStop(PStop.StopReason.END_TURN));
            }
            turnRequests.add(request);
            turn++;
            if (turn < 4) {
                return List.of(new PToolCall("c" + turn, "always_works", JSON.createObjectNode()),
                        new PUsage(50_000, 3),
                        new PStop(PStop.StopReason.TOOL_USE));
            }
            return List.of(new PTextDelta("done"), new PUsage(50_000, 3),
                    new PStop(PStop.StopReason.END_TURN));
        }
    }

    // ── criterion 3: the check decides the ending ─────────────────────────

    @Test
    void aPassingCheckEndsTheRunDoneAndNamesTheCheck() {
        List<RunEvent> events = run(agent(new Recording(alwaysJustAnswers()),
                goal(new ScriptedCheck(met()), OUTCOME, "node --test"),
                new ContinuationLeash(3)));
        assertEquals(GoalVerdict.MET_STOP_REASON, lastStopReason(events));
        assertEquals(1, checks(events).size());
        assertEquals("met", checks(events).get(0).outcome());
        assertEquals("node --test", checks(events).get(0).command());
        assertEquals(0, checks(events).get(0).exitCode());
    }

    @Test
    void aFailingCheckContinuesTheRunWithTheFailureAsTheGuidance() {
        // The scenario, line by line: the model answers without calling a tool
        // and the check still fails, so the harness continues with the failing
        // output as the guidance.
        Recording provider = new Recording(alwaysJustAnswers());
        List<RunEvent> events = run(agent(provider,
                goal(new ScriptedCheck(failed("expected 0.2, got 0.18432"), met()), OUTCOME,
                        "node --test"),
                new ContinuationLeash(3)));
        assertEquals(GoalVerdict.MET_STOP_REASON, lastStopReason(events));
        assertEquals(1, continuations(events).size());
        assertEquals("continued", continuations(events).get(0).decision());
        String secondTurn = lastUserText(provider.requests.get(1));
        assertTrue(secondTurn.contains("expected 0.2, got 0.18432"),
                "the model was not told what actually failed: " + secondTurn);
    }

    @Test
    void anUnrunnableCheckEndsTheRunUntestedAndNeverMet() {
        List<RunEvent> events = run(agent(new Recording(alwaysJustAnswers()),
                goal(new ScriptedCheck(untested()), OUTCOME, "node --test"),
                new ContinuationLeash(3)));
        assertEquals(GoalVerdict.UNTESTED_STOP_REASON, lastStopReason(events));
        assertEquals("untested", checks(events).get(0).outcome());
        assertEquals(0, continuations(events).size(),
                "an unrunnable check must not buy a turn: there is nothing to react to");
    }

    @Test
    void theCheckRunsOncePerWouldBeEndingAndNotPerTurn() {
        // The non-functional criterion. A check on every turn would run a test
        // suite between every pair of the model's sentences.
        ScriptedCheck check = new ScriptedCheck(met());
        run(agent(new Recording(worksThenAnswers()), goal(check, OUTCOME, "node --test"),
                new ContinuationLeash(0)));
        assertEquals(1, check.runs.get(), "the check ran " + check.runs.get() + " times");
    }

    @Test
    void aCeilingKeepsItsOwnNameAndTheRecordStillSaysWhetherTheOutcomeWasReached() {
        // Found by the live AC-8 run and not by reading the diff: with the check
        // wired only to the voluntary exit, a run that hit the turn cap ended
        // `max_turns` and carried NO verdict at all — the operator stated a
        // check and got no answer from it.
        //
        // So the two facts are separated instead of traded. run_end keeps
        // `max_turns`, because losing "this run hit the cap" would trade one
        // silence for another (card 266's own words about the same line), and
        // the goal_check line is emitted beside it, because criterion 4 says a
        // verdict is never a claim and a missing verdict is not a claim either.
        // No continuation: there is no turn left to continue INTO.
        ScriptedCheck check = new ScriptedCheck(failed("still red"));
        List<RunEvent> events = run(agent(new Recording(request ->
                        List.of(new LlmProvider.PToolCall("c", "always_works",
                                        JSON.createObjectNode()),
                                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE))),
                goal(check, OUTCOME, "node --test"), new ContinuationLeash(3),
                Path.of("."), request -> true, 3));
        assertEquals("max_turns", lastStopReason(events));
        assertEquals(1, checks(events).size(), "the cap swallowed the verdict");
        assertEquals("failed", checks(events).get(0).outcome());
        assertEquals(0, continuations(events).size(),
                "there is no turn left to continue into");
    }

    @Test
    void theTokenCeilingIsTheSameCase() {
        List<RunEvent> events = run(agent(new Recording(request ->
                        List.of(new LlmProvider.PTextDelta("cut off"),
                                new LlmProvider.PStop(LlmProvider.PStop.StopReason.MAX_TOKENS))),
                goal(new ScriptedCheck(met()), OUTCOME, "node --test"),
                new ContinuationLeash(3)));
        assertEquals("max_tokens", lastStopReason(events),
                "a run the token budget cut off must not be reported as goal_met");
        assertEquals(1, checks(events).size());
        assertEquals("met", checks(events).get(0).outcome());
    }

    // ── criterion 6: the check cannot become the thing that spins ─────────

    @Test
    void aFailingCheckConsumesTheContinuationBudgetAndTheRunEndsUnmet() {
        Recording provider = new Recording(worksThenAnswers());
        List<RunEvent> events = run(agent(provider,
                goal(new ScriptedCheck(failed("still red 1"), failed("still red 2"),
                        failed("still red 3"), failed("still red 4")), OUTCOME, "node --test"),
                new ContinuationLeash(2)));
        assertEquals(GoalVerdict.UNMET_STOP_REASON, lastStopReason(events));
        assertEquals(List.of("continued", "continued", "budget_exhausted"),
                continuations(events).stream().map(RunEvent.Continuation::decision).toList());
    }

    @Test
    void theSameInputFailingTheSameWayTwiceIsNotAThirdContinuation() {
        // Card 262's signal, applied to the check: a model that changes nothing
        // and a check that says the same thing is the spin, and a budget of
        // three would otherwise buy three turns of it.
        List<RunEvent> events = run(agent(new Recording(alwaysJustAnswers()),
                goal(new ScriptedCheck(failed("expected 0.2, got 0.18432")), OUTCOME,
                        "node --test"),
                new ContinuationLeash(5)));
        assertEquals(GoalVerdict.UNMET_STOP_REASON, lastStopReason(events));
        assertEquals(List.of("continued", "no_progress"),
                continuations(events).stream().map(RunEvent.Continuation::decision).toList());
    }

    @Test
    void aRunWithoutALeashStillGetsItsVerdictItJustDoesNotContinue() {
        List<RunEvent> events = run(agent(new Recording(alwaysJustAnswers()),
                goal(new ScriptedCheck(failed("red")), OUTCOME, "node --test"), null));
        assertEquals(GoalVerdict.UNMET_STOP_REASON, lastStopReason(events));
        assertEquals(1, checks(events).size());
        assertEquals(0, continuations(events).size());
    }

    // ── criterion 7: the verdict comes from the check, not the ledger ─────

    @Test
    void aPassingCheckOverridesAnOpenPlanLedger() {
        // Card 264 renames a voluntary exit with steps open to `unfinished`, and
        // card 266's leash then re-enters it. Where a goal exists, neither
        // happens: the check is the grader, and two graders that both speak are
        // two graders that can disagree in one record.
        LlmProvider plansThenAnswers = request -> {
            var steps = JSON.createArrayNode();
            steps.addObject().put("text", "step 1").put("status", "pending");
            steps.addObject().put("text", "step 2").put("status", "pending");
            return List.of(new LlmProvider.PToolCall("p1", "update_plan",
                            JSON.createObjectNode().set("steps", steps)),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
        };
        AtomicInteger turn = new AtomicInteger();
        LlmProvider provider = request -> turn.incrementAndGet() == 1
                ? plansThenAnswers.stream(request) : answerTurn();
        List<RunEvent> events = run(agent(new Recording(provider),
                goal(new ScriptedCheck(met()), OUTCOME, "node --test"),
                new ContinuationLeash(3)));
        assertEquals(GoalVerdict.MET_STOP_REASON, lastStopReason(events));
        assertEquals(0, continuations(events).size(),
                "the plan-ledger leash spoke as well, so the record has two graders");
    }

    // ── criterion 5: the goal grants nothing, and the check is gated ──────

    @Test
    void theCheckAsksTheSameGateEveryOtherCommandAsks(@TempDir Path dir) throws Exception {
        List<RunEvent.PermissionRequest> asked = new ArrayList<>();
        List<RunEvent> events = run(agent(new Recording(alwaysJustAnswers()),
                goal(new CommandGoalCheck(), OUTCOME, "touch ran-anyway"),
                new ContinuationLeash(0), dir, request -> {
                    asked.add(request);
                    return false;
                }, null));
        assertEquals(1, asked.size(), "the check ran without asking anybody");
        assertEquals(GoalVerdict.UNTESTED_STOP_REASON, lastStopReason(events));
        assertFalse(Files.exists(dir.resolve("ran-anyway")),
                "a denied check executed anyway");
        assertTrue(events.stream().anyMatch(RunEvent.PermissionDecision.class::isInstance),
                "a gate that asks without recording its answer is not a gate");
    }

    @Test
    void aDeniedCheckIsUntestedAndNeverFailed(@TempDir Path dir) {
        // "The operator would not let me look" is not "it did not pass". Only
        // untested keeps the two apart, and only untested refuses to spend the
        // continuation budget on a question nobody answered.
        List<RunEvent> events = run(agent(new Recording(alwaysJustAnswers()),
                goal(new CommandGoalCheck(), OUTCOME, "exit 0"),
                new ContinuationLeash(3), dir, request -> false, null));
        assertEquals(GoalVerdict.UNTESTED_STOP_REASON, lastStopReason(events));
        assertEquals("untested", checks(events).get(0).outcome());
        assertEquals(0, continuations(events).size());
    }

    @Test
    void theGateIsAskedOncePerRunForTheSameCommand(@TempDir Path dir) {
        // The command comes from the frozen statement, not from the model, so
        // every ask after the first would be the same question about the same
        // bytes — and a person's attention is the thing card 262 spends
        // carefully.
        AtomicInteger asks = new AtomicInteger();
        List<RunEvent> events = run(agent(new Recording(worksThenAnswers()),
                goal(new CommandGoalCheck(), OUTCOME, "exit 1"),
                new ContinuationLeash(3), dir, request -> {
                    asks.incrementAndGet();
                    return true;
                }, null));
        assertEquals(GoalVerdict.UNMET_STOP_REASON, lastStopReason(events));
        assertTrue(checks(events).size() >= 2, "only one check ran, so this pins nothing");
        assertEquals(1, asks.get(), "the operator was asked " + asks.get() + " times");
    }

    @Test
    void theGateWaitIsRecordedApartFromTheChecksOwnTime(@TempDir Path dir) {
        List<RunEvent> events = run(agent(new Recording(alwaysJustAnswers()),
                goal(new CommandGoalCheck(), OUTCOME, "exit 0"),
                new ContinuationLeash(0), dir, request -> {
                    try {
                        Thread.sleep(120);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                    }
                    return true;
                }, null));
        RunEvent.GoalCheck check = checks(events).get(0);
        assertNotNull(check.gateWaitMs(), "the wait on a person was not recorded");
        assertTrue(check.gateWaitMs() >= 100, "gate wait " + check.gateWaitMs());
        assertTrue(check.durationMs() < 100,
                "the operator's 120 ms is inside the check's own duration: " + check.durationMs());
    }

    @Test
    void aGoalAddsNoToolToTheBelt() {
        // Criterion 5, stated where it can actually be measured: the belt the
        // model is advertised is the same with a goal and without one.
        Recording withGoal = new Recording(alwaysJustAnswers());
        run(agent(withGoal, goal(new ScriptedCheck(met()), OUTCOME, "node --test"), null));
        Recording without = new Recording(alwaysJustAnswers());
        run(agent(without, null, null));
        assertEquals(without.requests.get(0).tools().stream().map(LlmProvider.ToolSpec::name)
                        .toList(),
                withGoal.requests.get(0).tools().stream().map(LlmProvider.ToolSpec::name).toList());
    }

    // ── criterion 4: a verdict is never a claim ───────────────────────────

    @Test
    void everyVerdictLineCarriesWhatProducedItAndNoBannedWord() {
        for (GoalVerdict scripted : List.of(met(), failed("red"), untested())) {
            List<RunEvent> events = run(agent(new Recording(alwaysJustAnswers()),
                    goal(new ScriptedCheck(scripted), OUTCOME, "node --test"), null));
            RunEvent.GoalCheck line = checks(events).get(0);
            assertEquals(scripted.outcome().wireName(), line.outcome());
            assertNotNull(line.evidence());
            String said = line.evidence().toLowerCase(java.util.Locale.ROOT);
            for (String banned : List.of("should work", "probably", "looks correct")) {
                assertFalse(said.contains(banned), line.evidence());
            }
            if (scripted.outcome() != GoalVerdict.Outcome.UNTESTED) {
                assertNotNull(line.exitCode(), "a command verdict without its exit code");
                assertNotNull(line.command());
            }
        }
    }

    @Test
    void anAbortedRunIsNeverGraded() {
        // Running the operator's command after they stopped the run is the
        // harness acting past a stop.
        CancelSignal signal = new CancelSignal();
        ScriptedCheck check = new ScriptedCheck(met());
        List<RunEvent> events = new ArrayList<>();
        LlmProvider provider = request -> {
            signal.cancel();
            return List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.ABORTED));
        };
        try (EventStream stream = agent(new Recording(provider),
                goal(check, OUTCOME, "node --test"), new ContinuationLeash(3))
                .run("do it", new RunOptions(signal, null))) {
            stream.forEach(events::add);
        }
        assertEquals(0, check.runs.get(), "the check ran on a cancelled run");
        assertNull(events.stream().filter(RunEvent.GoalCheck.class::isInstance).findFirst()
                .orElse(null));
    }

    /** The text of the LAST user message of a request — where the harness's own
     *  continuation lands. */
    private static String lastUserText(LlmProvider.ProviderRequest request) {
        StringBuilder out = new StringBuilder();
        request.messages().stream()
                .filter(message -> message.role() == LlmProvider.ProviderMessage.Role.USER)
                .reduce((first, second) -> second)
                .ifPresent(message -> message.content().forEach(part -> {
                    if (part instanceof LlmProvider.TextContent text) {
                        out.append(text.text()).append('\n');
                    }
                }));
        return out.toString();
    }

    // ── the review pass: three decisions that were pinned by nothing ──────

    @Test
    void aGoalReplacedMidRunSteersTheVeryNextTurn() {
        // The reason SessionGoal is mutable and volatile, and the reason the
        // loop reads it INSIDE the turn loop rather than once before it. The
        // review hoisted that read out of the loop and every test of this card
        // stayed green — so the two long javadocs that justify the per-turn read
        // were the only thing holding it, and a javadoc is not a gate.
        //
        // The browser face is the case: buildAgentOnce returns the SAME agent
        // for every prompt of a session, so an operator who states or edits a
        // goal has to be obeyed without a reconnect.
        final SessionGoal session = goal(new ScriptedCheck(met()), OUTCOME, "node --test");
        final String replaced = "Only the refresh-token case matters now.";
        AtomicInteger turn = new AtomicInteger();
        Recording provider = new Recording(request -> {
            if (turn.incrementAndGet() == 1) {
                session.state(new RunGoal(replaced, "node --test"));
                return List.of(new LlmProvider.PToolCall("c1", "always_works",
                                JSON.createObjectNode()),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
            }
            return answerTurn();
        });
        run(agent(provider, session, new ContinuationLeash(0)));

        assertTrue(provider.requests.size() >= 2, "needs a second turn to be a test at all");
        assertTrue(provider.requests.get(0).system().contains(OUTCOME),
                "the first turn should still carry what was stated when it started");
        String last = provider.requests.get(provider.requests.size() - 1).system();
        assertTrue(last.contains(replaced), "the replaced goal never reached a turn: " + last);
        assertFalse(last.contains(OUTCOME),
                "the withdrawn goal is still steering the model: " + last);
    }

    @Test
    void theCheckPrintedOutputRidesOnTheEventAndNotOnlyOnTheGuidance() {
        // Half of criterion 4's "a verdict is never a claim": the exit code says
        // no, and the output says WHAT said no. The review dropped output() from
        // the emission and all 1739 core tests stayed green, so the wire field
        // was carrying evidence nobody had ever read back.
        List<RunEvent> events = run(agent(new Recording(alwaysJustAnswers()),
                goal(new ScriptedCheck(failed("not ok 3 - refresh token expired early")),
                        OUTCOME, "node --test"),
                new ContinuationLeash(0)));
        assertEquals(1, checks(events).size());
        assertEquals("not ok 3 - refresh token expired early", checks(events).get(0).output(),
                "the goal_check line has to carry what the check printed");
    }

    @Test
    void aRunTheGuardEndedIsNotGradedAndSaysSoByItsStopReason() {
        // DECIDED, not left ambiguous. Card 262's guard END is a PERSON saying
        // stop — the operator answered "end the run" to a question. Grading it
        // would run their check, which on a real goal is a whole test suite,
        // after they asked for the run to be over; that is the same reason the
        // cancel branch at the terminal exit refuses. The ceiling exits are the
        // opposite case and ARE graded: nobody was asked there.
        //
        // Pinned in the direction of the refusal, so a later refactor that adds
        // grading here has to come and delete this test on purpose.
        ProgressGuard guard = new ProgressGuard(new ProgressSettings(0, 0, 1),
                question -> new Asker.Answer(List.of(ProgressGuard.END_LABEL)));
        LlmProvider plansThenSitsStill = request -> {
            var steps = JSON.createArrayNode();
            steps.addObject().put("text", "step 1").put("status", "pending");
            steps.addObject().put("text", "step 2").put("status", "pending");
            return List.of(new LlmProvider.PToolCall("p1", "update_plan",
                            JSON.createObjectNode().set("steps", steps)),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
        };
        ScriptedCheck check = new ScriptedCheck(met());
        List<RunEvent> events = run(new Agent(AgentOptions.builder()
                .provider(plansThenSitsStill)
                .systemPrompt(SYSTEM)
                .registry(registryWithWorks())
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .goal(goal(check, OUTCOME, "node --test"))
                .progressGuard(guard)
                .continuationLeash(new ContinuationLeash(3))
                .maxTurns(6)
                .build()));

        assertEquals(ProgressGuard.STOP_REASON, lastStopReason(events));
        assertEquals(0, check.runs.get(),
                "the operator ended the run and the harness ran their test suite anyway");
        assertEquals(List.of(), checks(events),
                "a run nobody graded must not carry a goal_check line");
    }

    @Test
    void theContextGaugeCountsTheGoalItIsCarrying() {
        // Non-functional criterion 2, the half that is a defect rather than a
        // measurement: context_info is the estimate the browser's ring and the
        // CLI's meter read, and it summed options.systemPrompt() only. A run
        // with a goal was therefore under-reporting its own system prompt by
        // exactly the section this card adds, every turn.
        SessionGoal session = goal(new ScriptedCheck(met()), OUTCOME, "node --test");
        List<RunEvent> withGoal = run(introspecting(session));
        List<RunEvent> without = run(introspecting(null));

        int stated = systemChars(withGoal);
        int bare = systemChars(without);
        assertEquals(SYSTEM.length(), bare, "the no-goal reading is the plain system prompt");
        assertEquals(SYSTEM.length() + session.stated().promptSection().length(), stated,
                "the gauge has to count the bytes that actually ride to the provider");
    }

    /** An agent with the context gauge switched on — the only way a run emits
     *  the context_info line this reads.
     *  @param session the goal to carry, or null
     *  @return the agent */
    private static Agent introspecting(SessionGoal session) {
        return new Agent(AgentOptions.builder()
                .provider(alwaysJustAnswers())
                .systemPrompt(SYSTEM)
                .registry(registryWithWorks())
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .introspection(true)
                .goal(session)
                .build());
    }

    /** The "system prompt" slice of the first context_info line of a run.
     *  @param events the run's events
     *  @return the char count that slice reported */
    private static int systemChars(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.ContextInfo.class::isInstance)
                .map(RunEvent.ContextInfo.class::cast)
                .findFirst()
                .orElseThrow()
                .parts().stream()
                .filter(part -> part.label().equals("system prompt"))
                .findFirst()
                .orElseThrow()
                .chars();
    }
}
