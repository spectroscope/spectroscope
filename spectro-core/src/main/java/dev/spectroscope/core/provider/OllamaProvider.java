package dev.spectroscope.core.provider;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.wire.LlmWireTap;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
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

    /** The probe's verdict, memoized (card 252). {@code /api/show} states a fact
     *  about a pulled model, and a session holds one provider, so asking twice
     *  cannot answer differently. UNKNOWN is never cached: an ollama that was
     *  down, or too old to report capabilities, must not pin the model as
     *  unknowable for the rest of the session. */
    private volatile Vision vision = Vision.UNKNOWN;

    /** The running window this server reported, memoized (card 263). Zero is
     *  never cached: ollama loads a model on the first chat call, so an empty
     *  {@code /api/ps} before the first turn is a moment, not a verdict. */
    private volatile int contextWindow;

    /** A SECOND client for capability questions only, with a read timeout the
     *  chat client must never have — that one streams NDJSON, and a deadline on
     *  it would cut long answers off mid-sentence. */
    private final RestClient capabilities;

    /**
     * Builds the provider and its HTTP plumbing; no request leaves here yet.
     *
     * @param options base URL (trailing slash stripped) and model name
     */
    public OllamaProvider(OllamaOptions options) {
        this.baseUrl = options.baseUrl().replaceAll("/$", "");
        this.model = options.model();
        // The JDK HttpClient transport, NOT the default HttpURLConnection one:
        // closing the JDK client's RAW body stream cancels the body subscription
        // and tears the connection down promptly — the stop button's whole
        // mechanism. NOTE: Spring's response-level close() drains the remaining
        // body on EVERY transport (StreamUtils.drain), so the iterator closes
        // the raw stream, never the response (see NdjsonIterator).
        this.http = RestClient.builder()
                .baseUrl(baseUrl)
                .requestFactory(new JdkClientHttpRequestFactory())
                .build();
        this.api = OllamaApi.create(http);
        // BOTH deadlines, and they live in two places. A refused connection comes
        // back in milliseconds, but a host that is merely asleep — a Tailscale
        // node, a laptop that closed its lid — drops the packets instead of
        // refusing, and a read timeout alone never fires because the read never
        // starts. The connect deadline belongs to the JDK client, the read
        // deadline to Spring's factory over it.
        JdkClientHttpRequestFactory probeFactory = new JdkClientHttpRequestFactory(
                java.net.http.HttpClient.newBuilder()
                        .connectTimeout(java.time.Duration.ofSeconds(2))
                        .build());
        probeFactory.setReadTimeout(java.time.Duration.ofSeconds(2));
        this.capabilities = RestClient.builder().requestFactory(probeFactory).build();
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

    @Override
    public String modelName() {
        return model;
    }

    /** The Ollama root this provider dials, trailing slash already stripped —
     *  card 193: the face that reports it unreachable must name THIS string and
     *  not a config field re-read after the fact. */
    @Override
    public String endpoint() {
        return baseUrl;
    }

    /**
     * The window the RUNNING instance of this model was loaded with, from
     * {@code GET /api/ps} (card 263) — memoized, asked at most once per run.
     *
     * <p><b>Why {@code /api/ps} and not {@code /api/show}.</b> The show endpoint
     * answers {@code model_info["<arch>.context_length"]} — measured on ollama
     * 0.24.0, qwen2.5:3b reports 32,768 there. That is the window the model was
     * TRAINED with, not the one ollama loaded it into: the server decides that
     * per run, from the Modelfile's {@code num_ctx} or its own
     * {@code OLLAMA_CONTEXT_LENGTH}, and either can be far smaller. Reporting
     * the trained figure would push compaction past the served window, which is
     * the one direction worse than the constant this card removes. {@code /ps}
     * states what is actually loaded: {@code models[].context_length}, 32,768
     * for the same model on the same measurement.</p>
     *
     * <p>The cost is that a fresh session, before its first turn, finds nothing
     * running and starts on the fallback. That is why only a POSITIVE answer is
     * remembered — the model is loaded by the first chat call, and the second
     * run of the session gets the truth.</p>
     *
     * @return the running instance's context length, or 0 when nothing is known
     */
    @Override
    public int contextWindow() {
        int known = contextWindow;
        if (known > 0) {
            return known;
        }
        int probed = probeContextWindow();
        if (probed > 0) {
            contextWindow = probed;
        }
        return probed;
    }

    /** One best-effort GET on the short-timeout client. Never throws: a
     *  capability question may not be able to fail a run.
     *  @return the running window, or 0 on any refusal, timeout or surprise */
    private int probeContextWindow() {
        try {
            String body = capabilities.get().uri(baseUrl + "/api/ps")
                    .retrieve().body(String.class);
            return body == null ? 0 : loadedWindow(JSON.readTree(body), model);
        } catch (Exception nothingLearned) {
            return 0;
        }
    }

    /**
     * What {@code /api/ps} says about ONE model's running window.
     *
     * <p>The shape, measured on ollama 0.24.0 with qwen2.5:3b loaded:
     * {@code {"models":[{"name":"qwen2.5:3b","model":"qwen2.5:3b","size":…,
     * "context_length":32768}]}}. With nothing loaded the same call answers
     * {@code {"models":[]}} — the state every fresh session starts in.</p>
     *
     * <p>{@code context_length} arrived in a later ollama; an entry without it
     * must read as "nothing known" and never as a window of zero, which would
     * make the harness compact on the empty first turn and every turn after.</p>
     *
     * @param ps    the parsed {@code /api/ps} body, whatever it turned out to be
     * @param model the model id this provider sends to; null teaches nothing
     * @return the running context length in tokens, or 0 when nothing is known
     */
    static int loadedWindow(JsonNode ps, String model) {
        if (ps == null || model == null) {
            return 0;
        }
        for (JsonNode entry : ps.path("models")) {
            if (model.equals(entry.path("model").asText(null))
                    || model.equals(entry.path("name").asText(null))) {
                int window = entry.path("context_length").asInt(0);
                if (window > 0) {
                    return window;
                }
            }
        }
        return 0;
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
     * @param think    Boolean on/off, or a level string ("low".."max") for the
     *                 families that take one (qwen3, gpt-oss); null omits the
     *                 field so unconditional reasoners stay unaffected
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record ChatRequest(String model, boolean stream, List<WireMessage> messages,
                       List<WireTool> tools, WireOptions options, Object think) {}

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
            // Card 252: remember it. When /api/show said nothing (an older
            // ollama), the chat call's own refusal is the only capability fact
            // there is — and unremembered it would arrive again on every turn,
            // which is exactly how the session got wedged.
            vision = Vision.BLIND;
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
        /** The status the server actually answered — endWire records it, never a literal. */
        private final int httpStatus;
        // The open llm-wire exchange, or null when the request carries no tap.
        private final LlmWireTap.Exchange wire;
        /** One end() per exchange, whatever path closes it — the HTTP-error
         *  path ends inside the callback AND rethrows into the transport
         *  catch, and a record with two closings would lie twice. */
        private boolean wireEnded;
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
            // The body is serialized HERE and posted as that exact string; the
            // tap records the same string, so recorded == posted by construction
            // and the record's "bytes" fidelity is true, not asserted.
            String bodyJson = toJson(body);
            LlmWireTap.Exchange wire = request.tap() == null ? null
                    : request.tap().begin(new LlmWireTap.WireRequest("ollama", model,
                            "http", "POST", baseUrl + "/api/chat", requestHeaders(),
                            "bytes", bodyJson, System.currentTimeMillis()));
            this.wire = wire;
            // exchange(..., false): WE own the response lifecycle — required for
            // streaming reads; every terminal path below calls closeResponse.
            final OpenResponse open;
            try {
                open = http.post()
                    .uri("/api/chat")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(bodyJson)
                    .exchange((clientRequest, clientResponse) -> {
                        if (clientResponse.getStatusCode().isError()) {
                            String detail = new String(clientResponse.getBody().readAllBytes(),
                                    StandardCharsets.UTF_8);
                            clientResponse.close();
                            endWireOnce(new LlmWireTap.WireOutcome(
                                    clientResponse.getStatusCode().value(), "bytes",
                                    detail, false, null, System.currentTimeMillis()));
                            throw classifyHttpFailure(
                                    clientResponse.getStatusCode().value(), detail, hasImages);
                        }
                        // The close handle is the RAW body stream, NEVER the Spring
                        // response: Spring's close() DRAINS the remaining body first,
                        // so a mid-generation cancel would read the model's whole
                        // remaining output on the cancelling thread while the server
                        // never sees a disconnect (card 78). The raw JDK stream close
                        // cancels the subscription and tears the connection down.
                        InputStream bodyStream = clientResponse.getBody();
                        return new OpenResponse(clientResponse.getStatusCode().value(),
                                new BufferedReader(new InputStreamReader(bodyStream, StandardCharsets.UTF_8)),
                                () -> closeBody(bodyStream));
                    }, false);
            } catch (RuntimeException failure) {
                // Transport failure BEFORE any byte was answered (connect refused,
                // DNS, TLS — Spring throws before the callback runs), and the
                // HTTP-error rethrow above. end() is idempotent, so the pair
                // closes exactly once; the null status is the WireOutcome
                // contract's "the connection never answered" arm — without this
                // catch, every retry attempt left a dangling llm_request line.
                endWireOnce(new LlmWireTap.WireOutcome(null, "bytes", null, false,
                        failure.toString(), System.currentTimeMillis()));
                throw failure;
            }
            this.httpStatus = open.status();
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
                if (wire != null) {
                    wire.line(line); // teed verbatim, BEFORE any interpretation
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
                endWire(false, failure.getMessage());
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
            endWire(last instanceof PStop stop && stop.reason() == PStop.StopReason.ABORTED,
                    null);
        }

        /**
         * Closes the wire exchange, when one is recording. Status is 200 because
         * the stream had opened (the HTTP-error path closes inside the exchange
         * callback and never reaches the iterator); teed lines stay with the
         * record even on an abort, because a partial answer is still an answer
         * received.
         *
         * @param aborted true when a cancel tore the stream down
         * @param error   the failure in one line, null on a clean close
         */
        private void endWire(boolean aborted, String error) {
            endWireOnce(new LlmWireTap.WireOutcome(httpStatus, "bytes", null, aborted, error,
                    System.currentTimeMillis()));
        }

        /** The single closing gate every path funnels through. */
        private void endWireOnce(LlmWireTap.WireOutcome outcome) {
            if (wire != null && !wireEnded) {
                wireEnded = true;
                wire.end(outcome);
            }
        }
    }

    /**
     * Reader plus close hook for a response we keep open past the exchange call.
     *
     * @param reader line reader over the still-open response body
     * @param close  releases the underlying HTTP response
     */
    private record OpenResponse(int status, BufferedReader reader, Runnable close) {}

    /** Closes the raw body stream, quietly — closing an already-broken stream is
     *  fine; the point is the prompt subscription cancel + connection teardown. */
    private static void closeBody(InputStream body) {
        try {
            body.close();
        } catch (IOException ignored) {
            // the reader's own IOException path handles the aftermath
        }
    }

    // ---- request mapping ----------------------------------------------------

    /**
     * The headers one chat request actually sets. Ollama's wire is keyless,
     * so the only header is the content type.
     *
     * @return the headers as posted, insertion-ordered
     */
    private static Map<String, String> requestHeaders() {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", "application/json");
        return headers;
    }

    /**
     * Serializes a wire record with the provider's own mapper: the exact
     * string that goes over the socket AND into the llm-wire record.
     *
     * @param body the typed request record
     * @return its JSON serialization
     */
    private static String toJson(Object body) {
        try {
            return JSON.writeValueAsString(body);
        } catch (JsonProcessingException impossible) {
            // the wire records are plain data records; serialization cannot fail
            throw new UncheckedIOException(impossible);
        }
    }

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
        return new ChatRequest(model, true, toWireMessages(request), tools,
                new WireOptions(request.maxTokens()), thinkWireValue(model, request));
    }

    /**
     * The {@code think} value for one request, capability-gated: a level string
     * where the family takes one (qwen3, gpt-oss), the boolean toggle
     * otherwise, and NOTHING where the family has no off state — gpt-oss
     * ignores true/false and a fabricated off would pretend.
     *
     * <p>The three toggle states are not interchangeable. think:true encourages
     * models that gate reasoning behind the flag (qwen3); OMITTING the field
     * leaves the choice with the model, so an unconditional reasoner is
     * unaffected; think:false is the explicit off switch, and it is not a
     * nicety: num_predict caps reasoning and answer TOGETHER. MEASURED
     * 2026-07-27, glm-5.2 via ollama, one 181-character passage at num_predict
     * 512 — with the field omitted the reasoning phase spent the entire budget
     * (eval_count 512, done_reason "length") and the answer never started;
     * with think:false, zero reasoning and the answer in 0.9 s.</p>
     *
     * @param model   the model the request runs
     * @param request the neutral request carrying reasoning mode and effort
     * @return Boolean, level String, or null to omit the field
     */
    static Object thinkWireValue(String model, ProviderRequest request) {
        ReasoningCapability cap = ReasoningCapabilities.resolve("ollama", model);
        if (request.effort() != null && cap.efforts().contains(request.effort())
                && request.reasoning() != ProviderRequest.Reasoning.OFF) {
            return request.effort();
        }
        return switch (request.reasoning()) {
            case ON -> Boolean.TRUE;
            case OFF -> cap.offSwitch() ? Boolean.FALSE : null;
            case DEFAULT -> null;
        };
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
     * What {@code /api/show} says about this model's sight — the capability
     * knowledge card 252 lifts out of this class so the agent can consult it
     * while BUILDING the request, instead of only here, one layer below it.
     *
     * <p>Best effort, unchanged in its failure behaviour: no answer (an older
     * ollama that reports no capabilities, an unreachable server) is
     * {@code UNKNOWN}, never {@code BLIND} — the chat call reports real
     * errors, and a probe that could not run must not withhold an image.</p>
     *
     * @return SEES, BLIND, or UNKNOWN when the server said nothing useful
     */
    @Override
    public Vision vision() {
        if (vision != Vision.UNKNOWN) {
            return vision;
        }
        List<String> capabilities;
        try {
            capabilities = api.show(new OllamaApi.ShowRequest(model)).capabilities();
        } catch (RuntimeException unavailable) {
            return Vision.UNKNOWN; // network problems are reported by the actual chat call
        }
        if (capabilities == null) {
            return Vision.UNKNOWN; // no capability details: do not block
        }
        vision = capabilities.contains("vision") ? Vision.SEES : Vision.BLIND;
        return vision;
    }

    /** Fails fast when the configured model cannot see — the belt behind card
     *  252's fence. The agent normally withholds the image before it gets here,
     *  but a face that drives this provider directly (the CLI, a sample, a
     *  subagent built without the loop) still must not have its image silently
     *  dropped by ollama's chat API. */
    private void assertVisionModel() {
        if (vision() == Vision.BLIND) {
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
