package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.SessionWindow;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 391 in the loop: a provider that states no loaded window and publishes
 * one (an Ollama cloud model) reaches {@code context_info}, the compaction
 * trigger and the {@code /compact} budget through the same derivation, and is
 * asked at most once per run although the derivation runs every turn.
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AgentPublishedWindowTest {

    /** The agent's own system prompt; the double tells a turn from the
     *  compaction summarizer by it. */
    private static final String AGENT_SYSTEM_PROMPT = "test";

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Compaction refuses a history of six messages or fewer. */
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
     * No loaded window, a published one, two turns per run (a tool call, then
     * an answer), a stated input-token report, and a count of both window
     * questions.
     */
    private static final class CloudProvider implements LlmProvider {
        private final int published;
        private final int reportedInputTokens;
        private final List<ProviderRequest> summaries = new ArrayList<>();
        private int loadedAsked;
        private int publishedAsked;
        private int turns;
        private boolean toolTurnSpent;

        CloudProvider(int published, int reportedInputTokens) {
            this.published = published;
            this.reportedInputTokens = reportedInputTokens;
        }

        @Override
        public String modelName() {
            return "glm-5.3:cloud";
        }

        @Override
        public int contextWindow() {
            loadedAsked++;
            return 0;
        }

        @Override
        public int publishedWindow() {
            publishedAsked++;
            return published;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (!AGENT_SYSTEM_PROMPT.equals(request.system())) {
                summaries.add(request);
                return List.of(new PTextDelta("the story so far"),
                        new PStop(PStop.StopReason.END_TURN));
            }
            turns++;
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

    private static Agent agent(LlmProvider provider, SessionWindow window, int pairs) {
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

    private static RunEvent.ContextInfo firstInfo(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.ContextInfo.class::isInstance)
                .map(RunEvent.ContextInfo.class::cast)
                .findFirst().orElseThrow();
    }

    @Test
    void anOllamaCloudModelReachesTheRingWithTheWindowItsBackendPublishes() {
        RunEvent.ContextInfo info = firstInfo(collect(
                agent(new CloudProvider(1_048_576, 10), new SessionWindow(), 3)));

        assertEquals(734_003, info.threshold());
        assertEquals("model", info.thresholdSource());
        assertEquals(1_048_576, info.contextWindow());
    }

    @Test
    void thePublishedWindowIsAskedOncePerRunAndNotOncePerTurn() {
        CloudProvider cloud = new CloudProvider(1_048_576, 10);
        Agent agent = agent(cloud, new SessionWindow(), 3);

        collect(agent);
        collect(agent);

        assertEquals(4, cloud.turns, "two runs of two turns each");
        assertEquals(2, cloud.loadedAsked, "the loaded window first, once per run");
        assertEquals(2, cloud.publishedAsked, "then the published one, once per run");
    }

    @Test
    void theLoopCompactsAtSeventyPercentOfThePublishedWindow() {
        // 8,192 published: the threshold is 5,734, and a turn reporting 7,000
        // is over it. Without the published rung the run would sit on 100,000.
        CloudProvider small = new CloudProvider(8_192, 7_000);

        List<RunEvent> events = collect(agent(small, new SessionWindow(), 3));

        assertEquals(5_734, firstInfo(events).threshold());
        assertTrue(events.stream().anyMatch(RunEvent.Compaction.class::isInstance));
        assertEquals(2_458, small.summaries.getFirst().maxTokens(),
                "the summarizer gets the reserve of the published window");
    }

    @Test
    void theCompactCommandSizesTheSummarizerByThePublishedWindow() {
        CloudProvider small = new CloudProvider(8_192, 10);

        Optional<RunEvent> event = agent(small, new SessionWindow(), 4).compactNow();

        assertInstanceOf(RunEvent.Compaction.class, event.orElseThrow());
        assertEquals(2_458, small.summaries.getFirst().maxTokens());
    }

    @Test
    void theRunStartLogLineNamesThePublishedThreshold() {
        // The line the review of 2026-09-24 read "compacting at 100000 input
        // tokens (fallback)" off, on every glm-5.3:cloud run. Exactly one line:
        // a second "from turn 1" line would mean the run started on another
        // number than its first turn used.
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(Agent.class);
        ch.qos.logback.classic.Level before = logger.getLevel();
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> records =
                new ch.qos.logback.core.read.ListAppender<>();
        records.start();
        logger.setLevel(ch.qos.logback.classic.Level.INFO);
        logger.addAppender(records);
        try {
            collect(agent(new CloudProvider(1_048_576, 10), new SessionWindow(), 3));
            List<String> lines = records.list.stream()
                    .map(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage)
                    .filter(line -> line.startsWith("compacting at "))
                    .toList();
            assertEquals(List.of("compacting at 734003 input tokens (model)"), lines);
        } finally {
            logger.detachAppender(records);
            logger.setLevel(before);
        }
    }

    @Test
    void aSessionWindowStillWinsAndThePublishedWindowIsNotAsked() {
        CloudProvider cloud = new CloudProvider(1_048_576, 10);
        SessionWindow window = new SessionWindow();
        window.set(400_000);

        RunEvent.ContextInfo info = firstInfo(collect(agent(cloud, window, 3)));

        assertEquals(280_000, info.threshold());
        assertEquals("window_override", info.thresholdSource());
        assertEquals(0, cloud.publishedAsked);
    }
}
