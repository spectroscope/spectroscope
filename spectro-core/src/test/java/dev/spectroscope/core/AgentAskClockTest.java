package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 265, criterion 5 — the clock the concept says every draft missed.
 *
 * <p>A question parks INSIDE {@code execute}, so without this the four minutes
 * a person spent thinking would be recorded as a four-minute tool call, and
 * every duration readout in the app would inherit the lie. Card 111 split
 * exactly these two clocks once, for the gate; this is the same seam for a wait
 * that happens one layer down, and it is generic: any later tool that waits on a
 * person gets honest numbers for free.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class AgentAskClockTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A tool that works briefly and waits a long time, reporting the wait. */
    private record SlowHuman(long waitMs, long workMs) implements Tool {
        @Override public String name() {
            return "waits_on_a_person";
        }

        @Override public String description() {
            return "parks";
        }

        @Override public JsonNode inputSchema() {
            return JSON.createObjectNode().put("type", "object");
        }

        @Override public boolean needsPermission() {
            return false;
        }

        @Override public String execute(JsonNode input, ToolContext context) {
            sleep(waitMs);
            context.waitReport().accept(waitMs);
            sleep(workMs);
            return "done";
        }
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    /** One tool-use turn, then an empty one — the house's scripted-provider idiom. */
    private record OneCallProvider(String toolName) implements LlmProvider {
        @Override public String modelName() {
            return "fake-model-1";
        }

        @Override public Iterable<ProviderEvent> stream(ProviderRequest request) {
            boolean alreadyCalled = request.messages().stream()
                    .anyMatch(message -> message.role() == ProviderMessage.Role.ASSISTANT);
            if (alreadyCalled) {
                return List.of(new PStop(PStop.StopReason.END_TURN));
            }
            return List.of(new PToolCall("c1", toolName, JSON.createObjectNode()),
                    new PStop(PStop.StopReason.TOOL_USE));
        }
    }

    private static List<RunEvent> runOneToolCall(Tool tool) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(tool);
        List<RunEvent> events = new ArrayList<>();
        Agent agent = new Agent(AgentOptions.builder()
                .provider(new OneCallProvider(tool.name()))
                .systemPrompt("test")
                .registry(registry)
                .onPermission(request -> true)
                .build());
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), List.of()))) {
            for (RunEvent event : stream) {
                events.add(event);
            }
        }
        return events;
    }

    @Test
    void theHumansWaitLeavesTheToolsOwnDuration() {
        List<RunEvent> events = runOneToolCall(new SlowHuman(400, 30));
        RunEvent.ToolResult result = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .findFirst()
                .orElseThrow(() -> new AssertionError("no tool_result at all"));

        assertTrue(result.durationMs() < 300L,
                "durationMs records WORK: the reported wait is subtracted, so a slow human"
                        + " never paints the tool as slow (card 111's rule) — was "
                        + result.durationMs());
    }

    @Test
    void aToolThatReportsNoWaitIsTimedExactlyAsBefore() {
        // The sink is additive in behaviour too: every existing tool reports
        // nothing, and nothing about its number may move.
        List<RunEvent> events = runOneToolCall(new SlowHuman(0, 250));
        RunEvent.ToolResult result = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .findFirst()
                .orElseThrow();
        assertTrue(result.durationMs() >= 200L,
                "an unreporting tool is timed exactly as before, was " + result.durationMs());
    }
}
