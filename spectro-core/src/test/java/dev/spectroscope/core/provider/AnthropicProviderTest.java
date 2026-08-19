package dev.spectroscope.core.provider;

import com.anthropic.models.messages.ContentBlockParam;
import com.anthropic.models.messages.MessageCreateParams;
import com.anthropic.models.messages.ThinkingConfigAdaptive;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.provider.LlmProvider.ImageContent;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.PToolCall;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolCallContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
import dev.spectroscope.core.wire.LlmWireTap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The Anthropic content mapping, proven WITHOUT a client: the
 * mapping is a pure static function, so no ANTHROPIC_API_KEY and no network
 * are needed. The streaming translation itself is covered by the agent tests
 * against a fake provider; this class pins the SDK block shapes — above all
 * that an image becomes a base64 image block placed BEFORE the text.
 *
 * <p>The one exception is {@link WireCapture}: the llm-wire tap records what
 * the SDK posts and receives, and only a real streaming call against a
 * scripted loopback server (the {@code ReasoningWireTest} pattern, via the
 * package-private baseUrl constructor) can measure that record against the
 * actual bytes on the wire.</p>
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

    // ---- llm-wire capture: the SDK-owned exchange, measured on loopback ----

    @Nested
    class WireCapture {

        /** The SSE data payloads the loopback serves — the fidelity yardstick. */
        private static final List<String> SERVED_DATA = List.of(
                "{\"type\":\"message_start\",\"message\":{\"id\":\"msg_wire\",\"type\":\"message\","
                        + "\"role\":\"assistant\",\"model\":\"claude-opus-4-8\",\"content\":[],"
                        + "\"stop_reason\":null,\"stop_sequence\":null,"
                        + "\"usage\":{\"input_tokens\":12,\"output_tokens\":1}}}",
                "{\"type\":\"content_block_start\",\"index\":0,"
                        + "\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
                "{\"type\":\"content_block_delta\",\"index\":0,"
                        + "\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}",
                "{\"type\":\"content_block_delta\",\"index\":0,"
                        + "\"delta\":{\"type\":\"text_delta\",\"text\":\" there\"}}",
                "{\"type\":\"content_block_stop\",\"index\":0}",
                "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\","
                        + "\"stop_sequence\":null},\"usage\":{\"output_tokens\":2}}",
                "{\"type\":\"message_stop\"}");

        private HttpServer server;
        private String baseUrl;
        private final AtomicReference<String> receivedBody = new AtomicReference<>();

        @BeforeEach
        void scriptedSseServer() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", exchange -> {
                receivedBody.set(new String(exchange.getRequestBody().readAllBytes(),
                        StandardCharsets.UTF_8));
                StringBuilder sse = new StringBuilder();
                for (String data : SERVED_DATA) {
                    String name = JSON.readTree(data).get("type").asText();
                    sse.append("event: ").append(name).append('\n')
                            .append("data: ").append(data).append("\n\n");
                }
                byte[] bytes = sse.toString().getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
                exchange.sendResponseHeaders(200, bytes.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(bytes);
                }
            });
            server.start();
            baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
        }

        @AfterEach
        void stop() {
            server.stop(0);
        }

        /** Collects everything the provider hands the tap. */
        private static final class RecordingTap implements LlmWireTap {
            WireRequest request;
            final List<String> lines = new ArrayList<>();
            WireOutcome outcome;

            @Override
            public Exchange begin(WireRequest request) {
                this.request = request;
                return new Exchange() {
                    @Override
                    public void line(String rawLine) {
                        lines.add(rawLine);
                    }

                    @Override
                    public void end(WireOutcome ended) {
                        outcome = ended;
                    }
                };
            }
        }

        private List<ProviderEvent> drained(LlmWireTap tap) {
            AnthropicProvider provider = new AnthropicProvider(
                    "claude-opus-4-8", false, "test-key", baseUrl);
            ProviderRequest request = new ProviderRequest("You are spectroscope.",
                    List.of(new ProviderMessage(ProviderMessage.Role.USER,
                            List.of(new TextContent("Hi")))),
                    List.of(), 512, ProviderRequest.Reasoning.DEFAULT, null,
                    new CancelSignal(), tap);
            List<ProviderEvent> events = new ArrayList<>();
            for (ProviderEvent event : provider.stream(request)) {
                events.add(event);
            }
            return events;
        }

        @Test
        void recordedRequestBodyIsByteEqualToWhatTheLoopbackReceived() {
            // BYTE equality held: the record serializes the same Body object
            // (plus stream:true) with the same SDK mapper the service posts
            // with — not merely JsonNode-equal, the identical string.
            RecordingTap tap = new RecordingTap();
            drained(tap);

            assertNotNull(tap.request, "begin() must fire at stream-open time");
            assertEquals(receivedBody.get(), tap.request.body(),
                    "the recorded request body must be the posted body, byte for byte");
            assertEquals("anthropic", tap.request.provider());
            assertEquals("claude-opus-4-8", tap.request.model());
            assertEquals("sdk", tap.request.transport());
            assertEquals("POST", tap.request.method());
            assertEquals(baseUrl + "/v1/messages", tap.request.url());
            assertEquals("sdk-json", tap.request.fidelity());
            assertNull(tap.request.headers(),
                    "the SDK owns the headers — the record must not fabricate any");
        }

        @Test
        void reconstructedDataLinesMatchTheServedSsePayloads() throws IOException {
            RecordingTap tap = new RecordingTap();
            drained(tap);

            assertEquals(SERVED_DATA.size() * 2, tap.lines.size(),
                    "one event: line and one data: line per served SSE event");
            for (int i = 0; i < SERVED_DATA.size(); i++) {
                String eventLine = tap.lines.get(2 * i);
                String dataLine = tap.lines.get(2 * i + 1);
                JsonNode served = JSON.readTree(SERVED_DATA.get(i));
                assertEquals("event: " + served.get("type").asText(), eventLine);
                assertTrue(dataLine.startsWith("data: "), "got: " + dataLine);
                // JsonNode equality: the SDK re-serializes the event, so field
                // ORDER may differ from the served bytes; the content must not.
                assertEquals(served, JSON.readTree(dataLine.substring("data: ".length())),
                        "reconstructed event " + i + " must carry the served payload");
            }

            assertNotNull(tap.outcome, "end() must fire on the natural finish");
            assertEquals("sdk-events", tap.outcome.fidelity());
            assertNull(tap.outcome.status(),
                    "the SDK's StreamResponse exposes no status — null, never a fabricated 200");
            assertNull(tap.outcome.body(), "streamed responses carry lines, not a body");
            assertFalse(tap.outcome.aborted());
            assertNull(tap.outcome.error());
            assertTrue(tap.outcome.ts() >= tap.request.ts(), "close stamps after send");
        }

        @Test
        void aNullTapRecordsNothingAndChangesNothing() {
            // The tap-free request must translate the identical stream — the
            // same deltas in the same order, ending in usage and stop.
            List<ProviderEvent> events = drained(null);

            assertEquals("Hello", ((PTextDelta) events.get(0)).text());
            assertEquals(" there", ((PTextDelta) events.get(1)).text());
            assertTrue(events.stream().anyMatch(event -> event instanceof PStop stop
                    && stop.reason() == PStop.StopReason.END_TURN));
        }

        @Test
        void anHttpErrorEndsTheExchangeWithStatusAndError() {
            // Rescript the loopback: a 400 before any SSE event. The request
            // line must be on record and the exchange must close with the
            // real status off the SDK's service exception.
            server.removeContext("/");
            server.createContext("/", exchange -> {
                receivedBody.set(new String(exchange.getRequestBody().readAllBytes(),
                        StandardCharsets.UTF_8));
                byte[] error = ("{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\","
                        + "\"message\":\"scripted\"}}").getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(400, error.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(error);
                }
            });

            RecordingTap tap = new RecordingTap();
            try {
                drained(tap);
            } catch (RuntimeException scripted) {
                // expected — the loopback answers 400 after the body arrived
            }

            assertNotNull(tap.request, "the request line precedes the failure");
            assertNotNull(tap.outcome, "an HTTP error still closes the exchange");
            assertEquals(400, tap.outcome.status());
            assertNotNull(tap.outcome.error());
            assertFalse(tap.outcome.aborted());
        }
    }

    /**
     * Card 283: a tool that takes no arguments. Measured on 2026-08-19 from
     * session {@code 20260819-160135-b651423f}: {@code launch_list} is the one
     * tool in the tree with an empty schema, so the model sends NO argument
     * JSON at all — a {@code tool_use} block with {@code input:{}} and a single
     * EMPTY {@code partial_json} delta. Every call that worked in that session
     * carried between 5 and 37 filled deltas; both that failed carried none.
     *
     * <p>The SDK accumulator then leaves the input absent, and serializing a
     * {@code JsonMissing} throws, which ends the whole run rather than the one
     * tool call. {@code OllamaProvider.parseArguments} already guards exactly
     * this for its own wire.</p>
     */
    @Nested
    class ToolCallWithoutArguments {

        /**
         * What the input_json_delta carries. The empty string is the real
         * capture; the accumulator builds the input from the DELTAS alone and
         * ignores what content_block_start carried, which a bite test proved.
         */
        private String servedDelta = "";

        /** The capture from the failing session, minus the fields not implicated. */
        private List<String> servedData() {
            return List.of(
                "{\"type\":\"message_start\",\"message\":{\"id\":\"msg_noargs\","
                        + "\"type\":\"message\",\"role\":\"assistant\","
                        + "\"model\":\"claude-opus-4-8\",\"content\":[],"
                        + "\"stop_reason\":null,\"stop_sequence\":null,"
                        + "\"usage\":{\"input_tokens\":22,\"output_tokens\":3}}}",
                "{\"type\":\"content_block_start\",\"index\":0,"
                        + "\"content_block\":{\"type\":\"tool_use\","
                        + "\"id\":\"toolu_01KjgnDE2PY29C2broetmT6h\","
                        + "\"name\":\"launch_list\",\"input\":{}}}",
                "{\"type\":\"content_block_delta\",\"index\":0,"
                        + "\"delta\":{\"type\":\"input_json_delta\","
                        + "\"partial_json\":\"" + servedDelta + "\"}}",
                "{\"type\":\"content_block_stop\",\"index\":0}",
                "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\","
                        + "\"stop_sequence\":null},\"usage\":{\"output_tokens\":61}}",
                "{\"type\":\"message_stop\"}");
        }

        private HttpServer server;
        private String baseUrl;

        @BeforeEach
        void scriptedSseServer() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", exchange -> {
                exchange.getRequestBody().readAllBytes();
                StringBuilder sse = new StringBuilder();
                for (String data : servedData()) {
                    String name = JSON.readTree(data).get("type").asText();
                    sse.append("event: ").append(name).append('\n')
                            .append("data: ").append(data).append("\n\n");
                }
                byte[] bytes = sse.toString().getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
                exchange.sendResponseHeaders(200, bytes.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(bytes);
                }
            });
            server.start();
            baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
        }

        @AfterEach
        void stop() {
            server.stop(0);
        }

        private List<ProviderEvent> drained() {
            AnthropicProvider provider = new AnthropicProvider(
                    "claude-opus-4-8", false, "test-key", baseUrl);
            ProviderRequest request = new ProviderRequest("You are spectroscope.",
                    List.of(new ProviderMessage(ProviderMessage.Role.USER,
                            List.of(new TextContent("start the app")))),
                    List.of(), 512, ProviderRequest.Reasoning.DEFAULT, null,
                    new CancelSignal(), null);
            List<ProviderEvent> events = new ArrayList<>();
            for (ProviderEvent event : provider.stream(request)) {
                events.add(event);
            }
            return events;
        }

        /**
         * The same block shape, but the delta carries the literal {@code null}
         * rather than nothing, so the accumulated value is a JSON null instead
         * of an absent one. Downstream every caller does {@code input.get(...)},
         * so a NullNode is as unusable as an exception is fatal.
         */
        @Test
        void aToolCallWhoseInputIsJsonNullAlsoArrivesWithAnEmptyObject() {
            servedDelta = "null";
            List<ProviderEvent> events = drained();

            PToolCall call = events.stream()
                    .filter(PToolCall.class::isInstance)
                    .map(PToolCall.class::cast)
                    .findFirst()
                    .orElseThrow(() -> new AssertionError(
                            "the tool call never arrived: " + events));

            assertTrue(call.input().isObject(),
                    "a null input must become an OBJECT, was " + call.input().getNodeType());
            assertTrue(call.input().isEmpty(),
                    "the object must be empty, was " + call.input());
        }

        @Test
        void aToolCallCarryingNoArgumentsArrivesWithAnEmptyObject() {
            List<ProviderEvent> events = drained();

            PToolCall call = events.stream()
                    .filter(PToolCall.class::isInstance)
                    .map(PToolCall.class::cast)
                    .findFirst()
                    .orElseThrow(() -> new AssertionError(
                            "the tool call never arrived: " + events));

            assertEquals("launch_list", call.name());
            assertEquals("toolu_01KjgnDE2PY29C2broetmT6h", call.callId());
            assertNotNull(call.input(), "an absent input must become a node, never null");
            assertTrue(call.input().isObject(),
                    "an absent input must become an OBJECT, was " + call.input().getNodeType());
            assertTrue(call.input().isEmpty(),
                    "the object must be empty, was " + call.input());
        }
    }
}
