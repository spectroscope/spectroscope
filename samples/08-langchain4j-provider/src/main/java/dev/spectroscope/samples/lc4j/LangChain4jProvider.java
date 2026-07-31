package dev.spectroscope.samples.lc4j;

import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.output.TokenUsage;
import dev.spectroscope.core.provider.LlmProvider;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * A real bridge, not a pattern: any LangChain4j {@link ChatModel} as a
 * spectroscope {@link LlmProvider}. The frozen facade takes any provider
 * through {@code .model(...)}, so LangChain4j's whole model catalogue —
 * Ollama here, but equally its OpenAI, Mistral, Bedrock, … integrations —
 * plugs into the agent loop with this one class and zero changes to
 * spectroscope.
 *
 * <p>Honest scope: this is a TEXT bridge. It maps the system prompt and
 * the text history both ways and reports token usage, but it does not
 * advertise spectroscope's tools to the LangChain4j model — construct the
 * agent with an empty tool belt ({@code .tools()}). For tool-running
 * agents, use spectroscope's native providers.</p>
 */
public final class LangChain4jProvider implements LlmProvider {

    private final ChatModel model;
    private final String label;

    /**
     * @param model any LangChain4j chat model
     * @param label what run_start records as the provider, e.g. "langchain4j-ollama"
     */
    public LangChain4jProvider(ChatModel model, String label) {
        this.model = Objects.requireNonNull(model, "model");
        this.label = Objects.requireNonNull(label, "label");
    }

    @Override
    public Iterable<ProviderEvent> stream(ProviderRequest request) {
        // Lazy on purpose: each iterator() is one model call, which is the
        // contract the agent loop consumes.
        return () -> {
            List<ChatMessage> history = new ArrayList<>();
            if (request.system() != null && !request.system().isBlank()) {
                history.add(SystemMessage.from(request.system()));
            }
            for (ProviderMessage message : request.messages()) {
                history.add(toLangChain4j(message));
            }

            ChatResponse response = model.chat(history);

            List<ProviderEvent> events = new ArrayList<>();
            String text = response.aiMessage().text();
            if (text != null && !text.isEmpty()) {
                events.add(new PTextDelta(text));
            }
            TokenUsage usage = response.tokenUsage();
            if (usage != null) {
                events.add(new PUsage(zeroIfNull(usage.inputTokenCount()),
                        zeroIfNull(usage.outputTokenCount())));
            }
            events.add(new PStop(PStop.StopReason.END_TURN));
            return events.iterator();
        };
    }

    @Override
    public String providerName() {
        return label;
    }

    /** Text pieces only — the honest scope of this bridge (see class doc). */
    private static ChatMessage toLangChain4j(ProviderMessage message) {
        StringBuilder text = new StringBuilder();
        for (ProviderContent piece : message.content()) {
            if (piece instanceof TextContent(String value)) {
                text.append(value);
            }
        }
        return message.role() == ProviderMessage.Role.ASSISTANT
                ? AiMessage.from(text.toString())
                : UserMessage.from(text.toString());
    }

    private static int zeroIfNull(Integer count) {
        return count == null ? 0 : count;
    }
}
