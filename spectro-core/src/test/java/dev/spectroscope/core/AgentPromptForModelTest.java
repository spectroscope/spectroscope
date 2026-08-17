package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 247: a run may carry a second prompt reading for the MODEL alone.
 * {@code RunStart.prompt} (the transcript, the user's own bubble) always keeps
 * the literal text; {@code RunOptions.promptForModel} is what the provider
 * request carries instead — the slash-skill expansion rides there. Absent, the
 * two are the same string, byte for byte, which is also the compat guarantee
 * for the old two-argument {@code RunOptions}.
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AgentPromptForModelTest {

    /** One scripted turn, every request recorded. */
    private static final class RecordingProvider implements LlmProvider {
        final List<ProviderRequest> requests = new ArrayList<>();

        @Override
        public String modelName() {
            return "fake-model-1";
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            return List.of(new PTextDelta("ok"), new PUsage(1, 1),
                    new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static Agent agentOn(RecordingProvider provider) {
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(new ToolRegistry())
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .build());
    }

    private static String firstUserText(LlmProvider.ProviderRequest request) {
        LlmProvider.ProviderMessage first = request.messages().getFirst();
        return ((LlmProvider.TextContent) first.content().getFirst()).text();
    }

    private static List<RunEvent> collect(Agent agent, RunOptions options, String prompt) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run(prompt, options)) {
            stream.forEach(events::add);
        }
        return events;
    }

    @Test
    void theModelReadingRidesTheRequestWhileTheRecordKeepsTheLiteral() {
        RecordingProvider provider = new RecordingProvider();
        List<RunEvent> events = collect(agentOn(provider),
                new RunOptions(null, null, "go /plan\n\n[skill: plan]\nPLAN BODY"), "go /plan");

        RunEvent.RunStart start = (RunEvent.RunStart) events.getFirst();
        assertEquals("go /plan", start.prompt());
        assertEquals("go /plan\n\n[skill: plan]\nPLAN BODY",
                firstUserText(provider.requests.getFirst()));
    }

    @Test
    void withoutAModelReadingTheProviderGetsThePromptItself() {
        RecordingProvider provider = new RecordingProvider();
        collect(agentOn(provider), new RunOptions(null, null), "just this");
        assertEquals("just this", firstUserText(provider.requests.getFirst()));
    }
}
