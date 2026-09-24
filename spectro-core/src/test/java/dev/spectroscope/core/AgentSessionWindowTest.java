package dev.spectroscope.core;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.SessionWindow;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 390 in the loop: the window the operator set for a session is read at
 * the top of every turn, before the context estimate and before the compaction
 * check, from one holder the agent keeps for its whole life.
 *
 * <p>The review of the reverted first build (E1 in
 * {@code kanban/evidence/review-2026-09-24/04-review-card-377-override.md})
 * found the value copied into the options once, at build, and read once per
 * run: a value set afterwards reached no run of that agent. So every test here
 * sets the holder at a different moment and reads what the loop did with it,
 * on the events it emitted and on the calls it made.</p>
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AgentSessionWindowTest {

    /** The agent's own system prompt; the double tells a turn from the
     *  compaction summarizer by it. */
    private static final String AGENT_SYSTEM_PROMPT = "test";

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Compaction refuses a history of six messages or fewer, so a run that is
     *  meant to compact starts on a resumed session's worth of history. */
    private static List<LlmProvider.ProviderMessage> seededHistory(int pairs) {
        List<LlmProvider.ProviderMessage> history = new ArrayList<>();
        for (int i = 0; i < pairs; i++) {
            history.add(new LlmProvider.ProviderMessage(LlmProvider.ProviderMessage.Role.USER,
                    List.of(new LlmProvider.TextContent("earlier question " + i))));
            history.add(new LlmProvider.ProviderMessage(LlmProvider.ProviderMessage.Role.ASSISTANT,
                    List.of(new LlmProvider.TextContent("earlier answer " + i))));
        }
        return history;
    }

    /**
     * Two turns per run (a tool call, then an answer), a stated window, a
     * stated input-token report, a count of every window question, and a hook
     * that runs while the FIRST turn of the agent's life is being streamed,
     * which is the moment an operator sets a value on a working run.
     */
    private static final class ScriptedProvider implements LlmProvider {
        private final int window;
        private final int reportedInputTokens;
        private final List<ProviderRequest> summaries = new ArrayList<>();
        private int asked;
        private int turns;
        private boolean toolTurnSpent;
        private Runnable duringFirstTurn = () -> { };

        ScriptedProvider(int window, int reportedInputTokens) {
            this.window = window;
            this.reportedInputTokens = reportedInputTokens;
        }

        @Override
        public int contextWindow() {
            asked++;
            return window;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (!AGENT_SYSTEM_PROMPT.equals(request.system())) {
                summaries.add(request);
                return List.of(new PTextDelta("the story so far"),
                        new PStop(PStop.StopReason.END_TURN));
            }
            turns++;
            if (turns == 1) {
                duringFirstTurn.run();
            }
            if (!toolTurnSpent) {
                toolTurnSpent = true;
                return List.of(new PToolCall("c" + turns, "noop", JSON.createObjectNode()),
                        new PUsage(reportedInputTokens, 3),
                        new PStop(PStop.StopReason.TOOL_USE));
            }
            toolTurnSpent = false;
            return List.of(new PTextDelta("ok"),
                    new PUsage(reportedInputTokens, 3),
                    new PStop(PStop.StopReason.END_TURN));
        }
    }

    /** A permissionless tool, so a scripted tool call really opens a second turn. */
    private static final class NoopTool implements Tool {
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

    private static Agent agent(LlmProvider provider, Integer configured, SessionWindow window) {
        return agent(provider, configured, window, 3);
    }

    /** The agent under test, on a seeded history of {@code pairs} exchanges;
     *  {@code /compact} outside a run needs more than six messages to act on. */
    private static Agent agent(LlmProvider provider, Integer configured, SessionWindow window,
                               int pairs) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(new NoopTool());
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .initialMessages(seededHistory(pairs))
                .systemPrompt(AGENT_SYSTEM_PROMPT)
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .introspection(true)
                .compactionThreshold(configured)
                .sessionWindow(window)
                .build());
    }

    private static List<RunEvent> collect(Agent agent) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("do it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static List<RunEvent.ContextInfo> infos(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.ContextInfo.class::isInstance)
                .map(RunEvent.ContextInfo.class::cast)
                .toList();
    }

    private static boolean compacted(List<RunEvent> events) {
        return events.stream().anyMatch(RunEvent.Compaction.class::isInstance);
    }

    @Test
    void aWindowSetBeforeTheRunDecidesItsFirstTurnAndCostsNoProbe() {
        ScriptedProvider provider = new ScriptedProvider(204_288, 10);
        SessionWindow window = new SessionWindow();
        window.set(512_000);

        List<RunEvent.ContextInfo> infos = infos(collect(agent(provider, null, window)));

        RunEvent.ContextInfo first = infos.getFirst();
        assertEquals(358_400, first.threshold(), "70 % of the window the operator set");
        assertEquals("window_override", first.thresholdSource());
        assertEquals(512_000, first.contextWindow(), "the ring divides by the operator's window");
        assertEquals(0, provider.asked, "the operator gave the answer, so the backend is not asked");
    }

    @Test
    void aWindowSetWhileTheRunWorksReachesTheNextTurnOfThatRun() {
        // The owner's sentence of 2026-09-23 19:02:48, "ich kann was eingeben
        // und dann passiert nichts": the value has to act on the run he is
        // looking at, from its next turn.
        ScriptedProvider provider = new ScriptedProvider(204_288, 10);
        SessionWindow window = new SessionWindow();
        provider.duringFirstTurn = () -> window.set(250_368);

        List<RunEvent.ContextInfo> infos = infos(collect(agent(provider, null, window)));

        assertEquals(2, infos.size(), "test premise: a two-turn run");
        assertEquals("window", infos.get(0).thresholdSource(), "turn 1 ran before anything was set");
        assertEquals(204_288, infos.get(0).contextWindow());
        assertEquals("window_override", infos.get(1).thresholdSource(), "turn 2 reads the holder again");
        assertEquals(175_257, infos.get(1).threshold());
        assertEquals(250_368, infos.get(1).contextWindow());
    }

    @Test
    void aWindowSetBetweenRunsReachesTheNextRunOfTheSameAgentAndAClearHandsBack() {
        ScriptedProvider provider = new ScriptedProvider(204_288, 10);
        SessionWindow window = new SessionWindow();
        Agent agent = agent(provider, null, window);

        List<RunEvent.ContextInfo> before = infos(collect(agent));
        window.set(512_000);
        List<RunEvent.ContextInfo> during = infos(collect(agent));
        window.clear();
        List<RunEvent.ContextInfo> after = infos(collect(agent));

        assertEquals("window", before.getFirst().thresholdSource());
        assertEquals("window_override", during.getFirst().thresholdSource(),
                "the same agent, no rebuild, reads the new value on its next run");
        assertEquals(512_000, during.getFirst().contextWindow());
        assertEquals("window", after.getFirst().thresholdSource(), "a clear hands back to the backend");
        assertEquals(143_001, after.getFirst().threshold());
        assertEquals(204_288, after.getFirst().contextWindow());
    }

    @Test
    void aWindowClearedWhileTheRunWorksIsAskedForOnceAndOnlyThen() {
        // The probe stays off the hot path: asked at most once per run, and
        // only on the first turn that needs it.
        ScriptedProvider provider = new ScriptedProvider(204_288, 10);
        SessionWindow window = new SessionWindow();
        window.set(512_000);
        provider.duringFirstTurn = window::clear;

        List<RunEvent.ContextInfo> infos = infos(collect(agent(provider, null, window)));

        assertEquals("window_override", infos.get(0).thresholdSource());
        assertEquals("window", infos.get(1).thresholdSource());
        assertEquals(1, provider.asked, "asked once, on the turn after the clear");
    }

    @Test
    void theLoopCompactsAtTheSessionWindowAndGivesTheSummarizerItsReserve() {
        // A 10,000 window: threshold 7,000, reserve 3,000. A turn reporting
        // 7,500 input tokens is over it, so turn 2 summarizes.
        ScriptedProvider set = new ScriptedProvider(204_288, 7_500);
        SessionWindow window = new SessionWindow();
        window.set(10_000);

        List<RunEvent> events = collect(agent(set, null, window));

        assertTrue(compacted(events), "7,500 over a 7,000 line must summarize");
        assertEquals(1, set.summaries.size());
        assertEquals(3_000, set.summaries.getFirst().maxTokens(),
                "the summarizer asks for the reserve of the window the operator set");

        // The same run without a session window: 204,288 loaded, 143,001 line.
        ScriptedProvider unset = new ScriptedProvider(204_288, 7_500);
        List<RunEvent> baseline = collect(agent(unset, null, new SessionWindow()));
        assertTrue(!compacted(baseline), "without the session window 7,500 is far below the line");
        assertEquals(0, unset.summaries.size());
    }

    @Test
    void aSessionWindowOutranksTheOperatorsThresholdInTheLoopToo() {
        // compactionThreshold 5,000 alone would summarize at 7,500. A session
        // window of 100,000 (threshold 70,000) wins over it (owner call 3).
        ScriptedProvider set = new ScriptedProvider(204_288, 7_500);
        SessionWindow window = new SessionWindow();
        window.set(100_000);

        List<RunEvent> events = collect(agent(set, 5_000, window));

        assertEquals(70_000, infos(events).getFirst().threshold());
        assertEquals("window_override", infos(events).getFirst().thresholdSource());
        assertTrue(!compacted(events), "the session window lifted the line above 7,500");

        ScriptedProvider unset = new ScriptedProvider(204_288, 7_500);
        List<RunEvent> baseline = collect(agent(unset, 5_000, new SessionWindow()));
        assertEquals("override", infos(baseline).getFirst().thresholdSource());
        assertTrue(compacted(baseline), "without it the operator's 5,000 decides and 7,500 summarizes");
    }

    @Test
    void theCompactCommandAsksForTheReserveOfTheSessionWindow() {
        ScriptedProvider set = new ScriptedProvider(204_288, 10);
        SessionWindow window = new SessionWindow();
        window.set(10_000);

        Optional<RunEvent> event = agent(set, null, window, 4).compactNow();

        assertInstanceOf(RunEvent.Compaction.class, event.orElseThrow());
        assertEquals(3_000, set.summaries.getFirst().maxTokens());

        ScriptedProvider unset = new ScriptedProvider(204_288, 10);
        agent(unset, null, new SessionWindow(), 4).compactNow();
        assertEquals(Agent.DEFAULT_MAX_TOKENS, unset.summaries.getFirst().maxTokens(),
                "the loaded 204,288 leaves more than the default, so the default stays");
    }

    @Test
    void theBuilderHandsTheHolderThroughAndTheOldArityCarriesNone() {
        SessionWindow window = new SessionWindow();
        AgentOptions built = AgentOptions.builder().sessionWindow(window).build();
        assertSame(window, built.sessionWindow());
        assertSame(window, new Agent(AgentOptions.builder()
                .provider(new ScriptedProvider(0, 0))
                .registry(new ToolRegistry())
                .sessionWindow(window)
                .build()).sessionWindow());

        AgentOptions compat = new AgentOptions(null, "", null, Path.of("."), null, "main", null,
                null, null, null, null, null, null, null, null, null, null, null, null, null);
        assertNull(compat.sessionWindow(), "the pre-390 arity sets nothing");
    }
}
