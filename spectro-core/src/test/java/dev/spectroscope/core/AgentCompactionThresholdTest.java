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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 263 end to end: the number the loop compacts at, and the number the ring
 * is told about, are the SAME derived number — and both follow the backend.
 * Card 366 adds the cloud half: a hosted model has no loaded instance to ask
 * about, and its PUBLISHED window reaches the same event by the same path.
 *
 * <p>The owner's report was that the context ring reads "43.0k of 100k before
 * compaction" while the loaded model offers 204,288. The ring is innocent
 * ({@code contextRingMath.ts} already prefers the run's reported threshold); the
 * harness simply reported the constant. So the pin belongs HERE, on the event
 * the harness emits, and on the trigger it hands to the summarizer.</p>
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AgentCompactionThresholdTest {

    /** The agent's own system prompt — the doubles tell a turn from the
     *  compaction summarizer by it, and nothing else in the run says "test". */
    private static final String AGENT_SYSTEM_PROMPT = "test";

    /** Compaction keeps the last four messages and refuses to run on a history
     *  of six or fewer, so a run that is supposed to compact needs a resumed
     *  session's worth of history under it. */
    private static List<LlmProvider.ProviderMessage> seededHistory() {
        List<LlmProvider.ProviderMessage> history = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            history.add(new LlmProvider.ProviderMessage(LlmProvider.ProviderMessage.Role.USER,
                    List.of(new LlmProvider.TextContent("earlier question " + i))));
            history.add(new LlmProvider.ProviderMessage(LlmProvider.ProviderMessage.Role.ASSISTANT,
                    List.of(new LlmProvider.TextContent("earlier answer " + i))));
        }
        return history;
    }

    /** A provider with a window and one scripted turn; records the requests. */
    private static final class SizedProvider implements LlmProvider {
        private final int window;
        private final List<ProviderRequest> requests = new ArrayList<>();
        private final int reportedInputTokens;
        private final String model;

        SizedProvider(int window, int reportedInputTokens) {
            this(window, reportedInputTokens, null);
        }

        SizedProvider(int window, int reportedInputTokens, String model) {
            this.window = window;
            this.reportedInputTokens = reportedInputTokens;
            this.model = model;
        }

        @Override
        public int contextWindow() {
            return window;
        }

        @Override
        public String modelName() {
            return model;
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
                .initialMessages(seededHistory())
                .systemPrompt(AGENT_SYSTEM_PROMPT)
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .introspection(true)
                .compactionThreshold(configured)
                .build());
    }

    private static ToolRegistry withNoop() {
        ToolRegistry registry = new ToolRegistry();
        registry.register(new NoopTool());
        return registry;
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

        assertEquals(143_001, info.threshold(),
                "the ring must be told 70 % of the window the backend loaded");
        assertEquals("window", info.thresholdSource(),
                "and told which fact produced it, so caption and behaviour cannot disagree");
        assertEquals(204_288, info.contextWindow(),
                "and the window itself, so the gauge names its own denominator's origin");
    }

    @Test
    void aCloudModelReachesTheGaugeWithItsPublishedWindow() {
        // Card 366, the whole point. A provider with no capability endpoint
        // answers 0 — there is no loaded instance to overrun — and before this
        // card that put a 1,000,000-token model on the 100,000 constant, 10 % of
        // the window the operator is paying for.
        RunEvent.ContextInfo info = firstInfo(collect(
                agent(new SizedProvider(0, 10, "claude-opus-4-6"), null)));

        assertEquals(700_000, info.threshold());
        assertEquals("model", info.thresholdSource());
        assertEquals(1_000_000, info.contextWindow());
    }

    @Test
    void aLocalModelKeepsDerivingFromTheInstanceTheServerLoaded() {
        // Card 366, AC 3: the local behaviour is UNCHANGED and pinned. This is
        // the shape that made the two cases look like one — an id the published
        // table also knows, served by a backend holding far less. The loaded
        // instance wins, and the event says so.
        RunEvent.ContextInfo info = firstInfo(collect(
                agent(new SizedProvider(32_768, 10, "claude-opus-4-6"), null)));

        assertEquals(22_937, info.threshold(), "70 % of what the SERVER holds");
        assertEquals("window", info.thresholdSource());
        assertEquals(32_768, info.contextWindow());
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
        assertNull(info.contextWindow(),
                "nothing was learned, and the event may not invent a window");
    }

    @Test
    void aTinyWindowMakesTheLoopSummarizeWhereTheOldConstantNeverWould() {
        // AC 4's other direction, measured on the SUMMARIZER and not on the
        // caption. The test this replaces claimed the loop compacts and never
        // watched it: it read the threshold off context_info and then asserted
        // two constant comparisons. Under a Compaction.maybeCompact mutated to
        // never fire, that class stayed 5/5 green while seven other tests in
        // core went red — the house rule is to replace such a test, not loosen
        // it. So: a model loaded at 8,192 compacts at 5,734, a turn reporting
        // 7,000 input tokens is over it, and the proof is the summarizer's own
        // call arriving at the provider.
        CompactingProvider small = new CompactingProvider(8_192, 7_000);

        List<RunEvent> events = collect(agent(small, null, withNoop()));

        assertEquals(5_734, firstInfo(events).threshold());
        assertTrue(events.stream().anyMatch(RunEvent.Compaction.class::isInstance),
                "7,000 input tokens over a 5,734 line must actually summarize");
        assertEquals(1, small.summaries.size(), "exactly one summarizer call");
    }

    @Test
    void theSameRunOnTheOldConstantNeverSummarizesAtAll() {
        // The negative twin, and the whole point of the card: the identical run
        // against a backend that states nothing lands on 100,000 and the very
        // same 7,000-token turn passes unnoticed — which is what the owner's
        // 8k-model sessions did until the server truncated them silently.
        CompactingProvider silent = new CompactingProvider(0, 7_000);

        List<RunEvent> events = collect(agent(silent, null, withNoop()));

        assertEquals(CompactionThreshold.FALLBACK_THRESHOLD, firstInfo(events).threshold());
        assertTrue(events.stream().noneMatch(RunEvent.Compaction.class::isInstance),
                "under the old constant the same turn is nowhere near the line");
        assertEquals(0, silent.summaries.size());
    }

    @Test
    void theSummarizerIsNeverAskedForMoreThanTheWindowItMustFitIn() {
        // Review finding: the summarizer's request carried a literal 32,000
        // maxTokens. On the 8k model above the reserve is 2,458, so the one call
        // the reserve exists to hold asked for four times the whole window.
        // Compaction never throws, so that degrades into an ErrorEvent every
        // other turn — silently, in exactly the configuration AC 4 exists for.
        CompactingProvider small = new CompactingProvider(8_192, 7_000);
        collect(agent(small, null, withNoop()));

        assertEquals(2_458, small.summaries.getFirst().maxTokens(),
                "the summarizer gets the reserve the threshold kept back");

        // And the clamp only ever takes budget away: on the owner's own window
        // the summarizer keeps the full default completion budget.
        CompactingProvider big = new CompactingProvider(204_288, 160_000);
        collect(agent(big, null, withNoop()));

        assertEquals(Agent.DEFAULT_MAX_TOKENS, big.summaries.getFirst().maxTokens());
    }

    @Test
    void anExplicitThresholdIsNotPaidForWithAProbeTheRunThrowsAway() {
        // AC 3's lever, priced. `derive(override, provider.contextWindow())`
        // evaluated the argument eagerly, so an operator who set a threshold
        // still paid the capability round trip on every run — measured with the
        // shipped classes: 330 ms against api.openai.com, 2,001 ms against a
        // black-holed host — and it is spent BEFORE run_start is emitted, so it
        // is dead air rather than a visible wait. And on every child run too:
        // a spawn builds its own Agent and enters the same loop.
        CountingProvider counting = new CountingProvider();

        List<RunEvent> events = collect(agent(counting, 42_000, withNoop()));

        assertEquals(42_000, firstInfo(events).threshold());
        assertEquals("override", firstInfo(events).thresholdSource());
        assertEquals(0, counting.asked,
                "an override decides alone — the backend must not be asked at all");
    }

    @Test
    void theWindowIsAskedOncePerRunAndNotOncePerTurn() {
        // Non-functional criterion: one capability lookup per session at most,
        // memoized, and never on the hot path of a turn. A provider whose window
        // costs a round trip (LM Studio's listing, ollama's /api/ps, a
        // llama-server's /props) must not
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

    /**
     * A two-turn run with a stated window and a stated input-token report, which
     * keeps every request it was handed apart: the TURN calls (system prompt
     * "test") from the compaction summarizer's own call (its own note-taker
     * system prompt). The summarizer must answer with text, or Compaction treats
     * a blank summary as "nothing happened" and emits no event.
     */
    private static final class CompactingProvider implements LlmProvider {
        private static final ObjectMapper JSON = new ObjectMapper();
        private final int window;
        private final int reportedInputTokens;
        private final List<ProviderRequest> summaries = new ArrayList<>();
        private boolean toolTurnSpent;

        CompactingProvider(int window, int reportedInputTokens) {
            this.window = window;
            this.reportedInputTokens = reportedInputTokens;
        }

        @Override
        public int contextWindow() {
            return window;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (!AGENT_SYSTEM_PROMPT.equals(request.system())) {
                summaries.add(request);
                return List.of(new PTextDelta("the story so far"),
                        new PStop(PStop.StopReason.END_TURN));
            }
            if (!toolTurnSpent) {
                toolTurnSpent = true;
                return List.of(
                        new PToolCall("c1", "noop", JSON.createObjectNode()),
                        new PUsage(reportedInputTokens, 3),
                        new PStop(PStop.StopReason.TOOL_USE));
            }
            return List.of(new PTextDelta("ok"),
                    new PUsage(reportedInputTokens, 3),
                    new PStop(PStop.StopReason.END_TURN));
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
