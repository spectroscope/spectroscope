package dev.spectroscope.core.provider;

import com.anthropic.client.AnthropicClient;
import com.anthropic.client.okhttp.AnthropicOkHttpClient;
import com.anthropic.core.JsonValue;
import com.anthropic.core.http.StreamResponse;
import com.anthropic.helpers.MessageAccumulator;
import com.anthropic.models.messages.Base64ImageSource;
import com.anthropic.models.messages.CacheControlEphemeral;
import com.anthropic.models.messages.ContentBlock;
import com.anthropic.models.messages.ContentBlockParam;
import com.anthropic.models.messages.ImageBlockParam;
import com.anthropic.models.messages.Message;
import com.anthropic.models.messages.MessageCreateParams;
import com.anthropic.models.messages.MessageParam;
import com.anthropic.models.messages.RawMessageStreamEvent;
import com.anthropic.models.messages.TextBlockParam;
import com.anthropic.models.messages.ThinkingConfigAdaptive;
import com.anthropic.models.messages.ThinkingConfigEnabled;
import com.anthropic.models.messages.Tool;
import com.anthropic.models.messages.ToolResultBlockParam;
import com.anthropic.models.messages.ToolUseBlockParam;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.provider.LlmProvider.PStop.StopReason;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.Iterator;
import java.util.List;
import java.util.NoSuchElementException;

/**
 * The first {@link LlmProvider}: wraps {@code com.anthropic:anthropic-java}. It is the
 * only class in the core that touches the SDK; everything else speaks the neutral
 * provider records. An {@code OllamaProvider} sits behind the same interface,
 * without any change to the agent loop.
 *
 * <p><b>Laziness matters here:</b> the returned iterable translates SDK stream events
 * on demand instead of collecting them into a list first. Text deltas therefore reach
 * the consumer while the HTTP stream is still running — that is what makes the
 * token-by-token rendering work end to end. (The printed blueprint listing buffered
 * the whole turn; improved deliberately, see design/blueprints/stage-03.md.)</p>
 */
public final class AnthropicProvider implements LlmProvider {

    // Static: the content mapping below is a pure function and unit-tested
    // without a client (constructing one requires ANTHROPIC_API_KEY).
    private static final ObjectMapper JSON = new ObjectMapper();

    // maxRetries(0): spectroscope owns retry uniformly via RetryingProvider — no layered SDK retry.
    private final AnthropicClient client =
            AnthropicOkHttpClient.builder().fromEnv().maxRetries(0).build();
    private final String model;
    private final boolean promptCaching;

    /**
     * Builds the provider; the API key comes from the environment (SDK
     * {@code fromEnv()}), so constructing one requires ANTHROPIC_API_KEY.
     *
     * @param model         the model id every request is sent to (e.g. claude-opus-4-8)
     * @param promptCaching true to place cache_control breakpoints (see {@link #buildParams})
     */
    public AnthropicProvider(String model, boolean promptCaching) {
        this.model = model;
        this.promptCaching = promptCaching;
    }

    /**
     * Opens one streaming SDK call per iteration — the returned iterable is lazy,
     * events are translated while the HTTP stream is still running.
     *
     * @param request the provider-neutral turn input (system, history, tools, budget)
     * @return a lazy iterable; each {@code iterator()} call starts a fresh HTTP stream
     */
    @Override
    public Iterable<ProviderEvent> stream(ProviderRequest request) {
        return () -> new TranslatingIterator(request);
    }

    /**
     * Pulls SDK events one at a time and translates them into neutral
     * {@link ProviderEvent}s: one {@link PTextDelta} per text delta while streaming;
     * then, when the SDK stream is exhausted, the tool calls, one {@link PUsage} and
     * one {@link PStop} from the accumulated final message (usage and fully parsed
     * tool inputs only exist there — the classic trap).
     */
    private final class TranslatingIterator implements Iterator<ProviderEvent> {

        private final ProviderRequest request;
        private final StreamResponse<RawMessageStreamEvent> response;
        private final Iterator<RawMessageStreamEvent> sdkEvents;
        private final MessageAccumulator accumulator = MessageAccumulator.create();
        private final Deque<ProviderEvent> pending = new ArrayDeque<>();
        private boolean finished = false;

        /**
         * Starts the streaming HTTP call and hooks the cancel signal onto it.
         *
         * @param request the neutral request to translate into SDK params
         */
        private TranslatingIterator(ProviderRequest request) {
            this.request = request;
            this.response = client.messages().createStreaming(
                    buildParams(model, promptCaching, request));
            // Cancellation: closing the StreamResponse aborts the underlying HTTP stream.
            request.signal().onCancel(response::close);
            this.sdkEvents = response.stream().iterator();
        }

