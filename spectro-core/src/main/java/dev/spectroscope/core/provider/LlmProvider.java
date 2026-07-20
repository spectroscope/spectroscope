package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.CancelSignal;

import java.util.List;

/**
 * The narrow contract the agent loop talks to instead of any concrete SDK. Two
 * implementations: {@link AnthropicProvider} and an
 * {@code OllamaProvider} — plugged in <b>without changing the loop</b>.
 */
public interface LlmProvider {

    /**
     * Blocking iterable — consumed with for-each inside the agent loop.
     *
     * @param request the full turn input: system prompt, history, tools, budget, cancel signal
     * @return a lazy event stream; each {@code iterator()} starts one model call
     */
    Iterable<ProviderEvent> stream(ProviderRequest request);

    /**
     * Optional live provider label for the {@code run_start} event. Most providers
     * return {@code null} (the Agent falls back to the build-time name); a
     * {@link SwitchableProvider} reports the currently selected provider so a
     * mid-session switch is reflected accurately in the event stream and JSONL.
     *
     * @return the live provider label, or null to keep the build-time name
     */
    default String providerName() {
        return null;
    }

    // ---- request ----------------------------------------------------------

    /**
     * Everything one model call needs — the loop assembles it fresh per turn.
     *
     * @param system    the system prompt sent with every request
     * @param messages  the conversation history, oldest first
     * @param tools     the tools advertised to the model (may be empty)
     * @param maxTokens the completion budget for this call
     * @param thinking  true to request the model's reasoning stream as well
     * @param signal    cooperative cancel — firing it aborts the open stream
     */
    record ProviderRequest(String system, List<ProviderMessage> messages,
                           List<ToolSpec> tools, int maxTokens, boolean thinking,
                           CancelSignal signal) {

        /**
         * Backwards-compatible constructor: thinking off (pre-thinking call sites).
         *
         * @param system    the system prompt sent with every request
         * @param messages  the conversation history, oldest first
         * @param tools     the tools advertised to the model (may be empty)
         * @param maxTokens the completion budget for this call
         * @param signal    cooperative cancel — firing it aborts the open stream
         */
        public ProviderRequest(String system, List<ProviderMessage> messages,
                               List<ToolSpec> tools, int maxTokens, CancelSignal signal) {
            this(system, messages, tools, maxTokens, false, signal);
        }
    }

    /**
     * One history entry — a role plus its ordered content pieces.
     *
     * @param role    who authored the message (tool results ride the USER side)
     * @param content the message's pieces, in wire order
     */
    record ProviderMessage(Role role, List<ProviderContent> content) {
        /** The two roles every provider wire format shares. */
        public enum Role { USER, ASSISTANT }
    }

    // ---- content (provider-neutral, sealed) -------------------------------

    /** One piece of message content — the provider-neutral superset of all three wire formats. */
    sealed interface ProviderContent
            permits TextContent, ToolCallContent, ToolResultContent, ImageContent,
                    DocumentContent {}

    /**
     * Plain text — an answer piece or the user's prompt.
     *
     * @param text the text exactly as typed/streamed, no trimming
     */
    record TextContent(String text) implements ProviderContent {}
    /**
     * A tool invocation the model requested — legal on assistant messages only.
     *
     * @param callId the provider's call id, pairing the call with its result
     * @param name   the tool to invoke
     * @param input  the parsed JSON arguments (never string-matched)
     */
    record ToolCallContent(String callId, String name, JsonNode input) implements ProviderContent {}      // assistant only
    /**
     * The outcome of one tool call, fed back on the user side of the history.
     *
     * @param callId  the id of the call this result answers
     * @param output  the tool's textual output (or its error text)
     * @param isError true when the tool failed — the model sees the flag
     */
    record ToolResultContent(String callId, String output, boolean isError) implements ProviderContent {} // user only
    /**
     * An image attachment as base64 (vision).
     *
     * @param mediaType  the IANA media type, e.g. image/png
     * @param dataBase64 the raw bytes base64-encoded, without any data: prefix
     */
    record ImageContent(String mediaType, String dataBase64) implements ProviderContent {}
    /**
     * A document attachment as base64 (file_upload: view_file). Rides the
     * provider history only, exactly like images — never the JSONL.
     *
     * @param mediaType  the IANA media type, e.g. application/pdf
     * @param dataBase64 the raw bytes base64-encoded, without any data: prefix
     * @param name       the file name shown to providers that carry one (openai)
     */
    record DocumentContent(String mediaType, String dataBase64, String name)
            implements ProviderContent {}                                                                 // file_upload

    // ---- events (what the loop consumes) ----------------------------------

    /** One neutral streaming event — everything the agent loop consumes from a provider. */
    sealed interface ProviderEvent permits PTextDelta, PThinkingDelta, PToolCall, PUsage, PStop {}

    /**
     * One streamed answer fragment.
     *
     * @param text the delta exactly as the model streamed it
     */
    record PTextDelta(String text) implements ProviderEvent {}
    /**
     * One streamed reasoning fragment — a sibling of {@link PTextDelta}: reasoning, not answer.
     *
     * @param text the thinking delta exactly as streamed
     */
    record PThinkingDelta(String text) implements ProviderEvent {} // sibling of PTextDelta — reasoning, not answer
    /**
     * A complete tool call — emitted once the input JSON is fully assembled.
     *
     * @param callId the provider's id (or a generated one), pairing call and result
     * @param name   the tool the model wants to run
     * @param input  the fully parsed JSON arguments
     */
    record PToolCall(String callId, String name, JsonNode input) implements ProviderEvent {}
    /** {@code inputTokens} is the provider's RAW count — it feeds the wire-format
     *  usage event, which must stay byte-identical on the wire. Cache
     *  tokens ride along separately so the loop can fold them into its
     *  compaction trigger (a cache hit shrinks inputTokens, not the context).
     *
     *  @param inputTokens         the RAW prompt token count as the provider billed it
     *  @param outputTokens        the completion token count
     *  @param cacheReadTokens     tokens served from the prompt cache (0 without caching)
     *  @param cacheCreationTokens tokens freshly written into the prompt cache (0 without caching)
     */
    record PUsage(int inputTokens, int outputTokens,
                  int cacheReadTokens, int cacheCreationTokens) implements ProviderEvent {
        /**
         * Compat: no cache tokens (ollama/openai).
         *
         * @param inputTokens  the RAW prompt token count
         * @param outputTokens the completion token count
         */
        public PUsage(int inputTokens, int outputTokens) {
            this(inputTokens, outputTokens, 0, 0);
        }
    }
    /**
     * The turn's terminal event — always the last event of a well-formed stream.
     *
     * @param reason why the model (or a cancel) ended the turn
     */
    record PStop(StopReason reason) implements ProviderEvent {
        /** The neutral stop reasons; ABORTED marks a cooperative cancel, not a model decision. */
        public enum StopReason { END_TURN, TOOL_USE, MAX_TOKENS, ABORTED }
    }

    // ---- tool advertisement ----------------------------------------------

    /**
     * One tool as advertised to the model.
     *
     * @param name        the tool's wire name
     * @param description what the model reads to decide when to call the tool
     * @param inputSchema the JSON-Schema of the tool's arguments
     */
    record ToolSpec(String name, String description, JsonNode inputSchema) {}
}
