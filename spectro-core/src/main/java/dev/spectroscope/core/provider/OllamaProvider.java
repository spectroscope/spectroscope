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
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.NoSuchElementException;
import java.util.Optional;

/**
 * The second {@link LlmProvider} implementation: local models via Ollama's
 * {@code POST /api/chat} NDJSON stream. Built on Spring's {@link RestClient}
 * (owner decision: Spring Framework as a library in the core) with typed
 * request/response records instead of hand-rolled JSON trees; the version
 * probe goes through the declarative {@link OllamaApi} interface.
 *
 * <p>Ollama returns no call IDs, so this provider generates them; token counts
 * arrive only in the final {@code done:true} chunk and map onto the usage
 * event. Like the AnthropicProvider, the returned iterable is <b>lazy</b> —
 * text deltas reach the loop while the HTTP response is still streaming.</p>
 */
public final class OllamaProvider implements LlmProvider {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final RestClient http;
    private final OllamaApi api;
    private final String model;
    private final String baseUrl;

    /**
     * Builds the provider and its HTTP plumbing; no request leaves here yet.
     *
     * @param options base URL (trailing slash stripped) and model name
     */
    public OllamaProvider(OllamaOptions options) {
        this.baseUrl = options.baseUrl().replaceAll("/$", "");
        this.model = options.model();
        // The JDK HttpClient transport, NOT the default HttpURLConnection one:
        // cancelling a run closes the streaming response, and only the JDK
        // client's close CANCELS the body subscription promptly. The default
        // (SimpleClientHttpRequestFactory) instead tries to DRAIN the stream for
        // connection reuse on close, which BLOCKS when a slow or cloud model has
        // stalled mid-stream — so the stop button could never interrupt it.
        this.http = RestClient.builder()
                .baseUrl(baseUrl)
                .requestFactory(new JdkClientHttpRequestFactory())
                .build();
        this.api = OllamaApi.create(http);
    }

    /**
     * The Ollama server version — a cheap reachability probe for banners/health checks.
     *
     * @return the version string, or empty when the server is unreachable
     */
    public Optional<String> serverVersion() {
        try {
            return Optional.of(api.version().version());
        } catch (RuntimeException unreachable) {
            return Optional.empty();
        }
    }

    /**
     * Opens one NDJSON chat stream per iteration — lazy like the Anthropic twin.
     *
     * @param request the provider-neutral turn input to translate onto Ollama's wire
     * @return a lazy iterable; each {@code iterator()} call posts a fresh /api/chat
     */
    @Override
    public Iterable<ProviderEvent> stream(ProviderRequest request) {
        return () -> new NdjsonIterator(request);
    }

    // ---- wire records (Ollama /api/chat) -----------------------------------
    // Jackson reads record component names reflectively; snake_case wire names
    // are pinned with @JsonProperty where they differ.