        /** Pulls SDK events until at least one neutral event is pending (or the stream ends). */
        @Override
        public boolean hasNext() {
            while (pending.isEmpty() && !finished) {
                advance();
            }
            return !pending.isEmpty();
        }

        /** Serves the next pending neutral event. */
        @Override
        public ProviderEvent next() {
            if (!hasNext()) {
                throw new NoSuchElementException();
            }
            return pending.poll();
        }

        /** Consumes one SDK event (or the stream end) and refills {@code pending}. */
        private void advance() {
            try {
                if (sdkEvents.hasNext()) {
                    RawMessageStreamEvent sdkEvent = sdkEvents.next();
                    accumulator.accumulate(sdkEvent);
                    sdkEvent.contentBlockDelta()
                            .flatMap(delta -> delta.delta().text())
                            .ifPresent(text -> pending.add(new PTextDelta(text.text())));
                    // Thinking-block deltas ride the same content_block_delta event,
                    // carrying a thinking (not text) delta — surface them separately.
                    sdkEvent.contentBlockDelta()
                            .flatMap(delta -> delta.delta().thinking())
                            .ifPresent(thinking -> pending.add(new PThinkingDelta(thinking.thinking())));
                    return;
                }

                // Natural end of the HTTP stream: emit the turn-level facts.
                Message message = accumulator.message();
                for (ContentBlock block : message.content()) {
                    block.toolUse().ifPresent(toolUse -> pending.add(new PToolCall(
                            toolUse.id(),
                            toolUse.name(),
                            JSON.valueToTree(toolUse._input()))));
                }
                pending.add(usageEvent(message.usage().inputTokens(),
                        message.usage().outputTokens(),
                        message.usage().cacheReadInputTokens(),
                        message.usage().cacheCreationInputTokens()));
                pending.add(new PStop(mapStopReason(message)));
                finished = true;
                response.close();
            } catch (RuntimeException streamError) {
                finished = true;
                closeQuietly();
                if (request.signal().isCancelled()) {
                    // A cancel that closed the stream surfaces as an SDK runtime error —
                    // report it as a clean abort, not a crash.
                    pending.add(new PStop(StopReason.ABORTED));
                    return;
                }
                throw streamError; // real errors propagate; the loop turns them into `error` events
            }
        }

        /** Closes the SDK stream on the error path without letting a secondary failure mask the original. */
        private void closeQuietly() {
            try {
                response.close();
            } catch (RuntimeException ignored) {
                // Closing an already-broken stream must not mask the original error.
            }
        }
    }

    /** A modest reasoning budget, capped so maxTokens always stays strictly larger. */
    static final int THINKING_BUDGET = 2048;

    /**
     * Model generations that predate adaptive thinking and still take the
     * {@code thinking.type=enabled} shape with a token budget: the 2.x/3.x
     * families, Haiku 4.5, Sonnet 4.5/4.0 and Opus 4.5/4.1/4.0 (the
     * {@code -4-2} prefixes cover the dated full ids like
     * {@code claude-opus-4-20250514} without touching 4.5/4.6+). Everything
     * else — Opus 4.6/4.7/4.8, Sonnet 4.6/5, Fable/Mythos 5 and every future
     * model — speaks adaptive thinking, and the current generation REJECTS
     * the budget shape with HTTP 400 ("thinking.type.enabled is not
     * supported for this model").
     */
    private static final List<String> BUDGET_THINKING_MODEL_PREFIXES = List.of(
            "claude-2", "claude-3",
            "claude-haiku-4-5",
            "claude-sonnet-4-5", "claude-sonnet-4-0", "claude-sonnet-4-2",
            "claude-opus-4-5", "claude-opus-4-1", "claude-opus-4-0", "claude-opus-4-2");

    /**
     * Whether the given model still expects the legacy token-budget thinking
     * shape. Unknown names answer false: every model released since the 4.6
     * generation speaks adaptive thinking, so the legacy set is closed.
     *
     * @param model the model id as configured
     * @return true when the model predates adaptive thinking
     */
    static boolean usesLegacyThinkingBudget(String model) {
        return BUDGET_THINKING_MODEL_PREFIXES.stream().anyMatch(model::startsWith);
    }

    /**
     * The thinking budget for a given maxTokens: the modest default, but always
     * left below maxTokens (the API requires maxTokens &gt; budget). Returns 0 when
     * maxTokens is too small to fit any budget — the caller then omits thinking.
     *
     * @param maxTokens the request's completion budget the thinking budget must stay below
     * @return the budget in tokens, or 0 when thinking should be omitted
     */
    static int thinkingBudget(int maxTokens) {
        if (maxTokens <= 1) {
            return 0;
        }
        return Math.min(THINKING_BUDGET, maxTokens - 1);
    }

