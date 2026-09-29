package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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

/**
 * Card 456: the window the loop derived for the turn (card 263) reaches the
 * tool through its context, so read_file can judge a file against it.
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AgentToolWindowTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Records the window each call was handed. */
    private static final class WindowProbe implements Tool {
        final List<Integer> seen = new ArrayList<>();

        public String name() {
            return "probe";
        }

        public String description() {
            return "records the window";
        }

        public JsonNode inputSchema() {
            return JSON.createObjectNode();
        }

        public boolean needsPermission() {
            return false;
        }

        public String execute(JsonNode input, ToolContext context) {
            seen.add(context.contextWindow());
            return "done";
        }
    }

    /** One tool call, then an answer; states the window it was built with. */
    private static final class OneCall implements LlmProvider {
        private final int window;
        private boolean called;

        OneCall(int window) {
            this.window = window;
        }

        @Override
        public int contextWindow() {
            return window;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (!called) {
                called = true;
                return List.of(new PToolCall("c1", "probe", JSON.createObjectNode()),
                        new PStop(PStop.StopReason.TOOL_USE));
            }
            return List.of(new PTextDelta("ok"), new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static List<Integer> windowsSeen(int providerWindow, Integer threshold) {
        WindowProbe probe = new WindowProbe();
        ToolRegistry registry = new ToolRegistry();
        registry.register(probe);
        Agent agent = new Agent(AgentOptions.builder()
                .provider(new OneCall(providerWindow))
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .compactionThreshold(threshold)
                .build());
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(event -> { });
        }
        return probe.seen;
    }

    @Test
    void theLoadedWindowReachesTheTool() {
        assertEquals(List.of(250_368), windowsSeen(250_368, null));
    }

    @Test
    void withNothingLearnedTheToolIsHandedTheFallbackTheLoopCompactsAt() {
        assertEquals(List.of(CompactionThreshold.FALLBACK_THRESHOLD), windowsSeen(0, null));
    }

    @Test
    void anExplicitThresholdWithNoKnownWindowIsWhatTheToolIsHanded() {
        // The operator's number is the only statement about room there is.
        assertEquals(List.of(42_000), windowsSeen(0, 42_000));
    }
}
