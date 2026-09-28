package dev.spectroscope.core.provider;

import com.anthropic.models.messages.MessageCreateParams;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest.Reasoning;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 447, criterion 5: the global {@code thinking: true} reaches every
 * provider as {@code Reasoning.ON}. The ollama adapter sent it to models that
 * cannot think; these tests read the other adapters for the same pattern.
 *
 * <p>Anthropic had it: a model whose row in the capability table says
 * {@code control: none} (the claude-2 and pre-3.7 claude-3 families) still got
 * a thinking parameter. The OpenAI-compatible adapter did not: on every dialect
 * it serves, {@code Reasoning.ON} without an effort writes no reasoning field,
 * and the dialect list is read from the table itself so a dialect added later
 * is covered without editing this file.</p>
 */
class ThinkingSettingOnEveryAdapterTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The two dialects with an adapter of their own; each has its own tests. */
    private static final Set<String> OWN_ADAPTER = Set.of("anthropic", "ollama");

    private static ProviderRequest on() {
        return new ProviderRequest("sys", List.of(new ProviderMessage(ProviderMessage.Role.USER,
                List.of(new TextContent("hallo")))), List.of(), 4096, Reasoning.ON, null,
                new CancelSignal());
    }

    // ---- anthropic -------------------------------------------------------

    @Test
    void anthropicSendsNoThinkingToAClaude3ModelWhoseRowSaysNone() {
        MessageCreateParams params = AnthropicProvider.buildParams(
                "claude-3-5-haiku-20241022", false, on());
        assertTrue(params.thinking().isEmpty(),
                "the claude-3 row says control none: " + params.thinking());
    }

    @Test
    void anthropicSendsNoThinkingToAClaude2Model() {
        assertTrue(AnthropicProvider.buildParams("claude-2.1", false, on()).thinking().isEmpty());
    }

    @Test
    void anthropicStillSendsThinkingToClaude37WhichCanThink() {
        // The positive half: the claude-3-7 row precedes the claude-3 row and
        // says toggle, so 3.7 keeps the legacy budget shape.
        var thinking = AnthropicProvider.buildParams("claude-3-7-sonnet-20250219", false, on())
                .thinking().orElseThrow();
        assertTrue(thinking.isEnabled(), "3.7 thinks on the budget shape");
    }

    @Test
    void anthropicStillSendsAdaptiveThinkingToAnUnknownId() {
        // The table's catch-all row is a toggle: an id the table does not name
        // is treated as one that can think, as before this card.
        assertTrue(AnthropicProvider.buildParams("claude-opus-9", false, on())
                .thinking().orElseThrow().isAdaptive());
    }

    // ---- openai-compatible: every dialect the table names ----------------

    @Test
    void reasoningOnAloneWritesNoReasoningFieldOnAnyOpenAiCompatibleDialect() throws IOException {
        JsonNode table;
        try (InputStream in = getClass().getResourceAsStream("/reasoning/capabilities.json")) {
            assertNotNull(in, "the capability table ships in the core resources");
            table = JSON.readTree(in);
        }
        List<String> checked = new ArrayList<>();
        for (Map.Entry<String, JsonNode> dialect : table.path("providers").properties()) {
            if (OWN_ADAPTER.contains(dialect.getKey())) {
                continue;
            }
            String base = "openai".equals(dialect.getKey())
                    ? "https://api.openai.com/v1" : "http://localhost:1234/v1";
            for (JsonNode row : dialect.getValue().path("rules")) {
                String pattern = row.path("pattern").asText();
                String model = "*".equals(pattern) ? "some-unlisted-model" : pattern + "-x";
                OpenAiCompatProvider.ReasoningWire wire = OpenAiCompatProvider.reasoningWireFor(
                        dialect.getKey(), base, model, false, Reasoning.ON, null);
                assertEquals(OpenAiCompatProvider.ReasoningWire.NOTHING, wire,
                        dialect.getKey() + " / " + model + " asked for reasoning on ON alone: " + wire);
                checked.add(dialect.getKey() + "/" + model);
            }
        }
        // The positive half: the loop really walked the table.
        assertFalse(checked.isEmpty());
        assertTrue(checked.stream().anyMatch(name -> name.startsWith("openai/")), checked.toString());
        assertTrue(checked.stream().anyMatch(name -> name.startsWith("llamacpp/")), checked.toString());
    }
}