    /**
     * SDK usage → PUsage. {@code inputTokens} stays RAW — it feeds the wire-format
     * usage event, which must not change on a cache hit. The cache counts ride the
     * two extra PUsage fields so the loop folds them into its compaction trigger
     * only (see {@code Agent.contextTokens}).
     *
     * @param inputTokens   the RAW prompt token count as the API billed it
     * @param outputTokens  the completion token count
     * @param cacheRead     tokens served from the prompt cache, when the API reports them
     * @param cacheCreation tokens freshly written into the prompt cache, when reported
     * @return the neutral usage event, cache counts carried separately from the raw input
     */
    static PUsage usageEvent(long inputTokens, long outputTokens,
                             java.util.Optional<Long> cacheRead,
                             java.util.Optional<Long> cacheCreation) {
        return new PUsage((int) inputTokens, (int) outputTokens,
                cacheRead.orElse(0L).intValue(), cacheCreation.orElse(0L).intValue());
    }

    /**
     * Neutral request → SDK params. Package-private and static so it is unit-tested
     * without a client (constructing one needs ANTHROPIC_API_KEY). With caching on it
     * places two {@code cache_control} breakpoints (well within the SDK limit of 4):
     * one after system+tools (the last tool), one on the last STABLE message — the
     * message just before the current turn, which changes every request and is never
     * cached. A moved/missing breakpoint after compaction is harmless: caching is
     * best-effort and the index is recomputed fresh each call.
     *
     * @param model         the model id to request
     * @param promptCaching true to place the two cache_control breakpoints
     * @param request       the neutral request to translate
     * @return the fully built SDK params for one streaming call
     */
    static MessageCreateParams buildParams(String model, boolean promptCaching,
                                            ProviderRequest request) {
        MessageCreateParams.Builder builder = MessageCreateParams.builder()
                .model(model)
                .maxTokens((long) request.maxTokens());

        if (promptCaching) {
            builder.systemOfTextBlockParams(List.of(TextBlockParam.builder()
                    .text(request.system())
                    .cacheControl(CacheControlEphemeral.builder().build())
                    .build()));
        } else {
            builder.system(request.system());
        }

        // Extended thinking — the shape is model-dependent. The current
        // generation (Opus 4.6+, Sonnet 4.6/5, Fable) speaks adaptive thinking
        // and rejects the old token-budget shape with HTTP 400; the legacy
        // families still take {type: enabled, budget_tokens}. Display is pinned
        // to "summarized": on 4.7+ the default flipped to "omitted", which
        // would stream EMPTY thinking blocks and silently blank the thinking
        // panel. Temperature stays unset (thinking rejects sampling
        // parameters); the streamed deltas become PThinkingDelta above.
        if (request.thinking()) {
            if (usesLegacyThinkingBudget(model)) {
                int budget = thinkingBudget(request.maxTokens());
                if (budget > 0) {
                    builder.thinking(ThinkingConfigEnabled.builder()
                            .budgetTokens(budget)
                            .build());
                }
            } else {
                builder.thinking(ThinkingConfigAdaptive.builder()
                        .display(ThinkingConfigAdaptive.Display.SUMMARIZED)
                        .build());
            }
        }

        List<ProviderMessage> messages = request.messages();
        int stableIndex = promptCaching ? messages.size() - 2 : -1; // last message before the current turn
        for (int i = 0; i < messages.size(); i++) {
            ProviderMessage message = messages.get(i);
            List<ContentBlockParam> blocks = toAnthropicContent(message.content());
            if (i == stableIndex && !blocks.isEmpty()) {
                blocks = new ArrayList<>(blocks);
                blocks.set(blocks.size() - 1, withCacheControl(blocks.getLast()));
            }
            builder.addMessage(MessageParam.builder()
                    .role(message.role() == ProviderMessage.Role.USER
                            ? MessageParam.Role.USER : MessageParam.Role.ASSISTANT)
                    .contentOfBlockParams(blocks)
                    .build());
        }

        List<ToolSpec> tools = request.tools();
        for (int i = 0; i < tools.size(); i++) {
            ToolSpec spec = tools.get(i);
            Tool.Builder tool = Tool.builder()
                    .name(spec.name())
                    .description(spec.description())
                    .inputSchema(toSchema(spec.inputSchema()));
            if (promptCaching && i == tools.size() - 1) {
                tool.cacheControl(CacheControlEphemeral.builder().build());
            }
            builder.addTool(tool.build());
        }
        return builder.build();
    }

    /**
     * Adds a cache breakpoint to a content block (text / tool_result); other kinds pass through.
     *
     * @param block the block chosen as the last stable message's breakpoint
     * @return a copy carrying cache_control, or the block itself for unsupported kinds
     */
    private static ContentBlockParam withCacheControl(ContentBlockParam block) {
        CacheControlEphemeral cache = CacheControlEphemeral.builder().build();
        if (block.isText()) {
            return ContentBlockParam.ofText(TextBlockParam.builder()
                    .text(block.asText().text())
                    .cacheControl(cache)
                    .build());
        }
        if (block.isToolResult()) {
            return ContentBlockParam.ofToolResult(block.asToolResult().toBuilder()
                    .cacheControl(cache)
                    .build());
        }
        return block; // image / other: best-effort, skip the message breakpoint
    }

