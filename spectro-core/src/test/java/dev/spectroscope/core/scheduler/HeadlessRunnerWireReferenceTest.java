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
 * Card 473, round three: a headless run names the files beside its session in
 * its run_start, by the same rule as the server's browser session
 * ({@code WireReference}): the llm wire it records, no browser wire it never
 * wrote, and an empty child list.
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS)
class HeadlessRunnerWireReferenceTest {

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
    void theRunStartInTheFileNamesTheLlmWire(@TempDir Path cwd) throws Exception {
        SessionStore store = new SessionStore();
        List<RunEvent> seen = new ArrayList<>();
        new HeadlessRunner(JSON, CONFIG, oneAnswer("done"))
                .runOnce("scan", cwd, false, null, seen::add, line -> { }, store, List.of());

        Path sessionFile = Path.of(System.getProperty("user.home"), ".spectro", "sessions",
                store.id() + ".jsonl");
        List<String> lines = Files.readAllLines(sessionFile);
        RunEvent.RunStart start = (RunEvent.RunStart) JSON.readValue(lines.get(0), RunEvent.class);
        assertEquals(store.id() + ".llm.jsonl", start.llmWire());
        assertNull(start.browserWire(), "no browser wire was written");
        assertEquals(List.of(), start.children());
        assertEquals(start, seen.get(0), "every consumer sees the same stamped run_start");
        assertTrue(lines.stream().noneMatch(l -> l.contains("\"sidecars\"")), "no extra line");
    }
}
