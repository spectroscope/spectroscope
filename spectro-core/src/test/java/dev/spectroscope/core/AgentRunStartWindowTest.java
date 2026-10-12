package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.SessionWindow;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Card 521: the run writes the window it derived onto its own
 * {@code run_start}, the same window and source its first
 * {@code context_info} names, so a stored session keeps the window its model
 * had.
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AgentRunStartWindowTest {

    /** A backend with a stated loaded window and a published one; 0 means none. */
    private record WindowProvider(int loaded, int published) implements LlmProvider {
        @Override
        public String modelName() {
            return "some-model";
        }

        @Override
        public int contextWindow() {
            return loaded;
        }

        @Override
        public int publishedWindow() {
            return published;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            return List.of(new PTextDelta("ok"), new PUsage(10, 3), new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static List<RunEvent> run(LlmProvider provider, SessionWindow window) {
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(new ToolRegistry())
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .introspection(true)
                .sessionWindow(window)
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("hello", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static RunEvent.RunStart start(List<RunEvent> events) {
        return events.stream().filter(RunEvent.RunStart.class::isInstance)
                .map(RunEvent.RunStart.class::cast).findFirst().orElseThrow();
    }

    private static RunEvent.ContextInfo info(List<RunEvent> events) {
        return events.stream().filter(RunEvent.ContextInfo.class::isInstance)
                .map(RunEvent.ContextInfo.class::cast).findFirst().orElseThrow();
    }

    @Test
    void theRunStartRecordsTheLoadedWindowItsFirstSnapshotNames() {
        List<RunEvent> events = run(new WindowProvider(250_368, 0), new SessionWindow());

        RunEvent.RunStart start = start(events);
        assertEquals(250_368, start.contextWindow());
        assertEquals("window", start.windowSource());
        assertEquals(info(events).contextWindow(), start.contextWindow(), "run_start and context_info agree");
        assertEquals(info(events).thresholdSource(), start.windowSource());
    }

    @Test
    void theRunStartRecordsAPublishedWindow() {
        RunEvent.RunStart start = start(run(new WindowProvider(0, 1_048_576), new SessionWindow()));

        assertEquals(1_048_576, start.contextWindow());
        assertEquals("model", start.windowSource());
    }

    @Test
    void theRunStartRecordsTheWindowTheOperatorSet() {
        SessionWindow set = new SessionWindow();
        set.set(400_000);

        RunEvent.RunStart start = start(run(new WindowProvider(0, 0), set));

        assertEquals(400_000, start.contextWindow());
        assertEquals("window_override", start.windowSource());
    }

    @Test
    void aRunThatLearnedNoWindowSaysSoAndNamesNone() {
        RunEvent.RunStart start = start(run(new WindowProvider(0, 0), new SessionWindow()));

        assertNull(start.contextWindow(), "no window is recorded when none was learned");
        assertEquals("fallback", start.windowSource());
    }
}