    /**
     * Maps the provider-neutral content pieces onto SDK content blocks:
     * image blocks belong BEFORE the text of the same user message — the order
     * the vision prompt guidance expects. Package-private and static: the pure
     * mapping is unit-tested without a client (and therefore without a key).
     *
     * @param content the neutral content pieces of one message
     * @return the SDK content blocks, image blocks reordered to the front
     */
    static List<ContentBlockParam> toAnthropicContent(List<ProviderContent> content) {
        // API-required order inside one user message: tool_result blocks FIRST
        // (the Messages API rejects anything before them when answering tool
        // use — view_image/view_file attach to that very message), then images,
        // then documents, before the text (the vision prompt guidance from
        // extended by file_upload).
        List<ProviderContent> ordered = new ArrayList<>();
        for (ProviderContent piece : content) {
            if (piece instanceof ToolResultContent) {
                ordered.add(piece);
            }
        }
        for (ProviderContent piece : content) {
            if (piece instanceof ImageContent) {
                ordered.add(piece);
            }
        }
        for (ProviderContent piece : content) {
            if (piece instanceof LlmProvider.DocumentContent) {
                ordered.add(piece);
            }
        }
        for (ProviderContent piece : content) {
            if (!(piece instanceof ImageContent) && !(piece instanceof ToolResultContent)
                    && !(piece instanceof LlmProvider.DocumentContent)) {
                ordered.add(piece);
            }
        }
        List<ContentBlockParam> blocks = new ArrayList<>();
        for (ProviderContent piece : ordered) {
            ContentBlockParam block = switch (piece) {
                case TextContent text -> ContentBlockParam.ofText(
                        TextBlockParam.builder().text(text.text()).build());
                case ImageContent image -> ContentBlockParam.ofImage(
                        ImageBlockParam.builder()
                                .source(Base64ImageSource.builder()
                                        .mediaType(Base64ImageSource.MediaType.of(image.mediaType()))
                                        .data(image.dataBase64())
                                        .build())
                                .build());
                case ToolCallContent call -> ContentBlockParam.ofToolUse(
                        ToolUseBlockParam.builder()
                                .id(call.callId())
                                .name(call.name())
                                .input(toJsonValue(call.input()))
                                .build());
                case ToolResultContent result -> ContentBlockParam.ofToolResult(
                        ToolResultBlockParam.builder()
                                .toolUseId(result.callId())
                                .content(result.output())
                                .isError(result.isError())
                                .build());
                case LlmProvider.DocumentContent document -> ContentBlockParam.ofDocument(
                        com.anthropic.models.messages.DocumentBlockParam.builder()
                                .source(com.anthropic.models.messages.Base64PdfSource.builder()
                                        .data(document.dataBase64())
                                        .build())
                                .build());
            };
            blocks.add(block);
        }
        return blocks;
    }

    /**
     * A JSON-Schema JsonNode -> the SDK's schema type (properties + required are copied over).
     *
     * @param node the tool's JSON-Schema input definition
     * @return the SDK schema carrying the same properties and required list
     */
    private static Tool.InputSchema toSchema(JsonNode node) {
        Tool.InputSchema.Builder schema = Tool.InputSchema.builder();
        if (node.has("properties")) {
            schema.properties(JsonValue.from(JSON.convertValue(node.get("properties"), Object.class)));
        }
        if (node.has("required")) {
            schema.putAdditionalProperty("required",
                    JsonValue.from(JSON.convertValue(node.get("required"), Object.class)));
        }
        return schema.build();
    }

    /**
     * A JsonNode -> the SDK's untyped JSON value.
     *
     * @param node the Jackson tree to convert
     * @return the equivalent SDK JsonValue
     */
    private static JsonValue toJsonValue(JsonNode node) {
        return JsonValue.from(JSON.convertValue(node, Object.class));
    }

    /**
     * Maps the SDK's stop reason onto the neutral enum — anything unknown or
     * absent counts as a regular end of turn.
     *
     * @param message the accumulated final message
     * @return the neutral stop reason
     */
    private StopReason mapStopReason(Message message) {
        return message.stopReason()
                .map(reason -> switch (reason.value()) {
                    case TOOL_USE -> StopReason.TOOL_USE;
                    case MAX_TOKENS -> StopReason.MAX_TOKENS;
                    default -> StopReason.END_TURN;
                })
                .orElse(StopReason.END_TURN);
    }
}
