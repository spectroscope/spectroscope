package dev.spectroscope.orchestrator;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.Spectro;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Serializes a real panel run to JSONL — one event per line, the same wire
 * the whole product speaks. The file doubles as the Spectrum smoke artifact:
 * paste build/panel-demo.jsonl into the web UI's import dialog and the
 * Spectrum tab folds this exact fleet.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class PanelDemoJsonlTest {

    /** Scripted turn with real pacing: each lane steps at its own tempo, so
     *  the fleet interleaves and the recorded timeline spans real time —
     *  nothing is post-edited, the run simply takes as long as it takes. */
    private record Scripted(String thought, String answer, long stepMillis) implements LlmProvider {
        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            pause();
            List<ProviderEvent> events = new ArrayList<>();
            for (String piece : thought.split("(?<= )")) {
                events.add(new PThinkingDelta(piece));
            }
            events.add(new PTextDelta(answer));
            events.add(new PStop(PStop.StopReason.END_TURN));
            return () -> new java.util.Iterator<>() {
                private final java.util.Iterator<ProviderEvent> it = events.iterator();

                @Override
                public boolean hasNext() {
                    return it.hasNext();
                }

                @Override
                public ProviderEvent next() {
                    pause();
                    return it.next();
                }
            };
        }

        private void pause() {
            try {
                Thread.sleep(stepMillis);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        @Override
        public String providerName() {
            return "scripted";
        }
    }

    @Test
    void writesAReplayableFleetJsonl(@TempDir Path tmp) throws Exception {
        var panel = Spectro.panel().workspace(tmp);
        panel.agent("bugs").model(new Scripted("scanning the diff hunk by hunk", "2 findings: an off-by-one and a swallowed exception.", 45))
                .task("Find bugs in the open diff");
        panel.agent("perf").model(new Scripted("profiling the hot paths first", "the N+1 in the session list dominates; index helps.", 80))
                .task("Check the hot queries");
        panel.agent("security").model(new Scripted("checking inputs against the sinks", "one unescaped path join; everything else is clean.", 120))
                .task("Review the input handling");

        ObjectMapper mapper = new ObjectMapper();
        List<String> lines = new ArrayList<>();
        for (RunEvent event : panel.run()) {
            lines.add(mapper.writeValueAsString(event));
        }

        Path out = Path.of("build", "panel-demo.jsonl");
        Files.createDirectories(out.getParent());
        Files.write(out, lines);

        assertTrue(lines.size() >= 20, "a three-lane fleet leaves a real trail");
        assertTrue(lines.get(0).contains("\"run_start\""));
        assertTrue(lines.get(lines.size() - 1).contains("\"run_end\""));
        // Every line parses back through the RunEvent union — replay-safe.
        for (String line : lines) {
            mapper.readValue(line, RunEvent.class);
        }
    }
}
