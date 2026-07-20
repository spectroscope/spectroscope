package dev.spectroscope.core.provider;

import com.anthropic.models.messages.ContentBlockParam;
import com.anthropic.models.messages.MessageCreateParams;
import com.anthropic.models.messages.ThinkingConfigAdaptive;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.provider.LlmProvider.ImageContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolCallContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
import org.junit.jupiter.api.Test;

import java.util.Base64;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The Anthropic content mapping, proven WITHOUT a client: the
 * mapping is a pure static function, so no ANTHROPIC_API_KEY and no network
 * are needed. The streaming translation itself is covered by the agent tests
 * against a fake provider; this class pins the SDK block shapes — above all
 * that an image becomes a base64 image block placed BEFORE the text.
 */
class AnthropicProviderTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String PNG_BASE64 =
            Base64.getEncoder().encodeToString(new byte[] {(byte) 0x89, 'P', 'N', 'G'});

    @Test
    void imageContentBecomesABase64ImageBlock() {
        List<ContentBlockParam> blocks = AnthropicProvider.toAnthropicContent(
                List.of(new ImageContent("image/png", PNG_BASE64)));

        assertEquals(1, blocks.size());
        assertTrue(blocks.getFirst().isImage());
        var source = blocks.getFirst().asImage().source().asBase64();
        assertEquals("image/png", source.mediaType().asString());
        assertEquals(PNG_BASE64, source.data());
    }

    @Test
    void imageBlocksAreOrderedBeforeTheTextOfTheSameMessage() {
        // The caller appends the prompt AFTER the images (Agent);
        // the mapping additionally enforces the order even for mixed input.
        List<ContentBlockParam> blocks = AnthropicProvider.toAnthropicContent(List.of(
                new TextContent("What is in this image?"),
                new ImageContent("image/jpeg", PNG_BASE64)));

        assertTrue(blocks.get(0).isImage(), "the image block must come first");
        assertEquals("What is in this image?", blocks.get(1).asText().text());
    }

    @Test
    void documentContentBecomesABase64PdfDocumentBlock() {
        // view_file (file_upload): a PDF rides as a document block with a
        // base64 source — the Messages API reads it natively.
        List<ContentBlockParam> blocks = AnthropicProvider.toAnthropicContent(
                List.of(new LlmProvider.DocumentContent(
                        "application/pdf", "UERGQllURVM=", "paper.pdf")));

        assertEquals(1, blocks.size());
        assertTrue(blocks.getFirst().isDocument(), "a document block, got: " + blocks.getFirst());
        assertEquals("UERGQllURVM=", blocks.getFirst().asDocument().source().asBase64().data());
    }

    @Test
    void documentsOrderAfterImagesAndBeforeText() {
        List<ContentBlockParam> blocks = AnthropicProvider.toAnthropicContent(List.of(
                new TextContent("Summarize the paper."),
                new LlmProvider.DocumentContent("application/pdf", "UERGQllURVM=", "paper.pdf"),
                new ImageContent("image/png", PNG_BASE64),
                new ToolResultContent("c1", "Attached paper.pdf", false)));

        assertTrue(blocks.get(0).isToolResult(), "tool results lead");
        assertTrue(blocks.get(1).isImage(), "images next");
        assertTrue(blocks.get(2).isDocument(), "documents after images");
        assertEquals("Summarize the paper.", blocks.get(3).asText().text());
    }

    @Test
    void textToolUseAndToolResultBlocksKeepTheirStageThreeShape() {
        var input = JSON.createObjectNode().put("path", "src");
        List<ContentBlockParam> assistant = AnthropicProvider.toAnthropicContent(List.of(
                new TextContent("Let me look."),
                new ToolCallContent("c1", "list_dir", input)));
        assertEquals("Let me look.", assistant.get(0).asText().text());
        assertEquals("c1", assistant.get(1).asToolUse().id());
        assertEquals("list_dir", assistant.get(1).asToolUse().name());

        List<ContentBlockParam> user = AnthropicProvider.toAnthropicContent(List.of(
                new ToolResultContent("c1", "src\nbuild.gradle.kts", false)));
        assertEquals("c1", user.getFirst().asToolResult().toolUseId());
    }

    @Test
    void toolResultsLeadTheMessageImagesFollowTextComesLast() {
        // The Messages API rejects a tool-answering user message unless the
        // tool_result blocks come FIRST — view_image attaches its image to
        // exactly that message, so the order is tool_result, image, text.
        var input = JSON.createObjectNode();
        List<ContentBlockParam> blocks = AnthropicProvider.toAnthropicContent(List.of(
                new TextContent("note"),
                new ImageContent("image/png", PNG_BASE64),
                new ToolResultContent("c1", "Attached red.png", false)));

        assertTrue(blocks.get(0).isToolResult(), "tool_result must lead");
        assertTrue(blocks.get(1).isImage(), "the image follows the results");
        assertEquals("note", blocks.get(2).asText().text());
    }

    @Test
    void allFourSupportedMediaTypesMapCleanly() {
        for (String mediaType : List.of("image/jpeg", "image/png", "image/webp", "image/gif")) {
            List<ContentBlockParam> blocks = AnthropicProvider.toAnthropicContent(
                    List.<ProviderContent>of(new ImageContent(mediaType, PNG_BASE64)));
            assertEquals(mediaType,
                    blocks.getFirst().asImage().source().asBase64().mediaType().asString());
        }
    }

    // ---- prompt caching (buildParams is static + client-free, so key-free) ----

    private static ProviderRequest requestWith(List<LlmProvider.ProviderMessage> messages) {
        return new ProviderRequest("You are spectroscope.", messages,
                List.of(new ToolSpec("read_file", "reads a file", JSON.createObjectNode()),
                        new ToolSpec("write_file", "writes a file", JSON.createObjectNode())),
                4096, new CancelSignal());
    }

    @Test
    void cachingMarksSystemLastToolAndLastStableMessage() {
        // Two messages: a stable assistant turn ending in text, then the current user turn.
        var messages = List.of(
                new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent("Earlier answer."))),
                new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("Next question?"))));

        MessageCreateParams params = AnthropicProvider.buildParams("claude-opus-4-8", true, requestWith(messages));

        // System is a cached text block.
        var system = params.system().orElseThrow();
        assertTrue(system.isTextBlockParams(), "caching sends system as text blocks, not a string");
        assertTrue(system.asTextBlockParams().getFirst().cacheControl().isPresent(),
                "the system block carries cache_control");
        assertEquals("You are spectroscope.", system.asTextBlockParams().getFirst().text());

        // Only the LAST tool carries the system+tools breakpoint.
        var tools = params.tools().orElseThrow();
        assertFalse(tools.getFirst().asTool().cacheControl().isPresent(), "first tool is not the breakpoint");
        assertTrue(tools.getLast().asTool().cacheControl().isPresent(), "the last tool carries cache_control");

        // The last STABLE message (index 0, before the current turn) is cached on its last block.
        var stableBlocks = params.messages().get(0).content().asBlockParams();
        assertTrue(stableBlocks.getLast().asText().cacheControl().isPresent(),
                "the last stable message carries a message-level cache breakpoint");
        var currentBlocks = params.messages().get(1).content().asBlockParams();
        assertFalse(currentBlocks.getLast().asText().cacheControl().isPresent(),
                "the current turn is never cached (it changes every request)");
    }

    @Test
    void cachingDisabledSendsAPlainSystemStringAndNoBreakpoints() {
        MessageCreateParams params = AnthropicProvider.buildParams("claude-opus-4-8", false,
                requestWith(List.of(new ProviderMessage(
                        ProviderMessage.Role.USER, List.of(new TextContent("Hi"))))));

        assertTrue(params.system().orElseThrow().isString(), "no caching: system is a plain string");
        assertFalse(params.tools().orElseThrow().getLast().asTool().cacheControl().isPresent());
    }

    // ---- extended thinking: the request shape is model-dependent ----------

    private static ProviderRequest thinkingRequest() {
        return new ProviderRequest("You are spectroscope.",
                List.of(new ProviderMessage(ProviderMessage.Role.USER,
                        List.of(new TextContent("Hi")))),
                List.of(), 4096, true, new CancelSignal());
    }

    @Test
    void currentGenerationModelsRequestAdaptiveThinking() {
        // The default claude-opus-4-8 REJECTS thinking.type=enabled with
        // HTTP 400 — the 4.6+ generation speaks adaptive thinking only.
        MessageCreateParams params = AnthropicProvider.buildParams(
                "claude-opus-4-8", false, thinkingRequest());

        var thinking = params.thinking().orElseThrow();
        assertTrue(thinking.isAdaptive(), "opus-4-8 must request adaptive thinking");
        assertEquals(ThinkingConfigAdaptive.Display.SUMMARIZED,
                thinking.asAdaptive().display().orElseThrow(),
                "on 4.7+ the display default is omitted (EMPTY thinking text) — "
                        + "the harness must opt into the summarized stream");
    }

    @Test
    void legacyModelsKeepTheTokenBudgetShape() {
        // Haiku 4.5 (and the 4.5/4.1/4.0/3.x families) predate adaptive
        // thinking — they still require {type: enabled, budget_tokens}.
        MessageCreateParams params = AnthropicProvider.buildParams(
                "claude-haiku-4-5", false, thinkingRequest());

        var thinking = params.thinking().orElseThrow();
        assertTrue(thinking.isEnabled(), "haiku-4-5 keeps the legacy budget shape");
        assertEquals(AnthropicProvider.THINKING_BUDGET, thinking.asEnabled().budgetTokens());
    }

    @Test
    void unknownModelNamesDefaultToAdaptiveThinking() {
        // Every model released since the 4.6 generation speaks adaptive; the
        // budget shape is the closed legacy set, so unknown names go adaptive.
        MessageCreateParams params = AnthropicProvider.buildParams(
                "claude-opus-5", false, thinkingRequest());

        assertTrue(params.thinking().orElseThrow().isAdaptive());
    }

    @Test
    void thinkingOffOmitsTheParameterEntirely() {
        // Omission is the one universally safe "off": an explicit disabled is
        // rejected by some models, and omission runs without thinking on 4.7+.
        MessageCreateParams params = AnthropicProvider.buildParams("claude-opus-4-8", false,
                requestWith(List.of(new ProviderMessage(
                        ProviderMessage.Role.USER, List.of(new TextContent("Hi"))))));

        assertTrue(params.thinking().isEmpty(), "thinking=false must not send the field");
    }

    @Test
    void usageKeepsRawInputTokensAndCarriesCacheCountsSeparately() {
        // A cache hit must NOT inflate the wire-facing inputTokens; the cache
        // counts ride their own PUsage fields for the compaction trigger.
        LlmProvider.PUsage cached = AnthropicProvider.usageEvent(
                100L, 7L, java.util.Optional.of(1200L), java.util.Optional.of(200L));
        assertEquals(100, cached.inputTokens());
        assertEquals(7, cached.outputTokens());
        assertEquals(1200, cached.cacheReadTokens());
        assertEquals(200, cached.cacheCreationTokens());

        // No cache fields present (cold call / non-cached response): zeros ride along.
        LlmProvider.PUsage plain = AnthropicProvider.usageEvent(
                100L, 7L, java.util.Optional.empty(), java.util.Optional.empty());
        assertEquals(100, plain.inputTokens());
        assertEquals(0, plain.cacheReadTokens());
        assertEquals(0, plain.cacheCreationTokens());
    }
}
