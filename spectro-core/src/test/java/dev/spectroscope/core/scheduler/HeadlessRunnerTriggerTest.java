package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.SessionStore;
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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 72: the runner's trigger stamp. A triggered node knows WHAT woke each
 * run — the agent cannot — so the runner stamps the {@code run_start} at its
 * seam, and every consumer (session JSONL, auxiliary port, onEvent) sees the
 * same stamped event. Unset, the run_start is byte-identical to before.
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS)
class HeadlessRunnerTriggerTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final SpectroConfig CONFIG = new SpectroConfig(
            "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
            java.util.List.of(), "gemini", true, java.util.List.of(), 2, true,
            java.util.List.of(), null, "info", null, null, "auto", "auto", null, null, null, null, null,
            null, false, false);

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

    private static ScriptedProvider oneAnswer(String text) {
        ScriptedProvider provider = new ScriptedProvider();
        provider.turns.add(List.of(
                new LlmProvider.PTextDelta(text),
                new LlmProvider.PUsage(10, 4),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        return provider;
    }

    @Test
    void withTriggerStampsTheRunStartForEveryConsumer(@TempDir Path cwd) {
        List<RunEvent> seen = new ArrayList<>();
        HeadlessRunner.Outcome outcome = new HeadlessRunner(JSON, CONFIG, oneAnswer("done"))
                .withTrigger("fs #1 watch:/drop")
                .runOnce("scan", cwd, false, null, seen::add, line -> { });

        assertTrue(outcome.exitOk());
        RunEvent.RunStart start = (RunEvent.RunStart) seen.get(0);
        assertEquals("fs #1 watch:/drop", start.trigger(),
                "the run_start every consumer sees carries the stamp");
    }

    @Test
    void withoutTheWitherTheRunStartStaysTriggerless(@TempDir Path cwd) {
        List<RunEvent> seen = new ArrayList<>();
        new HeadlessRunner(JSON, CONFIG, oneAnswer("done"))
                .runOnce("scan", cwd, false, null, seen::add, line -> { });

        RunEvent.RunStart start = (RunEvent.RunStart) seen.get(0);
        assertNull(start.trigger(), "the frozen default is byte-identical to before");
    }

    @Test
    void theStampReachesTheSessionJsonlToo(@TempDir Path cwd) throws Exception {
        SessionStore store = new SessionStore();
        new HeadlessRunner(JSON, CONFIG, oneAnswer("done"))
                .withTrigger("timer #3 every:5m")
                .runOnce("scan", cwd, false, null, null, line -> { }, store, List.of());

        Path sessionFile = Path.of(System.getProperty("user.home"), ".spectro", "sessions",
                store.id() + ".jsonl");
        String firstLine = Files.readAllLines(sessionFile).get(0);
        RunEvent.RunStart start = (RunEvent.RunStart) JSON.readValue(firstLine, RunEvent.class);
        assertEquals("timer #3 every:5m", start.trigger(),
                "durability first — the stamped event is what the session file holds");
    }
}
