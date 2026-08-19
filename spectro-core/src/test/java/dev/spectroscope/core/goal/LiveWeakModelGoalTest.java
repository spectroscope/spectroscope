package dev.spectroscope.core.goal;

import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.loop.ContinuationLeash;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.OpenAiCompatProvider;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.tools.UpdatePlanTool;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 267 criterion 8, on the model the card names.
 *
 * <p><b>Off in the gate, on by hand.</b> It needs LM Studio on the tailnet and a
 * {@code node} on PATH, so it runs only under {@code SPECTRO_LIVE=1}. The
 * command that produced the numbers in the card's BUILT entry is:</p>
 *
 * <pre>
 * SPECTRO_LIVE=1 SPECTRO_LIVE_BASE=http://&lt;lm-studio-host&gt;:1234/v1 \
 *   SPECTRO_LIVE_MODEL=deepseek-v4-flash-0731@iq1_m \
 *   ./gradlew :spectro-core:test --rerun-tasks --no-build-cache \
 *   --tests 'dev.spectroscope.core.goal.LiveWeakModelGoalTest' -i
 * </pre>
 *
 * <p><b>Three scenarios, three methods, three derived budgets.</b> They were one
 * method under a literal 900 s, and the review's re-run died on that timeout
 * inside the third scenario — so the two numbers the card publishes (the three
 * verdicts and the disagreement rate) were not reproducible by the command the
 * card publishes. Each scenario now carries {@link #SCENARIO_SECONDS}, derived
 * from the turns and checks the run may actually spend, and the rate is printed
 * from {@code @AfterAll} over whatever ran.</p>
 *
 * <p>The host is a PARAMETER and has no default on purpose: this repository is
 * public, and {@code NoOperatorAddressesInTheRepoTest} is the guard that says
 * so. It caught the first draft of this file, which had the tailnet address
 * baked in twice.</p>
 *
 * <p><b>Why this test is the whole argument for placement (a).</b> LM Studio
 * reports {@code trained_for_tool_use: false} for this model. It therefore does
 * not reliably call anything, and a mechanic that depended on it calling
 * something — a "the goal is done" tool, a plan it keeps honest — would be
 * missing exactly where it is needed. An exit code does not need the model's
 * cooperation.</p>
 *
 * <p>The evaluator is measured ALONGSIDE rather than instead: the check that
 * decides is the command's, and the same transcript is handed to the model judge
 * in the same breath, so the two verdicts are about identical evidence and the
 * disagreement rate is a real number rather than two runs compared by eye.</p>
 */
@EnabledIfEnvironmentVariable(named = "SPECTRO_LIVE", matches = "1")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class LiveWeakModelGoalTest {

    /** The run's own ceilings, named here because the timeout below is DERIVED
     *  from them. The first version of this class wrapped all three scenarios in
     *  one method under a literal 900 s, and the review's re-run died on that
     *  timeout inside the third one — so the command the card publishes did not
     *  produce the number the card publishes. A budget that is not derived from
     *  what the run can cost is a coin toss. */
    private static final int MAX_TURNS = 8;

    /** The continuation budget one scenario runs with. */
    private static final int CONTINUATIONS = 2;

    /** The wall-clock budget for ONE check of one scenario. */
    private static final int CHECK_SECONDS = 120;

    /** One scenario's ceiling: every turn it may take, at a minute of exchange
     *  each on a slow local model, plus a full check at every would-be ending. */
    private static final long SCENARIO_SECONDS =
            (MAX_TURNS + CONTINUATIONS) * 60L + (CONTINUATIONS + 1L) * CHECK_SECONDS;

    /** Every (command, evaluator) pair of every scenario in this class, so the
     *  disagreement rate criterion 8 asks for is one number over all of them and
     *  survives the scenarios being separate methods. */
    private static final List<String[]> PAIRS =
            java.util.Collections.synchronizedList(new ArrayList<>());

    /** No default: see the class javadoc. An unset variable simply fails the
     *  run with a readable message rather than hiding somebody's LAN in a
     *  public repository. */
    private static final String BASE = System.getenv("SPECTRO_LIVE_BASE");

    private static final String MODEL = System.getenv().getOrDefault(
            "SPECTRO_LIVE_MODEL", "deepseek-v4-flash-0731@iq1_m");

    private static final String FAILING_TEST =
            "const t = require('node:test');\n"
                    + "const a = require('node:assert');\n"
                    + "t.test('the sum', () => { a.strictEqual(add(1, 1), 2); });\n"
                    + "function add(x, y) { return x - y; }\n";

    private static final String PASSING_TEST =
            "const t = require('node:test');\n"
                    + "const a = require('node:assert');\n"
                    + "t.test('the sum', () => { a.strictEqual(add(1, 1), 2); });\n"
                    + "function add(x, y) { return x + y; }\n";

    /** Runs the shipped command check AND the evaluator on the same evidence,
     *  returns the command's verdict (which is what decides), and keeps the pair
     *  so the disagreement rate is measured rather than estimated. */
    private static final class BothChecks implements GoalCheck {
        private final GoalCheck command;
        private final GoalCheck evaluator;
        final List<String[]> pairs = new ArrayList<>();

        BothChecks(GoalCheck command, GoalCheck evaluator) {
            this.command = command;
            this.evaluator = evaluator;
        }

        @Override public GoalVerdict run(RunGoal goal, Context context) {
            GoalVerdict byCommand = command.run(goal, context);
            GoalVerdict byModel = evaluator.run(goal, context);
            String[] pair = {byCommand.outcome().wireName(), byModel.outcome().wireName(),
                String.valueOf(byCommand.exitCode()), byModel.output()};
            pairs.add(pair);
            PAIRS.add(pair);
            return byCommand;
        }
    }

    private static LlmProvider provider() {
        assertNotNull(BASE, "set SPECTRO_LIVE_BASE to your own LM Studio endpoint");
        return new OpenAiCompatProvider(new OpenAiCompatProvider.Options(BASE, MODEL, null));
    }

    private static List<RunEvent> drive(Path workspace, String body, BothChecks checks,
                                        String prompt) throws Exception {
        return drive(workspace, body, checks, prompt, "The tests in sum.test.js pass.",
                "node --test sum.test.js");
    }

    private static List<RunEvent> drive(Path workspace, String body, BothChecks checks,
                                        String prompt, String outcome, String command)
            throws Exception {
        Files.writeString(workspace.resolve("sum.test.js"), body);
        SessionGoal goal = new SessionGoal(checks);
        goal.state(new RunGoal(outcome, command));
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        registry.register(new UpdatePlanTool());
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider())
                .systemPrompt("You are spectroscope, a coding agent in the terminal."
                        + " Working directory: " + workspace)
                .registry(registry)
                .cwd(workspace)
                .agentId("main")
                .onPermission(request -> true)
                .providerName("openai")
                .goal(goal)
                .continuationLeash(new ContinuationLeash(2))
                .maxTurns(8)
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run(prompt, new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static List<RunEvent.GoalCheck> checks(List<RunEvent> events) {
        return events.stream().filter(RunEvent.GoalCheck.class::isInstance)
                .map(RunEvent.GoalCheck.class::cast).toList();
    }

    private static String stopReason(List<RunEvent> events) {
        return events.stream().filter(RunEvent.RunEnd.class::isInstance)
                .map(RunEvent.RunEnd.class::cast).reduce((a, b) -> b).orElseThrow().stopReason();
    }

    private static BothChecks bothChecks() {
        return new BothChecks(new CommandGoalCheck(CHECK_SECONDS),
                new EvaluatorGoalCheck(provider(), MODEL));
    }

    @Test
    @Order(1)
    @Timeout(value = SCENARIO_SECONDS, unit = TimeUnit.SECONDS,
            threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
    void anUnreachableCheckIsNeverReportedMet(@TempDir Path workspace) throws Exception {
        // The honest failure. The check is a real command with a real exit code
        // that this run genuinely cannot turn green: the path is inside macOS's
        // system-integrity-protected /usr/lib, which not even root may write.
        // Asking a weak model to "please fail" does not work — it was tried, and
        // it repaired the file anyway after the harness handed it the failing
        // output, which is §A1's point about prose arriving a third time. So the
        // impossibility is in the world, where the whole card says the teeth
        // belong.
        BothChecks checks = bothChecks();
        List<RunEvent> honest = drive(workspace, FAILING_TEST, checks,
                "Have a look around and tell me what you find.",
                "The marker file exists.", "test -f /usr/lib/spectroscope-267-marker");
        report("unreachable-check", honest);
        RunEvent.GoalCheck lastHonest = last(checks(honest));
        assertEquals("failed", lastHonest.outcome(), "an unreachable check came back non-failed");
        assertEquals(1, lastHonest.exitCode());
        // NOT pinned to goal_unmet. Which bound speaks first — the continuation
        // budget or the turn cap — is a property of how chatty the model feels
        // today, and the measured run went hunting for the marker with twenty
        // tool calls and hit the cap. Pinning the bound would be a test name
        // claiming more than its body can measure. What IS the property: an
        // unreachable check is never reported met, and the record says so.
        assertNotEquals(GoalVerdict.MET_STOP_REASON, stopReason(honest),
                "an unreachable check ended the run as met");
        assertTrue(honest.stream().anyMatch(RunEvent.Continuation.class::isInstance),
                "a failing check did not buy its continuation");
    }

    @Test
    @Order(2)
    @Timeout(value = SCENARIO_SECONDS, unit = TimeUnit.SECONDS,
            threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
    void aGreenSuiteEndsTheRunMetOnItsExitCode(@TempDir Path workspace) throws Exception {
        BothChecks checks = bothChecks();
        List<RunEvent> green = drive(workspace, PASSING_TEST, checks,
                "Read sum.test.js and tell me in one sentence what it does.");
        report("green", green);
        assertEquals(GoalVerdict.MET_STOP_REASON, stopReason(green));
        assertEquals(0, last(checks(green)).exitCode());
    }

    @Test
    @Order(3)
    @Timeout(value = SCENARIO_SECONDS, unit = TimeUnit.SECONDS,
            threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
    void theEndingAndTheLastCheckAreOneFactWhateverTheModelDoes(@TempDir Path workspace)
            throws Exception {
        // A red suite and a free hand. Whatever the model does, run_end and the
        // LAST check must be the same fact: criteria 3 and 7 in one assertion,
        // and the one property that holds whichever way a non-deterministic
        // model jumps.
        BothChecks checks = bothChecks();
        List<RunEvent> free = drive(workspace, FAILING_TEST, checks,
                "Have a look at sum.test.js and tell me what you make of it.");
        report("free-hand", free);
        RunEvent.GoalCheck lastFree = last(checks(free));
        assertEquals(GoalVerdict.Outcome.valueOf(
                        lastFree.outcome().toUpperCase(java.util.Locale.ROOT)).stopReason(),
                stopReason(free), "run_end disagreed with the check that produced it");
    }

    /**
     * Criterion 8's number, over every check point of every scenario above.
     *
     * <p>It PRINTS and does not assert a threshold: a threshold here would turn
     * a measurement into a wish, and this card's whole argument is that the exit
     * code decides and the opinion is reported beside it. It also survives a run
     * of one scenario — the rate is then over that scenario, and the line says
     * how many samples it stands on.</p>
     */
    @AfterAll
    static void reportTheDisagreementRate() {
        int samples = 0;
        int disagreements = 0;
        for (String[] pair : List.copyOf(PAIRS)) {
            samples++;
            if (!pair[0].equals(pair[1])) {
                disagreements++;
            }
            System.out.println("[card 267 AC 8] command=" + pair[0] + " (exit " + pair[2] + ")"
                    + "  evaluator=" + pair[1] + "  said: "
                    + pair[3].replace('\n', ' ').trim());
        }
        System.out.println("[card 267 AC 8] DISAGREEMENT " + disagreements + "/" + samples
                + " between the command check and the evaluator " + MODEL);
    }

    private static RunEvent.GoalCheck last(List<RunEvent.GoalCheck> lines) {
        assertTrue(!lines.isEmpty(), "the run never reached a verdict");
        return lines.get(lines.size() - 1);
    }

    private static void report(String label, List<RunEvent> events) {
        System.out.println("[card 267 AC 8] " + label + ": stopReason=" + stopReason(events)
                + " checks=" + checks(events).size());
        checks(events).forEach(line -> System.out.println("[card 267 AC 8]   " + line.outcome()
                + " exit=" + line.exitCode() + " · " + line.evidence()));
        events.stream().filter(RunEvent.ToolCall.class::isInstance)
                .map(RunEvent.ToolCall.class::cast)
                .forEach(call -> System.out.println("[card 267 AC 8]   called " + call.name()));
        events.stream().filter(RunEvent.Continuation.class::isInstance)
                .map(RunEvent.Continuation.class::cast)
                .forEach(held -> System.out.println("[card 267 AC 8]   " + held.decision()
                        + " — " + held.evidence()));
    }
}
