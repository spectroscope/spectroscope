package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.util.concurrent.TimeUnit;

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
