package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest.Reasoning;
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
 * The card-88 reasoning seam on the agent: {@link Agent#setReasoning} must
 * reach the NEXT provider request as mode + effort, OFF must also hide the
 * deltas, and the legacy boolean toggle must keep its exact pre-card-88
 * mapping (off = DEFAULT, never a fabricated wire-level OFF).
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AgentReasoningTest {

    /** Scripted provider that records every request it is asked to stream. */
    private static final class RecordingProvider implements LlmProvider {
        final List<ProviderRequest> requests = new ArrayList<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            return List.of(new PThinkingDelta("mulling"),
                    new PTextDelta("ok"),
                    new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static Agent agent(RecordingProvider provider, boolean thinking) {
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(new ToolRegistry())
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .thinking(thinking)
                .build());
    }

    private static List<RunEvent> collect(Agent agent) {
        List<RunEvent> events = new ArrayList<>();
        for (RunEvent event : agent.run("go", new RunOptions(new CancelSignal(), null))) {
            events.add(event);
        }
        return events;
    }

    @Test
    void setReasoningCarriesModeAndEffortIntoTheNextRequest() {
        RecordingProvider provider = new RecordingProvider();
        Agent agent = agent(provider, true);

        agent.setReasoning(Reasoning.ON, "high");
        collect(agent);
        assertEquals(Reasoning.ON, provider.requests.getFirst().reasoning());
        assertEquals("high", provider.requests.getFirst().effort());

        agent.setReasoning(Reasoning.OFF, null);
        List<RunEvent> second = collect(agent);
        assertEquals(Reasoning.OFF, provider.requests.get(1).reasoning());
        assertNull(provider.requests.get(1).effort(), "clearing the effort clears the field");
        assertTrue(second.stream().noneMatch(RunEvent.ThinkingDelta.class::isInstance),
                "OFF hides the deltas as well as switching the wire");
    }

    @Test
    void theLegacyBooleanToggleKeepsItsDefaultMapping() {
        // The header toggle promises visibility, not a wire-level refusal:
        // off has always meant "say nothing, hide the stream" (DEFAULT), and
        // flipping it to OFF here would 400 ollama models without a think
        // switch mid-session.
        RecordingProvider provider = new RecordingProvider();
        Agent agent = agent(provider, true);

        agent.setThinking(false);
        collect(agent);
        assertEquals(Reasoning.DEFAULT, provider.requests.getFirst().reasoning());

        agent.setThinking(true);
        collect(agent);
        assertEquals(Reasoning.ON, provider.requests.get(1).reasoning());
    }
}
