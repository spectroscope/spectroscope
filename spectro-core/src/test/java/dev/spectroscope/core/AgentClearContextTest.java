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
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 471: {@code /clear} in the web chat drops the agent's history and keeps
 * everything else.
 *
 * <p>The CLI's {@code /clear} builds a new agent in a new session. The browser
 * keeps the session (its id, its file, its llm-wire) and asks the SAME agent to
 * forget what was said. What stays is pinned beside what goes: the system
 * prompt and the tool world ride the next request unchanged, so a clear is a
 * fresh head and not a different agent.</p>
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AgentClearContextTest {

    /** Answers every turn with plain text and records each request. */
    private static final class RecordingProvider implements LlmProvider {
        final List<ProviderRequest> requests = new ArrayList<>();

        @Override
        public String modelName() {
            return "fake-model-1";
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            return List.of(new PTextDelta("noted"), new PUsage(1, 1),
                    new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static Agent agentOn(RecordingProvider provider, List<LlmProvider.ProviderMessage> history) {
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("SYSTEM-471")
                .registry(new ToolRegistry())
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .initialMessages(history)
                .build());
    }

    private static void run(Agent agent, String prompt) {
        try (EventStream stream = agent.run(prompt, new RunOptions(null, null))) {
            stream.forEach(event -> { });
        }
    }

    private static String allText(LlmProvider.ProviderRequest request) {
        StringBuilder out = new StringBuilder();
        for (LlmProvider.ProviderMessage message : request.messages()) {
            for (LlmProvider.ProviderContent content : message.content()) {
                if (content instanceof LlmProvider.TextContent text) {
                    out.append(text.text()).append('\n');
                }
            }
        }
        return out.toString();
    }

    @Test
    void theRequestAfterAClearCarriesOnlyTheNewPrompt() {
        RecordingProvider provider = new RecordingProvider();
        Agent agent = agentOn(provider, null);
        run(agent, "ALPHA remember the number 7");
        run(agent, "BRAVO and the colour blue");

        agent.clearContext();
        run(agent, "CHARLIE what do you know");

        LlmProvider.ProviderRequest before = provider.requests.get(1);
        assertTrue(allText(before).contains("ALPHA"), "premise: without a clear the history rides along");
        LlmProvider.ProviderRequest after = provider.requests.get(2);
        assertEquals(1, after.messages().size(), "only the new prompt: " + after.messages());
        assertEquals("CHARLIE what do you know\n", allText(after));
    }

    @Test
    void theSystemPromptAndTheToolWorldStay() {
        RecordingProvider provider = new RecordingProvider();
        Agent agent = agentOn(provider, null);
        run(agent, "first");

        agent.clearContext();
        run(agent, "second");

        LlmProvider.ProviderRequest before = provider.requests.get(0);
        LlmProvider.ProviderRequest after = provider.requests.get(1);
        assertEquals(before.system(), after.system());
        assertTrue(after.system().contains("SYSTEM-471"), after.system());
        assertEquals(before.tools(), after.tools());
    }

    @Test
    void theMarkerNamesTheAgentAndHowManyMessagesWent() {
        RecordingProvider provider = new RecordingProvider();
        Agent agent = agentOn(provider, null);
        run(agent, "one");
        run(agent, "two");

        RunEvent.ContextCleared cleared = agent.clearContext();

        assertEquals("main", cleared.agentId());
        assertEquals(4, cleared.removedMessages(), "two runs, a prompt and an answer each");
        assertTrue(cleared.ts() > 0);
    }

    @Test
    void aResumedHistoryIsDroppedToo() {
        RecordingProvider provider = new RecordingProvider();
        List<LlmProvider.ProviderMessage> resumed = List.of(
                new LlmProvider.ProviderMessage(LlmProvider.ProviderMessage.Role.USER,
                        List.of(new LlmProvider.TextContent("OLD question"))),
                new LlmProvider.ProviderMessage(LlmProvider.ProviderMessage.Role.ASSISTANT,
                        List.of(new LlmProvider.TextContent("OLD answer"))));
        Agent agent = agentOn(provider, resumed);

        assertEquals(2, agent.clearContext().removedMessages());
        run(agent, "NEW");

        assertEquals("NEW\n", allText(provider.requests.getFirst()));
    }
}
