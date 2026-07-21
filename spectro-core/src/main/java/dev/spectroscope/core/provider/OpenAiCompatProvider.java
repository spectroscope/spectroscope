package dev.spectroscope.core.provider;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Optional;

/**
 * The third {@link LlmProvider}: any OpenAI-compatible chat-completions server
 * (LM Studio, llama.cpp server, vLLM, ...). The same narrow
 * interface, a third wire format, still zero changes to the agent loop.
 *
 * <p>Speaks {@code POST /v1/chat/completions} with SSE streaming
 * ({@code data: {...}} lines, terminated by {@code data: [DONE]}) over Spring's
 * {@link RestClient}. Tool-call deltas arrive fragmented per index and are
 * assembled until the {@code finish_reason} closes the turn. Usage arrives in
 * the final chunk when {@code stream_options.include_usage} is set.</p>
 */
public final class OpenAiCompatProvider implements LlmProvider {

    /**
     * Constructor options for the provider.
     *
     * @param baseUrl the server root, e.g. http://localhost:1234 (a trailing slash is tolerated)
     * @param model   the model name requests are sent to
     * @param apiKey  optional — LM Studio and friends accept requests without one
     */
    public record Options(String baseUrl, String model, String apiKey) {}

    private static final ObjectMapper JSON = new ObjectMapper();

    private final RestClient http;
    private final String model;

    /** Kept for the wire decision: the cloud takes the modern completion cap. */
    private final String baseUrl;

    /**
     * Builds the provider; the Bearer header is attached only when a key is configured.
     *
     * @param options base URL (trailing slash stripped), model name and optional API key
     */
    public OpenAiCompatProvider(Options options) {
        // The JDK HttpClient transport, NOT the default HttpURLConnection one:
        // only the JDK client's close CANCELS a streaming response promptly, so
        // the stop button can interrupt a stalled stream instead of blocking on a
        // drain-for-reuse (see OllamaProvider for the full rationale).
        RestClient.Builder builder = RestClient.builder()
                .baseUrl(options.baseUrl().replaceAll("/$", ""))
                .requestFactory(new JdkClientHttpRequestFactory());
        if (options.apiKey() != null && !options.apiKey().isBlank()) {
            builder.defaultHeader("Authorization", "Bearer " + options.apiKey());
        }
        this.http = builder.build();
        this.model = options.model();
        this.baseUrl = options.baseUrl();
    }

    /**
     * Opens one SSE chat-completions stream per iteration — lazy like the other providers.
     *
     * @param request the provider-neutral turn input to translate onto the OpenAI wire
     * @return a lazy iterable; each {@code iterator()} call posts a fresh completion
     */
    @Override
    public Iterable<ProviderEvent> stream(ProviderRequest request) {
        return () -> new SseIterator(request);
    }

    // ---- wire records (OpenAI chat completions) -----------------------------
    // Both directions are typed records; Jackson reads/writes the component
    // names, snake_case wire names pinned with @JsonProperty. @JsonInclude keeps
    // absent fields (e.g. tool_calls on a plain user turn) off the wire.

    /**
     * POST /v1/chat/completions request body. Exactly ONE of the two cap
     * fields is set: api.openai.com's current models reject the legacy
     * {@code max_tokens} outright and take {@code max_completion_tokens},
     * while local OpenAI-compatible servers (LM Studio, llama.cpp, Ollama)
     * speak the classic field — the null one stays off the wire.
     *
     * @param model               the model name to run
     * @param stream              always true here — the provider reads SSE chunks
     * @param messages            the full conversation including the system message
     * @param tools               the advertised tools, or null to omit the field
     * @param maxTokens           the classic completion cap (local servers), or null
     * @param maxCompletionTokens the modern cap (api.openai.com), or null
     * @param streamOptions       asks the server to append the trailing usage chunk
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ChatRequest(String model, boolean stream, List<WireMessage> messages,
                       List<WireTool> tools,
                       @JsonProperty("max_tokens") Integer maxTokens,
                       @JsonProperty("max_completion_tokens") Integer maxCompletionTokens,
                       @JsonProperty("reasoning_effort") String reasoningEffort,
                       @JsonProperty("stream_options") StreamOptions streamOptions) {}

    /**
     * One chat message on the OpenAI wire; the static factories cover the four roles.
     *
     * @param role       system | user | assistant | tool
     * @param content    the message text (a tool's output for role "tool")
     * @param toolCalls  the assistant's tool calls, when any
     * @param toolCallId pairs a role-"tool" message with the call it answers
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record WireMessage(String role, Object content,
                       @JsonProperty("tool_calls") List<WireToolCall> toolCalls,
                       @JsonProperty("tool_call_id") String toolCallId) {
        // `content` is a String for plain turns and a List<ContentPart> for
        // vision turns — exactly the two shapes the OpenAI wire accepts. The
        // record is request-side only, so the loose type never deserializes.

        /**
         * The conversation-opening system message.
         *
         * @param content the system prompt text
         */
        static WireMessage system(String content) {
            return new WireMessage("system", content, null, null);
        }

