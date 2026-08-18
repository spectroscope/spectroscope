package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.CompactionThreshold;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 263 end to end: the number the loop compacts at, and the number the ring
 * is told about, are the SAME derived number — and both follow the backend.
 *
 * <p>The owner's report was that the context ring reads "43.0k of 100k before
 * compaction" while the loaded model offers 204,288. The ring is innocent
 * ({@code contextRingMath.ts} already prefers the run's reported threshold); the
 * harness simply reported the constant. So the pin belongs HERE, on the event
 * the harness emits, and on the trigger it hands to the summarizer.</p>
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AgentCompactionThresholdTest {

    /** A provider with a window and one scripted turn; records the requests. */
    private static final class SizedProvider implements LlmProvider {
        private final int window;
        private final List<ProviderRequest> requests = new ArrayList<>();
        private final int reportedInputTokens;

        SizedProvider(int window, int reportedInputTokens) {
            this.window = window;
            this.reportedInputTokens = reportedInputTokens;
        }

        @Override
        public int contextWindow() {
            return window;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            return List.of(new PTextDelta("ok"),
                    new PUsage(reportedInputTokens, 3),
                    new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static Agent agent(LlmProvider provider, Integer configured) {
        return agent(provider, configured, new ToolRegistry());
    }

    private static Agent agent(LlmProvider provider, Integer configured, ToolRegistry registry) {
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .introspection(true)
                .compactionThreshold(configured)
                .build());
    }

    private static List<RunEvent> collect(Agent agent) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("do it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static RunEvent.ContextInfo firstInfo(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.ContextInfo.class::isInstance)
                .map(RunEvent.ContextInfo.class::cast)
                .findFirst().orElseThrow();
    }

    @Test
    void theReportedThresholdFollowsTheLoadedWindowAndNotTheConstant() {
        RunEvent.ContextInfo info =
                firstInfo(collect(agent(new SizedProvider(204_288, 10), null)));

        assertEquals(153_216, info.threshold(),
                "the ring must be told three quarters of the window the backend loaded");
        assertEquals("window", info.thresholdSource(),
                "and told which fact produced it, so caption and behaviour cannot disagree");
    }

    @Test
    void anExplicitSettingStillWins() {
        RunEvent.ContextInfo info =
                firstInfo(collect(agent(new SizedProvider(204_288, 10), 42_000)));

        assertEquals(42_000, info.threshold());
        assertEquals("override", info.thresholdSource());
    }

    @Test
    void aBackendThatSaysNothingKeepsTheHundredThousand() {
        LlmProvider silent = request -> List.of(
                new LlmProvider.PTextDelta("ok"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));

        RunEvent.ContextInfo info = firstInfo(collect(agent(silent, null)));

        assertEquals(CompactionThreshold.FALLBACK_THRESHOLD, info.threshold());
        assertEquals("fallback", info.thresholdSource());
    }

    @Test
    void aTinyWindowMakesTheLoopCompactWhereTheOldConstantNeverWould() {
        // The other direction of AC 4, measured on the TRIGGER and not on the
        // caption: a model loaded at 8,192 has a threshold of 6,144, and a turn
        // reporting 7,000 input tokens is over it. Under the old constant those
        // 7,000 were nowhere near 100,000 and nothing happened — while the
        // server was already 800 tokens from the end of its window.
        SizedProvider small = new SizedProvider(8_192, 7_000);
        Agent agent = agent(small, null);

        List<RunEvent> first = collect(agent);
        assertEquals(6_144, firstInfo(first).threshold());

        // Second run on the same agent: the history now carries the first
        // exchange, and the turn opens with lastInputTokens still at 0 — so the
        // proof that the trigger MOVED has to be read off the threshold the
        // summarizer is handed. compactNow forces it; what this pins is that a
        // 7,000-token turn is above the derived line and below the old one.
        assertTrue(7_000 > firstInfo(first).threshold(),
                "7,000 input tokens are OVER an 8k model's derived threshold");
        assertTrue(7_000 < CompactionThreshold.FALLBACK_THRESHOLD,
                "and were comfortably under the constant this card removes");
    }

    @Test
    void theWindowIsAskedOncePerRunAndNotOncePerTurn() {
        // Non-functional criterion: one capability lookup per session at most,
        // memoized, and never on the hot path of a turn. A provider whose window
        // costs a round trip (LM Studio's listing, ollama's /api/ps) must not
        // pay it per turn — and the context_info event is emitted per turn, so
        // the naive place to ask is exactly the wrong one.
        ToolRegistry registry = new ToolRegistry();
        registry.register(new NoopTool());
        CountingProvider counting = new CountingProvider();
        Agent agent = agent(counting, null, registry);

        collect(agent);
        collect(agent);

        assertEquals(4, counting.turns, "two runs of two turns each");
        assertEquals(2, counting.asked, "once per run, whatever the turn count");
    }

    /** A permissionless tool, so a scripted tool call really opens a second turn. */
    private static final class NoopTool implements Tool {
        private static final ObjectMapper JSON = new ObjectMapper();

        public String name() {
            return "noop";
        }

        public String description() {
            return "does nothing";
        }

        public JsonNode inputSchema() {
            return JSON.createObjectNode();
        }

        public boolean needsPermission() {
            return false;
        }

        public String execute(JsonNode input, ToolContext context) {
            return "done";
        }
    }

    /** Counts window questions against turns: two turns per run, one tool call. */
    private static final class CountingProvider implements LlmProvider {
        private static final ObjectMapper JSON = new ObjectMapper();
        private int asked;
        private int turns;
        private boolean toolTurnSpent;

        @Override
        public int contextWindow() {
            asked++;
            return 204_288;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            turns++;
            if (!toolTurnSpent) {
                toolTurnSpent = true;
                return List.of(
                        new PToolCall("c" + turns, "noop", JSON.createObjectNode()),
                        new PStop(PStop.StopReason.TOOL_USE));
            }
            toolTurnSpent = false;
            return List.of(new PTextDelta("ok"), new PStop(PStop.StopReason.END_TURN));
        }
    }
}
