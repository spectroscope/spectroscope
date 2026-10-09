package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 364, criterion 1, for the three unattended faces: {@code spectro run},
 * a cron fire and a fleet node.
 *
 * <p>All three build their agent in {@code HeadlessRunner}, and until this card
 * none of them passed the operator's {@code maxTurns} — the key had a settings
 * control, a documentation row, a {@code ReachBlock} and a drift test, and
 * {@code AgentOptions.Builder.maxTurns} had exactly ONE caller in the whole
 * repository: the browser session. An operator who lowered the ceiling to keep
 * a cron job cheap changed nothing and got no signal at all.</p>
 *
 * <p>The ceiling is set to <b>3</b> here and each face is run separately rather
 * than once through the shared method, because "they all go through
 * {@code runOnce}" is exactly the kind of claim that is true right up until one
 * of them grows its own builder. {@code runJob} is the cron scheduler's whole
 * entry point and {@code withBroker} is what a fleet node adds, so each test
 * enters where its own caller does.</p>
 *
 * <p>The completion budget rides along in the last test. It is not a ceiling
 * anybody can watch fire, so it is read where it lands: off the
 * {@link LlmProvider.ProviderRequest} the run actually sends.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class HeadlessRunnerReachTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The operator's own path to the number: a settings file in the launch
     *  directory, which outranks the user scope — so this reads the same on a
     *  machine whose owner has a {@code maxTurns} of their own. */
    private static SpectroConfig configuredWith(Path dir, String json) throws IOException {
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), json);
        return SpectroConfig.load(SpectroConfig.Overrides.none(), dir);
    }

    /** A provider that never finishes: every turn asks for one more tool call.
     *  Only a ceiling can end a run against it. */
    private static LlmProvider relentless(List<Integer> budgets) {
        return request -> {
            budgets.add(request.maxTokens());
            if (request.signal() != null && request.signal().isCancelled()) {
                return List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.ABORTED));
            }
            return List.of(
                    new LlmProvider.PToolCall("c" + budgets.size(), "list_dir",
                            JSON.createObjectNode().put("path", ".")),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
        };
    }

    @Test
    void aSpectroRunStopsAtTheConfiguredCeiling(@TempDir Path dir, @TempDir Path cwd)
            throws IOException {
        SpectroConfig config = configuredWith(dir, "{ \"maxTurns\": 3 }");
        AtomicInteger turns = new AtomicInteger();

        HeadlessRunner.Outcome outcome =
                new HeadlessRunner(JSON, config, relentless(new ArrayList<>()))
                        // null: `spectro run` WITHOUT --max-turns. The caller sets
                        // no ceiling of its own, which used to mean the hardcoded
                        // default and now means the operator's number.
                        .runOnce("Loop forever", cwd, false, null, event -> {
                            if (event instanceof RunEvent.TurnStart) {
                                turns.incrementAndGet();
                            }
                        }, line -> { });

        assertEquals(3, turns.get(),
                "`spectro run` ignored the configured turn ceiling and ran on"
                        + " Agent.DEFAULT_MAX_TURNS — the settings page's number was true of"
                        + " the browser session and of nothing else");
        assertEquals("max_turns", outcome.stopReason());
        assertFalse(outcome.exitOk());
    }

    @Test
    void aCronFireStopsAtTheConfiguredCeiling(@TempDir Path dir, @TempDir Path cwd)
            throws IOException {
        SpectroConfig config = configuredWith(dir, "{ \"maxTurns\": 3 }");
        List<Integer> budgets = new ArrayList<>();
        Job job = new Job("card-364-reach", "* * * * *", "Loop forever", cwd.toString(),
                Job.READONLY);

        RecordingNotifier notes = new RecordingNotifier();
        JobState state = new HeadlessRunner(JSON, config, relentless(budgets))
                .withNotifier(notes)
                .runJob(job, line -> { });

        // One provider call per turn, so the request count IS the turn count —
        // and it is the count the CRON entry point produced, not runOnce's.
        assertEquals(3, budgets.size(),
                "a cron fire ignored the configured turn ceiling; an operator lowering it"
                        + " to keep a nightly job cheap changed nothing and was told nothing");
        assertEquals("max_turns", state.stopReason());
        assertEquals(JobState.FAILED, state.status());
        // Card 476: this is the job whose banner reached the owner's screen on
        // every suite run. It is announced to the recording notifier instead.
        assertEquals(List.of(new RecordingNotifier.Shown("spectroscope: card-364-reach failed",
                        "max_turns")), notes.shown());
    }

    @Test
    void aFleetNodeStopsAtTheConfiguredCeiling(@TempDir Path dir, @TempDir Path cwd)
            throws IOException {
        SpectroConfig config = configuredWith(dir, "{ \"maxTurns\": 3 }");
        AtomicInteger turns = new AtomicInteger();

        // What NodeCommand and TriggeredNode add: their own identity and their
        // own broker. Both pass spec.maxTurns(), which is null unless the node
        // was started with --max-turns.
        HeadlessRunner.Outcome outcome =
                new HeadlessRunner(JSON, config, relentless(new ArrayList<>()))
                        .withIdentity("node-a")
                        .withBroker(request -> true)
                        .runOnce("Loop forever", cwd, false, null, event -> {
                            if (event instanceof RunEvent.TurnStart) {
                                turns.incrementAndGet();
                            }
                        }, line -> { });

        assertEquals(3, turns.get(),
                "a fleet node ignored the configured turn ceiling");
        assertEquals("max_turns", outcome.stopReason());
    }

    @Test
    void theCallersOwnCeilingStillCutsARunShorterThanTheSetting(@TempDir Path dir,
            @TempDir Path cwd) throws IOException {
        // The other half of the reconciliation, and the reason `--max-turns` is
        // NOT folded into the agent's own ceiling: card 264 pinned that the
        // caller's brake fires from the OUTSIDE, on the turn after its limit,
        // and that the wire and the Outcome agree about why. Wiring the setting
        // in must not quietly change that.
        //
        // The third turn PARKS until the brake fires, for the reason
        // HeadlessRunnerTest's own brake test parks: against an instant
        // provider the loop finishes all of its OWN turns before the consumer
        // has read the third turn_start, the outside brake never lands, and the
        // run ends on the ceiling instead — measured here first, at 9 turns
        // against a caller asking for 2.
        SpectroConfig config = configuredWith(dir, "{ \"maxTurns\": 9 }");
        AtomicInteger turns = new AtomicInteger();
        LlmProvider brakeable = request -> {
            if (request.messages().size() >= 5) { // the third turn
                for (int spin = 0; spin < 3_000 && !request.signal().isCancelled(); spin++) {
                    try {
                        Thread.sleep(5);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
                return List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.ABORTED));
            }
            return List.of(
                    new LlmProvider.PToolCall("c" + request.messages().size(), "list_dir",
                            JSON.createObjectNode().put("path", ".")),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
        };

        HeadlessRunner.Outcome outcome =
                new HeadlessRunner(JSON, config, brakeable)
                        .runOnce("Loop forever", cwd, false, 2, event -> {
                            if (event instanceof RunEvent.TurnStart) {
                                turns.incrementAndGet();
                            }
                        }, line -> { });

        assertEquals(3, turns.get(),
                "the caller's own --max-turns 2 no longer brakes on the turn after its"
                        + " limit — the outer brake and the configured ceiling are two"
                        + " different mechanisms and only one of them moved in card 364");
        assertEquals("max_turns", outcome.stopReason());
    }

    @Test
    void theConfiguredCompletionBudgetReachesTheProviderCall(@TempDir Path dir,
            @TempDir Path cwd) throws IOException {
        // Card 364, criterion 2. AgentOptions.Builder.maxTokens was public,
        // documented and called ZERO times in every main source of every
        // module, so every shipped run spent Agent.DEFAULT_MAX_TOKENS and no
        // operator could move it. There is nothing to watch stop, so the
        // arrival is read where the number is spent: on the request itself.
        SpectroConfig config = configuredWith(dir,
                "{ \"maxTurns\": 2, \"maxTokens\": 4321 }");
        List<Integer> budgets = new ArrayList<>();

        new HeadlessRunner(JSON, config, relentless(budgets))
                .runOnce("Loop forever", cwd, false, null, null, line -> { });

        assertFalse(budgets.isEmpty(), "the provider was never called");
        assertEquals(List.of(4321, 4321), budgets,
                "an unattended run spent a budget nobody typed. Every provider call of the"
                        + " run carries it, not just the first — a per-turn read is what a"
                        + " compaction summary and a retried turn go through too");
    }

    @Test
    void theConfiguredShellBudgetReachesAnUnattendedRunsShell(@TempDir Path dir,
            @TempDir Path cwd) throws IOException {
        // Card 370, criterion 1, for these same three faces and the other road
        // into a run. The tool belt is assembled one line under the registry in
        // runOnce, and it took no argument at all until this card: an operator
        // who raised the budget so a nightly build could finish watched it go on
        // dying at ten, and the error said ten.
        //
        // Read off the tool RESULT rather than off the belt, because a budget
        // that is announced and not enforced is the half of criterion 1 a
        // description cannot show.
        SpectroConfig config = configuredWith(dir,
                "{ \"maxTurns\": 2, \"commandTimeoutSeconds\": 1 }");
        List<String> outputs = new ArrayList<>();
        LlmProvider oneSlowCommand = request -> {
            if (request.messages().size() >= 3) {
                return List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
            }
            return List.of(
                    new LlmProvider.PToolCall("c370", "run_command",
                            JSON.createObjectNode().put("command", "sleep 5")),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
        };

        new HeadlessRunner(JSON, config, oneSlowCommand)
                // autoApprove: the unattended policy, which is what makes the
                // shell reachable without anybody at a keyboard.
                .runOnce("Run one slow command", cwd, true, null, event -> {
                    if (event instanceof RunEvent.ToolResult result) {
                        outputs.add(result.output());
                    }
                }, line -> { });

        assertFalse(outputs.isEmpty(), "the shell tool was never driven at all");
        assertTrue(outputs.stream().anyMatch(out -> out.contains("timed out after 1 s")),
                "an unattended run killed its command on a budget nobody typed. The"
                        + " operator's number reached the config, the settings page and the"
                        + " reference row, and stopped one seam short of the shell: "
                        + outputs);
    }
}