        /**
         * A plain user turn.
         *
         * @param content the user's text
         */
        static WireMessage user(String content) {
            return new WireMessage("user", content, null, null);
        }

        /**
         * A vision user turn: images (as data-URI parts) plus optional text.
         *
         * @param parts the content parts, images first
         */
        static WireMessage userParts(List<ContentPart> parts) {
            return new WireMessage("user", parts, null, null);
        }

        /**
         * An assistant turn — the tool_calls field stays off the wire when empty.
         *
         * @param content   the assistant's text
         * @param toolCalls the turn's tool calls (an empty list is allowed)
         */
        static WireMessage assistant(String content, List<WireToolCall> toolCalls) {
            return new WireMessage("assistant", content,
                    toolCalls.isEmpty() ? null : toolCalls, null);
        }

        /**
         * A role-"tool" message feeding one tool's output back to the model.
         *
         * @param toolCallId the id of the call this output answers
         * @param content    the tool's textual output
         */
        static WireMessage toolResult(String toolCallId, String content) {
            return new WireMessage("tool", content, null, toolCallId);
        }
    }

    /**
     * One part of a vision user message — the OpenAI content-array format.
     *
     * @param type     "text" or "image_url"
     * @param text     the text part's content, null on image parts
     * @param imageUrl the image part's data URI wrapper, null on text parts
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ContentPart(String type, String text,
                       @JsonProperty("image_url") ImageUrl imageUrl,
                       FilePayload file) {

        /**
         * A text part.
         *
         * @param text the text content
         */
        static ContentPart text(String text) {
            return new ContentPart("text", text, null, null);
        }

        /**
         * An image part as a base64 data URI — no upload round-trip needed.
         *
         * @param mediaType  the IANA type, e.g. image/png
         * @param dataBase64 the raw bytes, base64 without a prefix
         */
        static ContentPart image(String mediaType, String dataBase64) {
            return new ContentPart("image_url", null,
                    new ImageUrl("data:" + mediaType + ";base64," + dataBase64), null);
        }

        /**
         * A document part as a base64 data URI (file_upload: view_file) —
         * the shape gpt-4o/5.x accept on chat/completions.
         *
         * @param name       the file name the API shows the model
         * @param mediaType  the IANA type, e.g. application/pdf
         * @param dataBase64 the raw bytes, base64 without a prefix
         */
        static ContentPart file(String name, String mediaType, String dataBase64) {
            return new ContentPart("file", null, null,
                    new FilePayload(name, "data:" + mediaType + ";base64," + dataBase64));
        }
    }

    /**
     * The image_url wrapper object the OpenAI wire expects.
     *
     * @param url the data URI (or a plain URL)
     */
    record ImageUrl(String url) {}

    /**
     * The file wrapper object of a document content part.
     *
     * @param filename the file name the API shows the model
     * @param fileData the document as a data URI
     */
    record FilePayload(String filename, @JsonProperty("file_data") String fileData) {}

    /**
     * One advertised tool in OpenAI's {@code {"type":"function", ...}} shape.
     *
     * @param type     always "function"
     * @param function the tool's name, description and schema
     */
    record WireTool(String type, WireFunctionSpec function) {
        /**
         * Wraps a tool spec in the function envelope.
         *
         * @param name        the tool's wire name
         * @param description what the model reads to pick the tool
         * @param parameters  the JSON-Schema of the arguments
         */
        static WireTool function(String name, String description, JsonNode parameters) {
            return new WireTool("function", new WireFunctionSpec(name, description, parameters));
        }
    }

    /**
     * The function payload of an advertised tool.
     *
     * @param name        the tool's wire name
     * @param description what the model reads to pick the tool
     * @param parameters  the JSON-Schema of the arguments
     */
    record WireFunctionSpec(String name, String description, JsonNode parameters) {}

    /**
     * One tool call on the request wire — replays earlier assistant calls in the history.
     *
     * @param id       the call id pairing call and result
     * @param type     always "function"
     * @param function the called function's name and serialized arguments
     */
    record WireToolCall(String id, String type, WireFunctionCall function) {
        /**
         * Builds the function-typed call entry.
         *
         * @param id            the call id pairing call and result
         * @param name          the tool that was called
         * @param argumentsJson the arguments serialized as a JSON string (wire rule)
         */
        static WireToolCall function(String id, String name, String argumentsJson) {
            return new WireToolCall(id, "function", new WireFunctionCall(name, argumentsJson));
        }
    }

    /**
     * OpenAI carries tool-call arguments as a JSON STRING, not an object.
     *
     * @param name      the called tool
     * @param arguments the arguments as serialized JSON text
     */
    record WireFunctionCall(String name, String arguments) {}

    /**
     * Streaming extras — set so the final chunk carries token usage.
     *
     * @param includeUsage true to request the trailing usage chunk
     */
    record StreamOptions(@JsonProperty("include_usage") boolean includeUsage) {}

    /**
     * One parsed SSE data payload.
     *
     * @param choices the delta-carrying choices (usually exactly one)
     * @param usage   token counts — present only on the final usage chunk
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Chunk(List<Choice> choices, Usage usage) {}

    /**
     * One choice inside a chunk.
     *
     * @param delta        the incremental content/tool-call payload
     * @param finishReason non-null once the turn completes ("stop", "tool_calls", "length")
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Choice(Delta delta, @JsonProperty("finish_reason") String finishReason) {}

    /**
     * The incremental payload of a choice.
     *
     * @param content          the answer text delta, when any
     * @param reasoningContent the reasoning delta as LM Studio streams it when its
     *                         "Reasoning Section Parsing" strips the model's tags
     * @param reasoning        the same field under vLLM-and-friends' plain name
     * @param toolCalls        tool-call fragments, indexed for reassembly
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Delta(String content,
                 @JsonProperty("reasoning_content") String reasoningContent,
                 String reasoning,
                 @JsonProperty("tool_calls") List<ToolCallDelta> toolCalls) {}

    /**
     * One tool-call fragment — id, name and arguments may arrive in separate chunks.
     *
     * @param index    which pending call the fragment belongs to
     * @param id       the call id, sent once on the first fragment
     * @param function the name/arguments piece carried by this fragment
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record ToolCallDelta(Integer index, String id, FunctionDelta function) {}

    /**
     * The function piece of a tool-call fragment.
     *
     * @param name      a name fragment, when present
     * @param arguments an arguments-JSON fragment, appended verbatim
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record FunctionDelta(String name, String arguments) {}

    /**
     * The final chunk's token counts.
     *
     * @param promptTokens     input tokens billed for the request
     * @param completionTokens output tokens generated
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record Usage(@JsonProperty("prompt_tokens") Integer promptTokens,
                 @JsonProperty("completion_tokens") Integer completionTokens) {}

    /** One partially assembled tool call (fragments arrive per index). */
    private static final class PendingCall {
        String id = "";
        final StringBuilder name = new StringBuilder();
        final StringBuilder arguments = new StringBuilder();
    }

    // ---- streaming translation ----------------------------------------------

    /**
     * Classifies an HTTP error status into the exception the caller should
     * throw — the same decision table as the Ollama provider's, minus its
     * vision/thinking arms: a retryable status (per {@link RetryPolicy}) is
     * transient; everything else (401 bad key, 404 ...) is terminal and
     * deliberately NOT an IO type, because RetryPolicy classifies
     * IOExceptions transient and re-sending an identical doomed request
     * would only add latency.
     *
     * @param status the HTTP status the server answered with
     * @param detail the response body text
     * @return the exception to throw — transient or terminal, never null
     */
    private RuntimeException classifyHttpFailure(int status, String detail) {
        String message = "OpenAI-compatible server HTTP " + status
                + (detail.isBlank() ? "" : ": " + detail);
        if (RetryPolicy.retryableStatus(status)) {
            return new TransientProviderException(message);
        }
        return new IllegalStateException(message);
    }

    /** Reads SSE lines lazily and translates chunks into neutral events. */
    private final class SseIterator implements Iterator<ProviderEvent> {

        private final CancelSignal signal;
        private final BufferedReader lines;
        private final Runnable closeResponse;
        private final Deque<ProviderEvent> pending = new ArrayDeque<>();
        // Raw inline <think> tags in content (server-side reasoning parsing off)
        // are split into thinking/answer — shared with the Ollama provider.
        private final ThinkSplitter thinkSplitter = new ThinkSplitter();
        private final Map<Integer, PendingCall> calls = new LinkedHashMap<>();
        private Usage usage;
        private String finishReason;
        private boolean finished = false;

        /**
         * Posts the completion request and keeps the response open for SSE line reads.
         *
         * @param request the neutral request to send
         */
        private SseIterator(ProviderRequest request) {
            this.signal = request.signal();
            var open = http.post()
                    .uri("/v1/chat/completions")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(toChatRequest(request))
                    .exchange((clientRequest, clientResponse) -> {
                        if (clientResponse.getStatusCode().isError()) {
                            String detail = new String(clientResponse.getBody().readAllBytes(),
                                    StandardCharsets.UTF_8);
                            clientResponse.close();
                            throw classifyHttpFailure(
                                    clientResponse.getStatusCode().value(), detail);
                        }
                        return new OpenResponse(new BufferedReader(new InputStreamReader(
                                clientResponse.getBody(), StandardCharsets.UTF_8)),
                                clientResponse::close);
                    }, false);
            this.lines = open.reader();
            this.closeResponse = open.close();
            if (signal != null) {
                signal.onCancel(this.closeResponse::run);
            }
        }

        /** Reads SSE lines until at least one neutral event is pending (or the turn finishes). */
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

        /** Consumes one SSE line (data payload, keep-alive or [DONE]) and refills {@code pending}. */
        private void advance() {
            if (signal != null && signal.isCancelled()) {
                endWith(new PStop(PStop.StopReason.ABORTED));
                return;
            }
            try {
                String line = lines.readLine();
                if (line == null) {
                    // EOF: a cancel closes the response to unblock this read, and
                    // the JDK transport surfaces that as a clean EOF — so a
                    // cancelled read ends ABORTED, never a misread natural finish.
                    if (signal != null && signal.isCancelled()) {
                        endWith(new PStop(PStop.StopReason.ABORTED));
                        return;
                    }
                    finishTurn();
                    return;
                }
                if (line.equals("data: [DONE]")) {
                    finishTurn();
                    return;
                }
                if (!line.startsWith("data:")) {
                    return; // SSE comments/blank keep-alives
                }
                Chunk chunk = JSON.readValue(line.substring(5).strip(), Chunk.class);
                translate(chunk);
            } catch (IOException failure) {
                if (signal != null && signal.isCancelled()) {
                    endWith(new PStop(PStop.StopReason.ABORTED));
                    return;
                }
                finished = true;
                closeResponse.run();
                throw new TransientProviderException(
                        "OpenAI-compatible request failed: " + failure.getMessage(), failure);
            }
        }

        /**
         * One chunk → thinking/text deltas now; tool-call fragments, usage and
         * finish reason are buffered until {@link #finishTurn}. Reasoning comes
         * two ways and both map onto {@link LlmProvider.PThinkingDelta}: a
         * dedicated delta field (LM Studio's reasoning_content / vLLM's
         * reasoning) when the SERVER parsed the model's tags, or raw inline
         * {@code <think>…</think>} inside content when it did not — the shared
         * {@link ThinkSplitter} separates those so tags never leak into the
         * answer. Visibility of thinking stays the harness's emission filter,
         * exactly like the Ollama path.
         *
         * @param chunk the parsed SSE payload
         */
        private void translate(Chunk chunk) {
            if (chunk.usage() != null) {
                usage = chunk.usage(); // arrives in the final usage chunk
            }
            Optional.ofNullable(chunk.choices()).stream()
                    .flatMap(List::stream)
                    .forEach(choice -> {
                        Delta delta = choice.delta();
                        if (delta != null) {
                            String reasoningDelta = delta.reasoningContent() != null
                                    ? delta.reasoningContent()
                                    : delta.reasoning();
                            if (reasoningDelta != null && !reasoningDelta.isEmpty()) {
                                pending.add(new LlmProvider.PThinkingDelta(reasoningDelta));
                            }
                            if (delta.content() != null && !delta.content().isEmpty()) {
                                thinkSplitter.feed(delta.content(), pending::add);
                            }
                            Optional.ofNullable(delta.toolCalls()).stream()
                                    .flatMap(List::stream)
                                    .forEach(this::assemble);
                        }
                        if (choice.finishReason() != null) {
                            finishReason = choice.finishReason();
                        }
                    });
        }

        /**
         * Tool-call fragments accumulate per index until the turn finishes.
         *
         * @param fragment the id/name/arguments piece to fold into its pending call
         */
        private void assemble(ToolCallDelta fragment) {
            PendingCall call = calls.computeIfAbsent(
                    Optional.ofNullable(fragment.index()).orElse(0), i -> new PendingCall());
            if (fragment.id() != null) {
                call.id = fragment.id();
            }
            if (fragment.function() != null) {
                Optional.ofNullable(fragment.function().name()).ifPresent(call.name::append);
                Optional.ofNullable(fragment.function().arguments()).ifPresent(call.arguments::append);
            }
        }

        /** Emits the assembled calls, the usage, and the stop reason — then closes. */
        private void finishTurn() {
            calls.values().forEach(call -> pending.add(new PToolCall(
                    call.id.isBlank() ? "openai-call-" + System.nanoTime() : call.id,
                    call.name.toString(),
                    parseArguments(call.arguments.toString()))));
            pending.add(new PUsage(
                    usage != null ? Optional.ofNullable(usage.promptTokens()).orElse(0) : 0,
                    usage != null ? Optional.ofNullable(usage.completionTokens()).orElse(0) : 0));
            boolean wantsTools = "tool_calls".equals(finishReason) || !calls.isEmpty();
            pending.add(new PStop(wantsTools
                    ? PStop.StopReason.TOOL_USE
                    : "length".equals(finishReason)
                            ? PStop.StopReason.MAX_TOKENS
                            : PStop.StopReason.END_TURN));
            finished = true;
            closeResponse.run();
        }

        /**
         * Terminates the stream: queues the final event, marks done, closes the response.
         *
         * @param last the terminal event (usually a PStop)
         */
        private void endWith(ProviderEvent last) {
            pending.add(last);
            finished = true;
            closeResponse.run();
        }
    }

    /**
     * Reader plus close hook for a response kept open past the exchange call.
     *
     * @param reader line reader over the still-open response body
     * @param close  releases the underlying HTTP response
     */
    private record OpenResponse(BufferedReader reader, Runnable close) {}

    // ---- request mapping ------------------------------------------------------

    /**
     * The largest completion cap this provider ever sends. The harness default
     * (32k) suits Anthropic and local servers, but api.openai.com enforces
     * PER-MODEL caps and rejects a too-large value with HTTP 400 — the
     * smallest cap among current chat models is gpt-4o-mini's 16384, so 16000
     * is the safe ceiling for everything the picker offers.
     */
    static final int MAX_TOKENS_CAP = 16_000;

    /**
     * Whether a base URL is the real OpenAI cloud — which speaks the MODERN
     * completion-cap field ({@code max_completion_tokens}; its current models
     * reject the legacy {@code max_tokens} outright), while every local
     * OpenAI-compatible server keeps the classic field.
     *
     * @param baseUrl the provider's endpoint root
     * @return true for api.openai.com
     */
    static boolean isOpenAiCloud(String baseUrl) {
        return baseUrl != null && baseUrl.startsWith("https://api.openai.com");
    }

    /**
     * Neutral request → typed OpenAI wire request; the tools field is omitted
     * when empty, the completion cap is clamped to {@link #MAX_TOKENS_CAP}
     * and rides the field the TARGET actually accepts (modern for the cloud,
     * classic for local servers).
     *
     * @param request the provider-neutral turn input
     * @return the /v1/chat/completions body, streaming and usage reporting on
     */
    private ChatRequest toChatRequest(ProviderRequest request) {
        List<WireMessage> messages = new ArrayList<>();
        messages.add(WireMessage.system(request.system()));
        request.messages().forEach(message -> appendWireMessages(messages, message));

        List<WireTool> tools = request.tools().stream()
                .map(spec -> WireTool.function(spec.name(), spec.description(), spec.inputSchema()))
                .toList();

        int cap = Math.min(request.maxTokens(), MAX_TOKENS_CAP);
        boolean cloud = isOpenAiCloud(baseUrl);
        return new ChatRequest(model, true, messages, tools.isEmpty() ? null : tools,
                cloud ? null : cap, cloud ? cap : null,
                reasoningEffortFor(baseUrl, model, !tools.isEmpty()), new StreamOptions(true));
    }

    /**
     * The {@code reasoning_effort} the wire needs, or null to omit the field.
     * gpt-5.x are reasoning models and chat/completions REFUSES function tools
     * unless the effort is explicitly "none" ("use /v1/responses or set
     * reasoning_effort to 'none'"). The agent always advertises tools, so the
     * cloud gets the "none" — reasoning WITH tools needs the Responses API, a
     * deliberate future migration, not a silent default. Local servers and
     * non-reasoning models never see the field.
     *
     * @param baseUrl  the provider's endpoint root
     * @param model    the model id to run
     * @param hasTools whether the request advertises function tools
     * @return "none" for cloud gpt-5.x with tools, else null
     */
    static String reasoningEffortFor(String baseUrl, String model, boolean hasTools) {
        return isOpenAiCloud(baseUrl) && model.startsWith("gpt-5") && hasTools ? "none" : null;
    }

    /**
     * One neutral message → one or more OpenAI wire messages.
     *
     * @param out     the wire message list being built up
     * @param message the neutral history entry to translate
     */
    private void appendWireMessages(List<WireMessage> out, ProviderMessage message) {
        if (message.role() == ProviderMessage.Role.ASSISTANT) {
            String text = message.content().stream()
                    .filter(TextContent.class::isInstance)
                    .map(content -> ((TextContent) content).text())
                    .reduce("", String::concat);
            List<WireToolCall> toolCalls = message.content().stream()
                    .filter(ToolCallContent.class::isInstance)
                    .map(ToolCallContent.class::cast)
                    // OpenAI wire carries the arguments as a JSON STRING.
                    .map(call -> WireToolCall.function(
                            call.callId(), call.name(), call.input().toString()))
                    .toList();
            out.add(WireMessage.assistant(text, toolCalls));
        } else {
            // Tool results first (role "tool" with the matching id), then the
            // user content: plain text as a string, images (attachments
            // and view_image) as the content-array with data-URI image parts.
            message.content().stream()
                    .filter(ToolResultContent.class::isInstance)
                    .map(ToolResultContent.class::cast)
                    .forEach(result -> out.add(
                            WireMessage.toolResult(result.callId(), result.output())));
            List<ContentPart> imageParts = message.content().stream()
                    .filter(ImageContent.class::isInstance)
                    .map(ImageContent.class::cast)
                    .map(image -> ContentPart.image(image.mediaType(), image.dataBase64()))
                    .toList();
            // file_upload: documents ride as "file" parts, after the images.
            List<ContentPart> documentParts = message.content().stream()
                    .filter(LlmProvider.DocumentContent.class::isInstance)
                    .map(LlmProvider.DocumentContent.class::cast)
                    .map(document -> ContentPart.file(
                            document.name(), document.mediaType(), document.dataBase64()))
                    .toList();
            String text = message.content().stream()
                    .filter(TextContent.class::isInstance)
                    .map(content -> ((TextContent) content).text())
                    .reduce((left, right) -> left + "\n" + right)
                    .orElse("");
            if (!imageParts.isEmpty() || !documentParts.isEmpty()) {
                List<ContentPart> parts = new ArrayList<>(imageParts); // images before the text (attachment order)
                parts.addAll(documentParts);
                if (!text.isEmpty()) {
                    parts.add(ContentPart.text(text));
                }
                out.add(WireMessage.userParts(parts));
            } else if (!text.isEmpty()) {
                out.add(WireMessage.user(text));
            }
        }
    }

    /**
     * Parses the accumulated arguments JSON; unparseable text survives under a
     * "raw" key instead of failing the turn.
     *
     * @param raw the assembled arguments string (may be blank)
     * @return the parsed arguments, never null
     */
    private static JsonNode parseArguments(String raw) {
        if (raw.isBlank()) {
            return JSON.createObjectNode();
        }
        try {
            return JSON.readTree(raw);
        } catch (IOException notJson) {
            return JSON.createObjectNode().put("raw", raw);
        }
    }
}
