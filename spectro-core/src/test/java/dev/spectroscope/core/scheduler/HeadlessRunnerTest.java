package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The headless mechanics against a scripted provider: outcome folding, the
 * readonly policy as a constant broker, the external turn brake, and the
 * session file that every headless run leaves behind.
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS)
class HeadlessRunnerTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final SpectroConfig CONFIG = new SpectroConfig(
            "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
            java.util.List.of(), "gemini", true, java.util.List.of(), 2, true,
            java.util.List.of(), null, "info", null, null, null);

    private static final class ScriptedProvider implements LlmProvider {
        final Queue<List<ProviderEvent>> turns = new ArrayDeque<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            List<ProviderEvent> turn = turns.poll();
            if (turn == null) {
                throw new IllegalStateException("no scripted turn left");
            }
            return turn;
        }
    }

    private static HeadlessRunner runner(ScriptedProvider provider) {
        return new HeadlessRunner(JSON, CONFIG, provider);
    }

    @Test
    void aPlainAnswerYieldsExitOkAndTheFinalText(@TempDir Path cwd) {
        ScriptedProvider provider = new ScriptedProvider();
        provider.turns.add(List.of(
                new LlmProvider.PTextDelta("All logs are clean."),
                new LlmProvider.PUsage(10, 4),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));

        HeadlessRunner.Outcome outcome = runner(provider)
                .runOnce("Check logs", cwd, false, null, null, line -> { });

        assertTrue(outcome.exitOk());
        assertEquals("end_turn", outcome.stopReason());
        assertEquals("All logs are clean.", outcome.finalText());
        // Every headless run is a normal session file.
        Path sessionFile = Path.of(System.getProperty("user.home"), ".spectro", "sessions",
                outcome.sessionId() + ".jsonl");
        assertTrue(Files.exists(sessionFile), "headless runs must persist like any session");
    }

    @Test
    void readonlyDeniesGuardedToolsAndTheDecisionIsAuditable(@TempDir Path cwd) {
        ScriptedProvider provider = new ScriptedProvider();
        provider.turns.add(List.of(
                new LlmProvider.PToolCall("c1", "write_file",
                        JSON.createObjectNode().put("path", "probe.txt").put("content", "x")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        provider.turns.add(List.of(
                new LlmProvider.PTextDelta("The write was denied; nothing changed."),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));

        List<RunEvent> events = new ArrayList<>();
        HeadlessRunner.Outcome outcome = runner(provider)
                .runOnce("Write probe.txt", cwd, false, null, events::add, line -> { });

        // The run ends REGULARLY: the denial is feedback, not a failure.
        assertTrue(outcome.exitOk());
        RunEvent.PermissionDecision decision = events.stream()
                .filter(RunEvent.PermissionDecision.class::isInstance)
                .map(RunEvent.PermissionDecision.class::cast)
                .findFirst().orElseThrow();
        assertFalse(decision.allowed(), "readonly must deny");
        assertFalse(Files.exists(cwd.resolve("probe.txt")), "the file must not exist");
    }

    @Test
    void aFleetIdentityAndAnAuxiliaryPortRideTheRun(@TempDir Path cwd) {
        // The node-binary seam (additive): the run carries a fleet identity
        // instead of "main", and an extra REGISTERED port sees every event
        // next to the required JSONL sink. Identity at the source — Spectrum
        // lanes, trace filtering and JSONL agree without special-casing.
        ScriptedProvider provider = new ScriptedProvider();
        provider.turns.add(List.of(
                new LlmProvider.PTextDelta("Node answer."),
                new LlmProvider.PUsage(10, 4),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));

        List<RunEvent> published = new ArrayList<>();
        HeadlessRunner.Outcome outcome = runner(provider)
                .withIdentity("node-7")
                .withAuxiliaryPort(published::add)
                .runOnce("Check logs", cwd, false, null, null, line -> { });

        assertTrue(outcome.exitOk());
        RunEvent.RunStart start = (RunEvent.RunStart) published.get(0);
        assertEquals("node-7", start.agentId(),
                "the run opens under the node's identity, not \"main\"");
        List<RunEvent.TextDelta> deltas = published.stream()
                .filter(RunEvent.TextDelta.class::isInstance)
                .map(RunEvent.TextDelta.class::cast)
                .toList();
        assertFalse(deltas.isEmpty(), "the scripted answer streamed — the check below is not vacuous");
        assertTrue(deltas.stream().allMatch(delta -> "node-7".equals(delta.agentId())),
                "every delta carries the fleet identity");
        Path sessionFile = Path.of(System.getProperty("user.home"), ".spectro", "sessions",
                outcome.sessionId() + ".jsonl");
        assertTrue(Files.exists(sessionFile),
                "durability first: the JSONL session exists next to the auxiliary port");
    }

    @Test
    void aBrokenAuxiliaryPortNeverCostsTheRun(@TempDir Path cwd) {
        ScriptedProvider provider = new ScriptedProvider();
        provider.turns.add(List.of(
                new LlmProvider.PTextDelta("Still fine."),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));

        HeadlessRunner.Outcome outcome = runner(provider)
                .withAuxiliaryPort(event -> {
                    throw new IllegalStateException("bus on fire");
                })
                .runOnce("Check logs", cwd, false, null, null, line -> { });

        assertTrue(outcome.exitOk(),
                "a registered port is isolated — its failure never fails the run");
        assertEquals("Still fine.", outcome.finalText());
    }

    @Test
    void autoApprovesGuardedTools(@TempDir Path cwd) {
        ScriptedProvider provider = new ScriptedProvider();
        provider.turns.add(List.of(
                new LlmProvider.PToolCall("c1", "write_file",
                        JSON.createObjectNode().put("path", "note.txt").put("content", "hello")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        provider.turns.add(List.of(
                new LlmProvider.PTextDelta("Wrote the file."),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));

        HeadlessRunner.Outcome outcome = runner(provider)
                .runOnce("Write note.txt", cwd, true, null, null, line -> { });

        assertTrue(outcome.exitOk());
        assertTrue(Files.exists(cwd.resolve("note.txt")), "auto policy lets the write through");
    }

    @Test
    void theTurnBrakeCancelsFromTheOutside(@TempDir Path cwd) {
        // A provider that would loop forever: every turn wants another tool.
        LlmProvider relentless = request -> {
            if (request.signal() != null && request.signal().isCancelled()) {
                return List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.ABORTED));
            }
            return List.of(
                    new LlmProvider.PToolCall("c" + System.nanoTime(), "list_dir",
                            JSON.createObjectNode().put("path", ".")),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
        };

        HeadlessRunner.Outcome outcome = new HeadlessRunner(JSON, CONFIG, relentless)
                .runOnce("Loop forever", cwd, false, 2, null, line -> { });

        assertFalse(outcome.exitOk());
        assertEquals("max_turns", outcome.stopReason());
    }

    @Test
    void anInjectedCancelSignalAbortsARunningTurnFromTheOutside(@TempDir Path cwd) throws Exception {
        // The seam block 2 leans on: a fleet node injects its own CancelSignal
        // so a hub ctl{stop} can end a RUNNING turn. The provider parks in its
        // stream until the signal fires from another thread, then yields
        // nothing — the run loop's post-stream check turns that into "aborted".
        CancelSignal signal = new CancelSignal();
        CountDownLatch reachedProvider = new CountDownLatch(1);
        LlmProvider parking = request -> {
            reachedProvider.countDown();
            while (!request.signal().isCancelled()) {
                try {
                    Thread.sleep(10);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            return List.of(); // the cancelled loop aborts without more events
        };

        HeadlessRunner runner = new HeadlessRunner(JSON, CONFIG, parking).withCancelSignal(signal);
        AtomicReference<HeadlessRunner.Outcome> outcome = new AtomicReference<>();
        Thread run = Thread.ofVirtual().start(() ->
                outcome.set(runner.runOnce("scan forever", cwd, false, null, null, line -> { })));

        assertTrue(reachedProvider.await(5, TimeUnit.SECONDS), "the run reached the provider mid-flight");
        signal.cancel(); // the outside brake — a ctl{stop} calls exactly this
        run.join(5_000);

        assertFalse(run.isAlive(), "the run ended promptly on cancel");
        assertFalse(outcome.get().exitOk(), "a cancelled run is not a regular end_turn");
        assertEquals("aborted", outcome.get().stopReason());
    }

    @Test
    void anInjectedButUncancelledSignalLeavesANormalRunUnchanged(@TempDir Path cwd) {
        // withCancelSignal must be inert unless something cancels it — the
        // frozen no-signal behaviour, just with the seam present.
        ScriptedProvider provider = new ScriptedProvider();
        provider.turns.add(List.of(
                new LlmProvider.PTextDelta("done"),
                new LlmProvider.PUsage(1, 1),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));

        HeadlessRunner.Outcome outcome = new HeadlessRunner(JSON, CONFIG, provider)
                .withCancelSignal(new CancelSignal())
                .runOnce("go", cwd, false, null, null, line -> { });

        assertTrue(outcome.exitOk());
        assertEquals("done", outcome.finalText());
    }

    @Test
    void runJobWritesStateAndFailsFastOnAMissingCwd() {
        ScriptedProvider provider = new ScriptedProvider(); // never called
        Job job = new Job("ghost", "* * * * *", "do it", "/definitely/not/here", null);

        JobState state = runner(provider).runJob(job, line -> { });

        assertEquals(JobState.FAILED, state.status());
        assertTrue(state.stopReason().contains("does not exist"));
        Path statePath = Path.of(System.getProperty("user.home"), ".spectro", "jobs-state.json");
        assertEquals(JobState.FAILED,
                HeadlessRunner.JobStateStore.read(JSON, statePath).get("ghost").status());
    }
}