    /**
     * POST /api/chat request body.
     *
     * @param model    the model name to run
     * @param stream   always true here — the provider reads NDJSON chunks
     * @param messages the full conversation including the system message
     * @param tools    the advertised tools as function specs
     * @param options  generation options (the completion cap)
     * @param think    true to request reasoning; null omits the field so unconditional
     *                 reasoners stay unaffected
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ChatRequest(String model, boolean stream, List<WireMessage> messages,
                       List<WireTool> tools, WireOptions options, Boolean think) {}

    /**
     * One chat message on Ollama's wire.
     *
     * @param role      system | user | assistant | tool
     * @param content   the message text (a tool's output for role "tool")
     * @param toolCalls the assistant's tool calls, when any
     * @param images    base64 image payloads without a data: prefix, or null
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record WireMessage(String role, String content,
                       @JsonProperty("tool_calls") List<WireToolCall> toolCalls,
                       List<String> images) {                       // base64, no data: prefix
        /**
         * Image-free message — the common case without images.
         *
         * @param role      system | user | assistant | tool
         * @param content   the message text
         * @param toolCalls the assistant's tool calls, when any
         */
        WireMessage(String role, String content, List<WireToolCall> toolCalls) {
            this(role, content, toolCalls, null);
        }
    }

    /**
     * One advertised tool — Ollama mirrors OpenAI's {@code {"type":"function", ...}} shape.
     *
     * @param type     always "function"
     * @param function the tool's name, description and schema
     */
    record WireTool(String type, WireFunctionSpec function) {}

    /**
     * The function payload of an advertised tool.
     *
     * @param name        the tool's wire name
     * @param description what the model reads to pick the tool
     * @param parameters  the JSON-Schema of the arguments
     */
    record WireFunctionSpec(String name, String description, JsonNode parameters) {}

    /**
     * One tool call as Ollama streams it — no id on this wire, the provider mints one.
     *
     * @param function the called function's name and arguments
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record WireToolCall(WireFunction function) {}

    /**
     * The function part of a streamed tool call.
     *
     * @param name      the tool the model wants to run
     * @param arguments the arguments — usually an object, a JSON string on some models
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record WireFunction(String name, JsonNode arguments) {}

    /**
     * Generation options — only the completion cap is set.
     *
     * @param numPredict Ollama's name for maxTokens
     */
    record WireOptions(@JsonProperty("num_predict") int numPredict) {}

    /**
     * One NDJSON line of the streaming response.
     *
     * @param message         the delta payload (text/thinking/tool calls), may be null
     * @param done            true on the final chunk — the only one carrying token counts
     * @param error           the server's error text when the stream fails mid-flight
     * @param promptEvalCount input token count, final chunk only
     * @param evalCount       output token count, final chunk only
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record ChatChunk(WireMessage2 message, boolean done, String error,
                     @JsonProperty("prompt_eval_count") Integer promptEvalCount,
                     @JsonProperty("eval_count") Integer evalCount) {}

    /**
     * The message payload inside a streamed chunk — a narrower shape than {@link WireMessage}.
     *
     * @param content   the answer text delta, may be empty
     * @param thinking  the native reasoning delta (gpt-oss always, qwen3 with think:true)
     * @param toolCalls tool calls announced in this chunk
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    record WireMessage2(String content, String thinking,
                        @JsonProperty("tool_calls") List<WireToolCall> toolCalls) {}

    // ---- streaming translation ---------------------------------------------

    /**
     * Classifies an HTTP error status into the exception the caller should
     * throw — a pure decision table, four ways out:
     * <ul>
     *   <li>a 400 (or an error naming images/vision) on a vision request means
     *       "this model cannot see" — terminal, with the actionable hint;</li>
     *   <li>a 4xx that mentions thinking means the model does not support it —
     *       Ollama's terse error becomes an actionable one;</li>
     *   <li>a retryable status (per {@link RetryPolicy}) is transient;</li>
     *   <li>everything else (404 model not pulled, 401, 422 ...) is terminal —
     *       deliberately NOT an IO type, because RetryPolicy classifies
     *       IOExceptions transient and re-sending an identical doomed request
     *       would only add latency.</li>
     * </ul>
     *
     * @param status    the HTTP status Ollama answered with
     * @param detail    the response body text (Ollama puts its reason there)
     * @param hasImages whether the failed request carried image content
     * @return the exception to throw — transient or terminal, never null
     */
    private RuntimeException classifyHttpFailure(int status, String detail, boolean hasImages) {
        String lowered = detail.toLowerCase(Locale.ROOT);
        if (hasImages && (status == 400
                || lowered.contains("image") || lowered.contains("vision")
                || lowered.contains("multimodal"))) {
            return new IllegalStateException(noVisionMessage());
        }
        if (status >= 400 && status < 500 && lowered.contains("think")) {
            return new RuntimeException("Model \"" + model + "\" does not support "
                    + "thinking — disable it (config thinking:false / "
                    + "SPECTRO_THINKING=0) or use a reasoning model like qwen3 / "
                    + "deepseek-r1.");
        }
        String message = "Ollama HTTP " + status + (detail.isBlank() ? "" : ": " + detail);
        if (RetryPolicy.retryableStatus(status)) {
            return new TransientProviderException(message);
        }
        return new IllegalStateException(message);
    }

    /**
     * Reads the NDJSON body line by line and translates each chunk into neutral
     * {@link ProviderEvent}s on demand. The RestClient exchange runs with
     * {@code close=false} so the response stays open while we iterate; every
     * terminal path closes it.
     */
    private final class NdjsonIterator implements Iterator<ProviderEvent> {

        private final CancelSignal signal;
        private final BufferedReader lines;
        private final Runnable closeResponse;
        private final Deque<ProviderEvent> pending = new ArrayDeque<>();
        // Some models inline their reasoning as <think>…</think> in message.content
        // instead of message.thinking. The splitter routes inner text to thinking,
        // outer text to the answer, and survives tags split across chunk boundaries.
        private final ThinkSplitter thinkSplitter = new ThinkSplitter();
        private boolean sawToolCall = false;
        private boolean finished = false;

        /**
         * Posts the chat request and keeps the response open for line-by-line reads;
         * a vision request against a non-vision model fails fast before any chat call.
         *
         * @param request the neutral request to send
         */
        private NdjsonIterator(ProviderRequest request) {
            this.signal = request.signal();
            // file_upload: Ollama's chat API has no document channel — a silent
            // drop would let the model hallucinate over a PDF it never saw.
            boolean hasDocuments = request.messages().stream()
                    .anyMatch(message -> message.content().stream()
                            .anyMatch(LlmProvider.DocumentContent.class::isInstance));
            if (hasDocuments) {
                throw new IllegalStateException("Ollama cannot read documents (PDF) — "
                        + "switch to the anthropic or openai provider for view_file.");
            }
            ChatRequest body = toChatRequest(request);
            // Ollama silently DROPS the images field on text-only models —
            // fail fast instead of letting the model hallucinate an answer.
            boolean hasImages = request.messages().stream()
                    .anyMatch(message -> message.content().stream()
                            .anyMatch(ImageContent.class::isInstance));
            if (hasImages) {
                assertVisionModel();
            }
            // exchange(..., false): WE own the response lifecycle — required for
            // streaming reads; every terminal path below calls closeResponse.
            var open = http.post()
                    .uri("/api/chat")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .exchange((clientRequest, clientResponse) -> {
                        if (clientResponse.getStatusCode().isError()) {
                            String detail = new String(clientResponse.getBody().readAllBytes(),
                                    StandardCharsets.UTF_8);
                            clientResponse.close();
                            throw classifyHttpFailure(
                                    clientResponse.getStatusCode().value(), detail, hasImages);
                        }
                        InputStream bodyStream = clientResponse.getBody();
                        return new OpenResponse(
                                new BufferedReader(new InputStreamReader(bodyStream, StandardCharsets.UTF_8)),
                                clientResponse::close);
                    }, false);
            this.lines = open.reader();
            this.closeResponse = open.close();
            if (signal != null) {
                signal.onCancel(this.closeResponse::run);
            }
        }

        /** Reads NDJSON lines until at least one neutral event is pending (or the stream ends). */
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

        /** Consumes one NDJSON line (or the stream end) and refills {@code pending}. */
        private void advance() {
            if (signal != null && signal.isCancelled()) {
                endWith(new PStop(PStop.StopReason.ABORTED));
                return;
            }
            try {
                String line = lines.readLine();
                if (line == null) {
                    // A null line is EOF. A cancel closes the response to unblock
                    // this very read, and the JDK transport surfaces that as a
                    // clean EOF (not an IOException) — so a cancelled read must
                    // end ABORTED here, never be misread as a natural finish.
                    if (signal != null && signal.isCancelled()) {
                        endWith(new PStop(PStop.StopReason.ABORTED));
                        return;
                    }
                    // Stream ended without done:true — close out with what we know.
                    endWith(new PStop(sawToolCall
                            ? PStop.StopReason.TOOL_USE : PStop.StopReason.END_TURN));
                    return;
                }
                if (line.isBlank()) {
                    return;
                }
                ChatChunk chunk = JSON.readValue(line, ChatChunk.class);
                if (chunk.error() != null) {
                    throw new IOException("Ollama: " + chunk.error());
                }
                translate(chunk);
            } catch (IOException failure) {
                if (signal != null && signal.isCancelled()) {
                    endWith(new PStop(PStop.StopReason.ABORTED));
                    return;
                }
                finished = true;
                closeResponse.run();
                throw new TransientProviderException(
                        "Ollama request failed: " + failure.getMessage(), failure);
            }
        }

        /**
         * One chunk → zero or more neutral events.
         *
         * @param chunk the parsed NDJSON line to fan out into events
         */
        private void translate(ChatChunk chunk) {
            Optional.ofNullable(chunk.message()).ifPresent(message -> {
                // Native reasoning field (gpt-oss always, qwen3 with think:true).
                if (message.thinking() != null && !message.thinking().isEmpty()) {
                    pending.add(new PThinkingDelta(message.thinking()));
                }
                // Answer text: a model may inline <think>…</think> here, so the
                // splitter separates reasoning (thinking) from answer (text).
                if (message.content() != null && !message.content().isEmpty()) {
                    thinkSplitter.feed(message.content(), pending::add);
                }
                Optional.ofNullable(message.toolCalls()).stream()
                        .flatMap(List::stream)
                        .forEach(call -> {
                            sawToolCall = true;
                            // Ollama returns no ids — generate one; arguments stay a JsonNode.
                            pending.add(new PToolCall(
                                    "ollama-call-" + System.nanoTime(),
                                    call.function().name(),
                                    parseArguments(call.function().arguments())));
                        });
            });
            if (chunk.done()) {
                // Token counts come ONLY in the final chunk -> map to usage.
                pending.add(new PUsage(
                        Optional.ofNullable(chunk.promptEvalCount()).orElse(0),
                        Optional.ofNullable(chunk.evalCount()).orElse(0)));
                endWith(new PStop(sawToolCall
                        ? PStop.StopReason.TOOL_USE : PStop.StopReason.END_TURN));
            }
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
     * Reader plus close hook for a response we keep open past the exchange call.
     *
     * @param reader line reader over the still-open response body
     * @param close  releases the underlying HTTP response
     */
    private record OpenResponse(BufferedReader reader, Runnable close) {}

    // ---- request mapping ----------------------------------------------------

    /**
     * Neutral request → typed Ollama wire request.
     *
     * @param request the provider-neutral turn input
     * @return the /api/chat body — streaming on, think only when enabled
     */
    private ChatRequest toChatRequest(ProviderRequest request) {
        List<WireTool> tools = request.tools().stream()
                .map(spec -> new WireTool("function",
                        new WireFunctionSpec(spec.name(), spec.description(), spec.inputSchema())))
                .toList();
        // think:true is sent only when thinking is enabled — it encourages models that
        // gate reasoning behind the flag (qwen3). Left null (omitted) otherwise, so
        // models that reason unconditionally (gpt-oss) are unaffected.
        Boolean think = request.thinking() ? Boolean.TRUE : null;
        return new ChatRequest(model, true, toWireMessages(request), tools,
                new WireOptions(request.maxTokens()), think);
    }

    /**
     * ProviderMessage[] → Ollama messages. tool_results become role:"tool"
     * messages; a tool_call on an assistant message becomes a tool_calls entry.
     *
     * @param request the neutral request whose history is being mapped
     * @return the wire messages, system message first
     */
    private List<WireMessage> toWireMessages(ProviderRequest request) {
        List<WireMessage> out = new ArrayList<>();
        out.add(new WireMessage("system", request.system(), null));

        for (ProviderMessage message : request.messages()) {
            if (message.role() == ProviderMessage.Role.ASSISTANT) {
                String text = message.content().stream()
                        .filter(TextContent.class::isInstance)
                        .map(content -> ((TextContent) content).text())
                        .reduce("", String::concat);
                List<WireToolCall> calls = message.content().stream()
                        .filter(ToolCallContent.class::isInstance)
                        .map(ToolCallContent.class::cast)
                        .map(call -> new WireToolCall(new WireFunction(call.name(), call.input())))
                        .toList();
                out.add(new WireMessage("assistant", text, calls.isEmpty() ? null : calls));
            } else {
                // user message: first the tool results (role:"tool"), then the text.
                message.content().stream()
                        .filter(ToolResultContent.class::isInstance)
                        .map(ToolResultContent.class::cast)
                        .forEach(result -> out.add(new WireMessage("tool", result.output(), null)));
                String text = message.content().stream()
                        .filter(TextContent.class::isInstance)
                        .map(content -> ((TextContent) content).text())
                        .reduce((left, right) -> left + "\n" + right)
                        .orElse("");
                // images ride the same user message as an images field —
                // raw base64 strings, WITHOUT any data: prefix.
                List<String> images = message.content().stream()
                        .filter(ImageContent.class::isInstance)
                        .map(content -> ((ImageContent) content).dataBase64())
                        .toList();
                if (!text.isEmpty() || !images.isEmpty()) {
                    out.add(new WireMessage("user", text, null,
                            images.isEmpty() ? null : images));
                }
            }
        }
        return out;
    }

    // ---- vision check ----------------------------------------------

    /**
     * Fails fast when the configured model cannot see. Best effort: if /api/show
     * yields no capability details (older Ollama, network hiccup), do not block —
     * the chat call reports errors.
     */
    private void assertVisionModel() {
        List<String> capabilities;
        try {
            capabilities = api.show(new OllamaApi.ShowRequest(model)).capabilities();
        } catch (RuntimeException unavailable) {
            return; // network problems are reported by the actual chat call
        }
        if (capabilities == null) {
            return; // no capability details: do not block
        }
        if (!capabilities.contains("vision")) {
            throw new IllegalStateException(noVisionMessage());
        }
    }

    /**
     * The actionable error text for a vision request against a text-only model.
     *
     * @return the message naming the configured model and a pullable alternative
     */
    private String noVisionMessage() {
        return "Model without vision: \"" + model + "\" cannot process images. "
                + "Use a vision model, e.g. qwen3-vl or llava (ollama pull qwen3-vl).";
    }

    // The inline <think> splitter moved to the shared top-level ThinkSplitter
    // (logging-night follow-up): the OpenAI-compatible provider needs the same
    // separation whenever a server streams raw tags in content.

    /**
     * Some models deliver arguments as a JSON string instead of an object — both
     * shapes are normalized; unparseable text survives under a "raw" key.
     *
     * @param raw the arguments node as streamed; may be null, missing or textual
     * @return the parsed arguments, never null
     */
    private static JsonNode parseArguments(JsonNode raw) {
        if (raw == null || raw.isNull() || raw.isMissingNode()) {
            return JSON.createObjectNode();
        }
        if (raw.isTextual()) {
            try {
                return JSON.readTree(raw.asText());
            } catch (IOException notJson) {
                return JSON.createObjectNode().put("raw", raw.asText());
            }
        }
        return raw;
    }
}
