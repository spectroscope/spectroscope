package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.tools.UpdatePlanTool;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 264, at the loop's terminal exit: the reproduction was the owner's own
 * session — a test written, a test run, then nothing, with four plan steps open
 * and the app saying ready. The loop had every signal it needed and drew no
 * conclusion, because nothing on that path ever read the plan.
 *
 * <p>Everything here runs against a scripted provider and the real
 * {@link UpdatePlanTool}, so the ledger is written the way a live model writes
 * it: through the tool, onto the wire, and past the loop.</p>
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AgentPlanVerdictTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Pops one scripted turn per stream() call; an empty script is a test bug. */
    private static final class ScriptedProvider implements LlmProvider {
        private final Deque<List<ProviderEvent>> turns = new ArrayDeque<>();

        @SafeVarargs
        static ScriptedProvider of(List<ProviderEvent>... scripted) {
            ScriptedProvider provider = new ScriptedProvider();
            List.of(scripted).forEach(provider.turns::add);
            return provider;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (request.signal().isCancelled()) {
                return List.of(new PStop(PStop.StopReason.ABORTED));
            }
            if (turns.isEmpty()) {
                throw new IllegalStateException("provider asked for more turns than scripted");
            }
            return turns.poll();
        }
    }

    /** Emits a plan for SOMEBODY ELSE — a child agent's ledger, on the parent's sink. */
    private static final class ForeignPlanTool implements Tool {
        public String name() { return "foreign_plan"; }
        public String description() { return "publishes a child's plan"; }
        public JsonNode inputSchema() { return JSON.createObjectNode(); }
        public boolean needsPermission() { return false; }

        public String execute(JsonNode input, ToolContext context) {
            context.emit().accept(new RunEvent.Plan("child-1",
                    List.of(new RunEvent.PlanStep("the child's own step", "pending")),
                    System.currentTimeMillis()));
            return "ok";
        }
    }

    private static Agent agent(LlmProvider provider, Tool extra) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(new UpdatePlanTool());
        if (extra != null) {
            registry.register(extra);
        }
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
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

    /** The update_plan call a model makes, with the statuses spelled out. */
    private static LlmProvider.PToolCall planCall(String callId, String... statuses) {
        var steps = JSON.createArrayNode();
        for (int i = 0; i < statuses.length; i++) {
            steps.addObject().put("text", "step " + (i + 1)).put("status", statuses[i]);
        }
        return new LlmProvider.PToolCall(callId, "update_plan",
                JSON.createObjectNode().set("steps", steps));
    }

    private static List<LlmProvider.ProviderEvent> callTurn(LlmProvider.PToolCall call) {
        return List.of(call, new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    private static List<LlmProvider.ProviderEvent> answerTurn() {
        return List.of(new LlmProvider.PTextDelta("All set."),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    // ── the reproduction ───────────────────────────────────────────────────

    @Test
    void aRunThatStopsWithStepsOpenSaysUnfinished() {
        List<RunEvent> events = run(agent(ScriptedProvider.of(
                callTurn(planCall("c1", "completed", "completed", "in_progress", "pending", "pending", "pending")),
                answerTurn()), null));

        assertEquals("unfinished", lastStopReason(events),
                "four of six steps were open when the model answered and quit");
        assertTrue(events.stream().anyMatch(RunEvent.Plan.class::isInstance),
                "the ledger the verdict read is on the wire, where every surface can count it");
    }

    @Test
    void aRunThatFinishedItsPlanKeepsEndTurn() {
        List<RunEvent> events = run(agent(ScriptedProvider.of(
                callTurn(planCall("c1", "completed", "completed")),
                answerTurn()), null));

        assertEquals("end_turn", lastStopReason(events));
    }

    @Test
    void aRunWithNoPlanAtAllStillEndsAsItAlwaysDid() {
        // The verdict is UNKNOWN, and the wire keeps end_turn: the absence of a
        // plan event is already the fact, and inventing a fifth value for the
        // most common run in the product would rewrite every old reader's
        // normal case. The web says "no plan on record" from the same absence.
        List<RunEvent> events = run(agent(ScriptedProvider.of(answerTurn()), null));

        assertEquals("end_turn", lastStopReason(events));
        assertFalse(events.stream().anyMatch(RunEvent.Plan.class::isInstance));
    }

    @Test
    void theLedgerIsLatestWinsJustLikeThePlanPanel() {
        List<RunEvent> events = run(agent(ScriptedProvider.of(
                callTurn(planCall("c1", "pending", "pending")),
                callTurn(planCall("c2", "completed", "completed")),
                answerTurn()), null));

        assertEquals("end_turn", lastStopReason(events),
                "the model closed its steps before answering — the last plan is the plan");
    }

    @Test
    void anOpenPlanFromAnEarlierRunStillCountsInTheNextOne() {
        // The ledger lives with the agent, exactly like the provider history and
        // exactly like the reducer's plan snapshot (latest-wins, cleared only by
        // a new chat). A second run that answers without touching the plan has
        // not closed anything.
        Agent agent = agent(ScriptedProvider.of(
                callTurn(planCall("c1", "pending", "pending")),
                answerTurn(),
                answerTurn()), null);

        assertEquals("unfinished", lastStopReason(run(agent)));
        assertEquals("unfinished", lastStopReason(run(agent)));
    }

    @Test
    void aChildsPlanNeverGradesTheParentsRun() {
        // update_plan is main-only on purpose (SessionConnection:1056), but a
        // child's events do travel the parent's sink, and a run must be graded
        // by its own ledger.
        List<RunEvent> events = run(agent(ScriptedProvider.of(
                callTurn(new LlmProvider.PToolCall("c1", "foreign_plan", JSON.createObjectNode())),
                answerTurn()), new ForeignPlanTool()));

        assertEquals("end_turn", lastStopReason(events));
    }

    // ── the exits the verdict must NOT touch ───────────────────────────────

    @Test
    @Timeout(value = 10, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
    void anAbortKeepsSayingAbortedEvenWithStepsOpen() {
        CancelSignal signal = new CancelSignal();
        // Turn 1 writes the open plan; turn 2 parks until the consumer presses
        // stop, so the abort cannot race past the exit under test.
        LlmProvider parkingAfterThePlan = request -> {
            if (request.messages().size() <= 1) {
                return callTurn(planCall("c1", "pending", "pending"));
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
        Agent agent = agent(parkingAfterThePlan, null);
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("do it", new RunOptions(signal, null))) {
            for (RunEvent event : stream) {
                events.add(event);
                if (event instanceof RunEvent.Plan) {
                    signal.cancel(); // stop pressed while the plan is open
                }
            }
        }
        assertEquals("aborted", lastStopReason(events),
                "how it stopped is the more urgent fact, and the verdict must not eat it");
    }

    // ── the exit STATES the verdict, and that is pinned (fix pass) ──────────

    /**
     * The verdict of a run whose plan is missing or complete cannot ride the
     * wire — both keep {@code end_turn} on purpose — so the loop says it in its
     * own log, and until this test the whole "says which of three" of AC 1 was
     * an unpinned format string: deleting it left every targeted test green.
     * Records are captured in memory, the way {@code LoggedTest} does it.
     */
    @Test
    void theExitSaysWhichOfTheThreeVerdictsTheRunReached() {
        assertEquals("plan verdict unfinished (1 of 2 steps open)",
                verdictLineOf(ScriptedProvider.of(callTurn(planCall("c1", "completed", "pending")), answerTurn())));
        assertEquals("plan verdict finished (all 2 steps completed)",
                verdictLineOf(ScriptedProvider.of(callTurn(planCall("c1", "completed", "completed")), answerTurn())));
        // The house backend's case: end_turn on the wire either way, and the log
        // is the only place the difference is stated.
        assertEquals("plan verdict unknown (no plan on record)",
                verdictLineOf(ScriptedProvider.of(answerTurn())));
    }

    /** Runs one scripted agent with an in-memory appender on the loop's logger.
     *  @param provider the scripted turns
     *  @return the single {@code plan verdict …} line the exit stated */
    private static String verdictLineOf(LlmProvider provider) {
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(Agent.class);
        ch.qos.logback.classic.Level before = logger.getLevel();
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> records =
                new ch.qos.logback.core.read.ListAppender<>();
        records.start();
        logger.setLevel(ch.qos.logback.classic.Level.INFO);
        logger.addAppender(records);
        try {
            run(agent(provider, null));
            List<String> verdicts = records.list.stream()
                    .map(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage)
                    .filter(line -> line.startsWith("plan verdict "))
                    .toList();
            assertEquals(1, verdicts.size(), "exactly one verdict per run, got " + verdicts);
            return verdicts.getFirst();
        } finally {
            logger.detachAppender(records);
            logger.setLevel(before);
        }
    }

    @Test
    void theTurnBrakeKeepsSayingMaxTurnsEvenWithStepsOpen() {
        // Whether a braked run counts as completed is the owner's open call on
        // card 264; what it must not do is lose the reason it braked.
        LlmProvider relentless = request -> {
            if (request.messages().size() <= 1) {
                return callTurn(planCall("c1", "pending", "pending"));
            }
            return List.of(new LlmProvider.PToolCall("c" + request.messages().size(),
                            "update_plan", planCall("cx", "pending", "pending").input()),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
        };

        assertEquals("max_turns", lastStopReason(run(agent(relentless, null))));
    }
}
