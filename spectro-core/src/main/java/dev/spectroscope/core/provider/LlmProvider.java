package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.wire.LlmWireTap;

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
    /** The model id serving requests, or null when unknown — {@code run_start}
     *  stamps it (additive, card 87) so every run records what answered it.
     *  A {@link SwitchableProvider} reports its LIVE delegate's model. */
    default String modelName() {
        return null;
    }

    default String providerName() {
        return null;
    }

    /**
     * The server root this provider was BUILT with, or {@code null} when it has
     * no address to name — anthropic's is fixed in the SDK, and the built-in
     * runtime is a subprocess rather than a host.
     *
     * <p>Card 193: a face that prints "unreachable at …" must print the address
     * the run really dials. Reading a config field back is a second copy of
     * that fact, and since ollama and LM Studio grew their own addresses the
     * two disagree — the CLI banner named {@code localhost} about a probe that
     * had gone to another machine. The decorators (retry, logging proxy,
     * tracing, the mid-session switch) all forward this, so the value survives
     * the wrappers the faces actually hold.</p>
     *
     * @return the base url this provider dials, or null when it names none
     */
    default String endpoint() {
        return null;
    }

    /**
     * What this provider knows about its model's ability to SEE, asked BEFORE
     * the request is built (card 252).
     *
     * <p>The wedge this answers: a pasted screenshot at a model without image
     * support came back as an HTTP 400, and since the image lives in the agent's
     * history it was re-sent on every later turn — so every later prompt failed
     * the same way and the session was finished. The knowledge to prevent that
     * existed already, one layer too low: ollama's {@code /api/show} probe sat
     * inside {@code OllamaProvider} and fired only on an image-bearing request.
     * This method lifts the same question to where the request is assembled.</p>
     *
     * <p><b>{@code UNKNOWN} means send.</b> Withholding on a guess would blind
     * every vision-capable model the harness cannot interrogate, and there is no
     * portable capability endpoint on the OpenAI wire — {@code /v1/models} lists
     * ids, not what they accept. So the safe direction is the permissive one:
     * only a provider that can actually answer {@code BLIND} — a capability
     * probe, or the server's own refusal, remembered — makes the fence close.
     * A static table of model names would be invented knowledge with a shelf
     * life, and this house has paid for one of those before.</p>
     *
     * @return SEES, BLIND, or UNKNOWN when nothing is known; never null
     */
    default Vision vision() {
        return Vision.UNKNOWN;
    }

    /**
     * How many tokens the instance that will serve the next request can hold —
     * asked once per run, before the first token flows (card 263).
     *
     * <p>The wedge this answers: the harness compacted at a literal 100,000
     * whatever the backend offered, so a session on a model loaded with 204,288
     * summarized half its context away for nothing, and one loaded with 8,192
     * was never compacted at all until the server truncated it silently.</p>
     *
     * <p><b>0 means "nothing known", never "no room".</b> The number wanted here
     * is the LOADED window and not the model's ceiling: LM Studio states both —
     * a model whose {@code max_context_length} is 1,048,576 loaded at 204,288 —
     * and reporting the ceiling would push compaction past the window the server
     * actually holds, which is the one direction worse than the constant. A
     * provider that cannot ask (anthropic has no such endpoint; the OpenAI wire
     * has none either) answers 0 and lands on the documented fallback.</p>
     *
     * @return the usable context window in tokens, or 0 when nothing is known
     */
    default int contextWindow() {
        return 0;
    }

    /** What is known about a model's sight. {@code UNKNOWN} is NOT {@code BLIND}:
     *  the first sends the image and lets the provider answer, the second is the
     *  only state that makes the harness keep an attachment back. */
    enum Vision { SEES, BLIND, UNKNOWN }

    // ---- request ----------------------------------------------------------

    /**
     * Everything one model call needs — the loop assembles it fresh per turn.
     *
     * @param system    the system prompt sent with every request
     * @param messages  the conversation history, oldest first
     * @param tools     the tools advertised to the model (may be empty)
     * @param maxTokens the completion budget for this call
     * @param reasoning what this call site says about the model's own reasoning
     * @param effort    the requested reasoning effort level, or null for the
     *                  model's default — providers spend it only where their
     *                  {@link ReasoningCapability} lists the value
     * @param signal    cooperative cancel — firing it aborts the open stream
     * @param tap       where the provider records the REAL exchange (card 184);
     *                  null records nothing and keeps the call byte-identical
     */
    record ProviderRequest(String system, List<ProviderMessage> messages,
                           List<ToolSpec> tools, int maxTokens, Reasoning reasoning,
                           String effort, CancelSignal signal, LlmWireTap tap) {

        /** A missing answer is the same as no answer: leave it to the model. */
        public ProviderRequest {
            reasoning = reasoning == null ? Reasoning.DEFAULT : reasoning;
            effort = effort == null || effort.isBlank() ? null : effort;
        }

        /**
         * Tap-free request — every call site that predates the llm-wire record.
         *
         * @param system    the system prompt sent with every request
         * @param messages  the conversation history, oldest first
         * @param tools     the tools advertised to the model (may be empty)
         * @param maxTokens the completion budget for this call
         * @param reasoning what this call site says about the model's own reasoning
         * @param effort    the requested reasoning effort level, or null
         * @param signal    cooperative cancel — firing it aborts the open stream
         */
        public ProviderRequest(String system, List<ProviderMessage> messages,
                               List<ToolSpec> tools, int maxTokens, Reasoning reasoning,
                               String effort, CancelSignal signal) {
            this(system, messages, tools, maxTokens, reasoning, effort, signal, null);
        }

        /**
         * Effort-free request — every call site that predates the effort dial.
         *
         * @param system    the system prompt sent with every request
         * @param messages  the conversation history, oldest first
         * @param tools     the tools advertised to the model (may be empty)
         * @param maxTokens the completion budget for this call
         * @param reasoning what this call site says about the model's own reasoning
         * @param signal    cooperative cancel — firing it aborts the open stream
         */
        public ProviderRequest(String system, List<ProviderMessage> messages,
                               List<ToolSpec> tools, int maxTokens, Reasoning reasoning,
                               CancelSignal signal) {
            this(system, messages, tools, maxTokens, reasoning, null, signal);
        }

        /**
         * The thinking toggle as the agent loop states it: on, or nothing said.
         *
         * @param system    the system prompt sent with every request
         * @param messages  the conversation history, oldest first
         * @param tools     the tools advertised to the model (may be empty)
         * @param maxTokens the completion budget for this call
         * @param thinking  true to request the model's reasoning stream as well
         * @param signal    cooperative cancel — firing it aborts the open stream
         */
        public ProviderRequest(String system, List<ProviderMessage> messages,
                               List<ToolSpec> tools, int maxTokens, boolean thinking,
                               CancelSignal signal) {
            this(system, messages, tools, maxTokens,
                    thinking ? Reasoning.ON : Reasoning.DEFAULT, signal);
        }

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
            this(system, messages, tools, maxTokens, Reasoning.DEFAULT, signal);
        }

        /**
         * @return true only when this call asked the model to reason
         */
        public boolean thinking() {
            return reasoning == Reasoning.ON;
        }

        /**
         * What a call site says about the model's own reasoning. {@code DEFAULT}
         * and {@code OFF} are NOT the same request: DEFAULT says nothing and
         * leaves the choice with the model, which is the only honest default for
         * one that reasons unconditionally (gpt-oss); OFF spends the provider's
         * explicit off switch, which a mechanical transformation needs because
         * its completion budget caps reasoning and answer TOGETHER — a model
         * that reasons its way through the whole budget returns nothing at all.
         */
        public enum Reasoning { DEFAULT, ON, OFF }
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
