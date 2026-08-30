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
import org.springframework.web.client.HttpClientErrorException;

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
     * @param dialect the provider label this endpoint answers to — one of the
     *                OpenAI-compatible members of
     *                {@link dev.spectroscope.core.config.SpectroConfig#KNOWN_PROVIDERS},
     *                or null to infer from the base URL. Not spelled out here:
     *                the list that stood in its place named five and missed
     *                llamacpp, which this class special-cases twice. The
     *                dialects with rows of their own are the keys of
     *                {@code reasoning/capabilities.json}; the reasoning fields
     *                differ per dialect, nothing else does
     */
    public record Options(String baseUrl, String model, String apiKey, String dialect) {

        /**
         * Dialect-free options — pre-card-88 call sites; the dialect is
         * inferred from the base URL (cloud = openai, else a generic
         * llama.cpp-style local server).
         *
         * @param baseUrl the server root
         * @param model   the model name requests are sent to
         * @param apiKey  optional bearer key
         */
        public Options(String baseUrl, String model, String apiKey) {
            this(baseUrl, model, apiKey, null);
        }
    }

    private static final ObjectMapper JSON = new ObjectMapper();

    private final RestClient http;
    private final String model;

    /** Kept for the wire decision: the cloud takes the modern completion cap. */
    private final String baseUrl;

    /** The provider label this endpoint answers to — decides the reasoning fields. */
    private final String dialect;

    /** Kept for the wire record's headers: the tap gets the REAL value, the recorder redacts. */
    private final String apiKey;

    /** What this endpoint has TAUGHT us about the model's sight (card 252).
     *  There is nothing to probe here: the OpenAI wire has no capability call —
     *  {@code /v1/models} lists ids, not what they accept — so the server's own
     *  refusal is the only fact available, and it arrives exactly once. Holding
     *  it on the provider makes it session-scoped by construction (the server
     *  builds one provider per session), which is the scope that matters: the
     *  wedged session heals on the NEXT prompt, not at the next app start. */
    private volatile Vision vision = Vision.UNKNOWN;

    /** The loaded window this endpoint reported, memoized (card 263). Zero is
     *  never cached: a just-in-time backend can have nothing loaded when the
     *  first run starts and the right answer a minute later. */
    private volatile int contextWindow;

    /** Set once the server has said, in so many words, that it does not serve
     *  this route — a 4xx. That answer does not expire, and remembering it is
     *  what keeps every endpoint which structurally cannot answer (openai,
     *  openrouter, llama.cpp, vLLM, the gemini gateway) from being re-probed on
     *  every run and every child run for the life of the session. A timeout or
     *  a 5xx is NOT this: those say nothing about the route. */
    private volatile boolean capabilityRouteAbsent;

    /** A SECOND client for capability questions only, with a read timeout the
     *  chat client must never have — that one streams, and a deadline on it
     *  would cut long answers off mid-sentence. Two seconds is a local listing's
     *  budget; past that the run starts on the fallback rather than waiting. */
    private final RestClient capabilities;

    /**
     * Builds the provider; the Bearer header is attached only when a key is configured.
     *
     * @param options base URL (trailing slash stripped), model name and optional API key
     */
    public OpenAiCompatProvider(Options options) {
        // The JDK HttpClient transport, NOT the default HttpURLConnection one:
        // closing the JDK client's RAW body stream cancels the subscription and
        // tears the connection down promptly — the stop button's whole mechanism.
        // (Spring's response-level close drains regardless of transport; the
        // iterator therefore closes the raw stream, see SseIterator.)
        RestClient.Builder builder = RestClient.builder()
                .baseUrl(options.baseUrl().replaceAll("/$", ""))
                .requestFactory(new JdkClientHttpRequestFactory());
        if (options.apiKey() != null && !options.apiKey().isBlank()) {
            builder.defaultHeader("Authorization", "Bearer " + options.apiKey());
        }
        this.http = builder.build();
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
        // The SAME key the chat wire carries. Without it, LM Studio with its
        // API-key setting on, a vLLM started with --api-key or a LiteLLM proxy
        // answers 401 to the probe, the blanket catch below swallows it, and the
        // run lands on the fallback with nothing said anywhere.
        RestClient.Builder probeBuilder = RestClient.builder().requestFactory(probeFactory);
        if (options.apiKey() != null && !options.apiKey().isBlank()) {
            probeBuilder.defaultHeader("Authorization", "Bearer " + options.apiKey());
        }
        this.capabilities = probeBuilder.build();
        this.model = options.model();
        this.baseUrl = options.baseUrl();
        this.dialect = options.dialect();
        this.apiKey = options.apiKey();
    }

    @Override
    public String modelName() {
        return model;
    }

    /** The OpenAI-compatible root this provider dials — LM Studio's own address
     *  when card 193's per-provider field is set, the shared legacy chain
     *  otherwise. The faces print what is here, never a config field. */
    @Override
    public String endpoint() {
        return baseUrl;
    }

    /**
     * The window the loaded instance serves, from LM Studio's OWN REST listing
     * (card 263) — memoized, and asked at most once per run.
     *
     * <p>Deliberately {@code /api/v1/models} and not the OpenAI-compatible
     * {@code /v1/models}: the compatible listing carries ids and nothing else,
     * while LM Studio's own answers {@code loaded_instances[].config
     * .context_length} per model. Nothing here is LM Studio-gated by dialect —
     * the operator's LM Studio sits on a Tailscale host, not on localhost, and a
     * host heuristic is exactly what card 193 had to unpick. A server without
     * that endpoint answers 404, the parse finds nothing, and the run lands on
     * the documented fallback having spent one request.</p>
     *
     * <p>Only a POSITIVE answer is remembered. A local backend may load models
     * just in time, so the very first run of a session can legitimately find
     * nothing loaded; freezing that into "unknowable" would deny the truth
     * to every later run of the session.</p>
     *
     * @return the loaded instance's context length, or 0 when nothing is known
     */
    @Override
    public int contextWindow() {
        int known = contextWindow;
        if (known > 0) {
            return known;
        }
        if (capabilityRouteAbsent) {
            return 0;
        }
        int probed = probeContextWindow();
        if (probed > 0) {
            contextWindow = probed;
        }
        return probed;
    }

    /** One best-effort GET, on the short-timeout client. Never throws: a
     *  capability question may not be able to fail a run.
     *  @return the loaded window, or 0 on any refusal, timeout or surprise */
    private int probeContextWindow() {
        boolean props = readsWindowFromProps(dialect);
        try {
            String body = capabilities.get()
                    .uri(props ? propsUrl(baseUrl) : capabilityUrl(baseUrl))
                    .retrieve()
                    .body(String.class);
            if (body == null) {
                return 0;
            }
            return props
                    ? loadedWindowFromProps(JSON.readTree(body))
                    : loadedWindow(JSON.readTree(body), model);
        } catch (HttpClientErrorException definitive) {
            // The server answered, and its answer is "no such route here". That
            // is a verdict, not a moment — unlike an empty listing, which is
            // what a just-in-time backend says before it has loaded anything.
            capabilityRouteAbsent = true;
            return 0;
        } catch (Exception nothingLearned) {
            return 0;
        }
    }

    /**
     * What LM Studio's listing says about ONE model's loaded window.
     *
     * <p>The listing shape, read off the owner's backend on 2026-08-18:
     * {@code {"models":[{"key":…,"max_context_length":1048576,
     * "loaded_instances":[{"id":…,"config":{"context_length":204288}}]}]}}.
     * A model matches on its {@code key} or on any loaded instance's {@code id}
     * — a session may name either — and the answer is the SMALLEST window among
     * that model's loaded instances, because the next request may land on any
     * of them and only the smallest is true whichever one answers.</p>
     *
     * <p>{@code max_context_length} is read by nobody on purpose. It is the
     * ceiling the model COULD be loaded with; taking it would push compaction
     * past the window the server is actually holding — the one direction worse
     * than the constant this card removes. An installed but unloaded model
     * therefore teaches nothing, which is the honest answer.</p>
     *
     * @param listing the parsed response body, whatever it turned out to be
     * @param model   the model id this provider sends to; null teaches nothing
     * @return the loaded context length in tokens, or 0 when nothing is known
     */
    static int loadedWindow(JsonNode listing, String model) {
        if (listing == null || model == null) {
            return 0;
        }
        int smallest = 0;
        for (JsonNode entry : listing.path("models")) {
            JsonNode instances = entry.path("loaded_instances");
            boolean mine = model.equals(entry.path("key").asText(null));
            if (!mine) {
                for (JsonNode instance : instances) {
                    mine = mine || model.equals(instance.path("id").asText(null));
                }
            }
            if (!mine) {
                continue;
            }
            for (JsonNode instance : instances) {
                int window = instance.path("config").path("context_length").asInt(0);
                if (window > 0 && (smallest == 0 || window < smallest)) {
                    smallest = window;
                }
            }
        }
        return smallest;
    }

    /**
     * Where LM Studio's own REST listing hangs off a configured base URL.
     *
     * <p>The chat wire lives under {@code /v1} and this listing under
     * {@code /api/v1}, both on the same root — but the configured base may
     * already carry the version segment ({@code SpectroConfig.compatPath}
     * tolerates that, and gemini's preset ends in {@code /v1beta/openai}).
     * Appending blindly would dial {@code /v1/api/v1/models} and learn nothing,
     * silently.</p>
     *
     * @param baseUrl the configured server root, versioned or not
     * @return the absolute URL of the capability listing
     */
    static String capabilityUrl(String baseUrl) {
        String root = baseUrl == null ? "" : baseUrl.replaceAll("/+$", "");
        root = root.replaceAll("/v1beta/openai$", "").replaceAll("/v\\d+$", "");
        return root + "/api/v1/models";
    }

    /**
     * Whether this endpoint answers the context window at {@code GET /props}
     * instead of the LM Studio-shaped model listing.
     *
     * <p>True for exactly the two dialects that ARE a llama.cpp server: the
     * operator's own ({@code llamacpp}, card 312) and the bundled runtime
     * ({@code spectro-local}). They are one engine behind two names — the
     * bundled binary is a stock {@code llama-server} — so they must not answer
     * the same question through two different doors, one of them a guess.</p>
     *
     * <p>Everything else keeps the listing route. A null dialect in particular
     * is an operator's own OpenAI-compatible server of unknown make: asking it
     * for {@code /props} would spend a request on a route it probably does not
     * serve.</p>
     *
     * @param dialect the provider label this endpoint answers to, or null
     * @return whether to ask {@code /props} for the loaded window
     */
    static boolean readsWindowFromProps(String dialect) {
        return "llamacpp".equals(dialect) || "spectro-local".equals(dialect);
    }

    /**
     * The absolute URL of llama.cpp's {@code /props}. It hangs off the server
     * ROOT, not the OpenAI-compatible {@code /v1} path, so a base URL that was
     * pasted with the version suffix is trimmed the same way
     * {@link #capabilityUrl} trims it.
     *
     * @param baseUrl the configured server root, versioned or not
     * @return the absolute URL of the properties endpoint
     */
    static String propsUrl(String baseUrl) {
        String root = baseUrl == null ? "" : baseUrl.replaceAll("/+$", "");
        root = root.replaceAll("/v1beta/openai$", "").replaceAll("/v\\d+$", "");
        return root + "/props";
    }

    /**
     * What llama.cpp's {@code /props} says the loaded model's window is.
     *
     * <p>The shape, read off the bundled binary on 2026-08-30 (build b10107,
     * started with {@code -c 4096}):
     * {@code {"default_generation_settings":{"n_ctx":4096},"total_slots":4,…}}.
     * {@code n_ctx} there is the window ONE request gets, not the sum across
     * slots — the same run's server log reads {@code n_slots = 4, n_ctx_slot =
     * 4096} — and it tracked {@code -c} exactly when the server was restarted
     * at 2048.</p>
     *
     * <p>Unlike the LM Studio listing this needs no model id to match on: one
     * llama-server holds one model, and the model field in a request is
     * ignored, so there is nothing a window could be keyed by.</p>
     *
     * <p>A non-positive value teaches nothing rather than being taken: llama.cpp
     * spells "unset" as {@code -1} in neighbouring fields, and a negative window
     * would reach the compactor as a negative divisor.</p>
     *
     * <p>Public so the doctor reads the window through THIS function rather than
     * spelling the field path a second time; a shape that changes must break one
     * place, not drift between two.</p>
     *
     * @param props the parsed {@code /props} body, or null
     * @return the loaded context length in tokens, or 0 when nothing is known
     */
    public static int loadedWindowFromProps(JsonNode props) {
        if (props == null) {
            return 0;
        }
        int window = props.path("default_generation_settings").path("n_ctx").asInt(0);
        return Math.max(window, 0);
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
                       // openrouter's unified reasoning object — its gateway does
                       // NOT read the flat reasoning_effort field.
                       Map<String, Object> reasoning,
                       // llama.cpp jinja template variables. The bundled engine's
                       // qwen3 templates gate reasoning on enable_thinking; a
                       // template without the variable ignores it.
                       @JsonProperty("chat_template_kwargs") Map<String, Object> chatTemplateKwargs,
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
     * thinking arm: a retryable status (per {@link RetryPolicy}) is
     * transient; everything else (401 bad key, 404 ...) is terminal and
     * deliberately NOT an IO type, because RetryPolicy classifies
     * IOExceptions transient and re-sending an identical doomed request
     * would only add latency.
     *
     * <p>Card 252 adds the vision arm, and it is NARROWER than ollama's on
     * purpose. Ollama treats any 400 on an image-bearing request as a blind
     * model; here the body must actually name images, because this transport
     * serves every OpenAI-compatible endpoint there is and a 400 from one of
     * those is as likely to be a rejected tool schema or an overlong context.
     * Marking a model blind on one of those would silently stop sending images
     * to a model that can see them — the fence would then be lying, and in the
     * one direction nobody would notice.</p>
     *
     * @param status    the HTTP status the server answered with
     * @param detail    the response body text
     * @param hasImages whether the failed request carried image content
     * @return the exception to throw — transient or terminal, never null
     */
    private RuntimeException classifyHttpFailure(int status, String detail, boolean hasImages) {
        String lowered = detail.toLowerCase(Locale.ROOT);
        boolean namesImages = lowered.contains("image") || lowered.contains("vision")
                || lowered.contains("multimodal");
        if (hasImages && namesImages && status >= 400 && status < 500) {
            vision = Vision.BLIND; // learned: the fence closes on the next request
            return new IllegalStateException("Model without vision: \"" + model
                    + "\" cannot process images — the server refused the request. "
                    + "The attachment stays in the session; the next prompt goes out "
                    + "without it. Server said: " + detail);
        }
        String message = "OpenAI-compatible server HTTP " + status
                + (detail.isBlank() ? "" : ": " + detail);
        if (RetryPolicy.retryableStatus(status)) {
            return new TransientProviderException(message);
        }
        return new IllegalStateException(message);
    }

    /** What this endpoint has taught us about the model's sight — UNKNOWN until
     *  a refusal names images, because nothing here can be asked in advance. */
    @Override
    public Vision vision() {
        return vision;
    }

    /** Reads SSE lines lazily and translates chunks into neutral events. */
    private final class SseIterator implements Iterator<ProviderEvent> {

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
            // absolute URL, not a base-relative path: a leading-slash path would
            // REPLACE gemini's /v1beta/openai base path instead of extending it.
            String root = baseUrl.replaceAll("/$", "");
            String url = root + compatPath(root, "/chat/completions");
            // The body is serialized HERE and posted as that exact string; the
            // tap records the same string, so recorded == posted by construction
            // and the record's "bytes" fidelity is true, not asserted.
            String bodyJson = toJson(toChatRequest(request));
            // Card 252: computed from the NEUTRAL request, before the wire
            // translation folds images into content parts — the failure arm needs
            // to know whether this request was one an image could have broken.
            boolean hasImages = request.messages().stream()
                    .anyMatch(message -> message.content().stream()
                            .anyMatch(ImageContent.class::isInstance));
            LlmWireTap.Exchange wire = request.tap() == null ? null
                    : request.tap().begin(new LlmWireTap.WireRequest(providerLabel(),
                            model, "http", "POST", url, requestHeaders(), "bytes",
                            bodyJson, System.currentTimeMillis()));
            this.wire = wire;
            final OpenResponse open;
            try {
                open = http.post()
                        .uri(url)
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
                            // response: Spring's close() DRAINS the remaining body first
                            // (StreamUtils.drain), so a mid-generation cancel would sit on
                            // the cancelling thread reading the model's whole remaining
                            // output while the server never sees a disconnect (15.8 s
                            // measured against llama-server, card 78). The raw JDK stream
                            // close cancels the body subscription and tears the connection
                            // down — the server notices and stops generating.
                            InputStream bodyStream = clientResponse.getBody();
                            return new OpenResponse(clientResponse.getStatusCode().value(),
                                    new BufferedReader(new InputStreamReader(
                                            bodyStream, StandardCharsets.UTF_8)),
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
                if (wire != null) {
                    wire.line(line); // teed verbatim, BEFORE any interpretation
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
                endWire(false, failure.getMessage());
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
            endWire(false, null);
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
         * Closes the wire exchange, when one is recording. The status is the one
         * the server REALLY answered (captured in the exchange callback — a
         * redirect or an odd 2xx must never be recorded as a fabricated 200);
         * teed lines stay with the record even on an abort, because a partial
         * answer is still an answer received.
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
     * Status, reader and close hook for a response kept open past the exchange call.
     *
     * @param status the HTTP status the server actually answered
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

    // ---- request mapping ------------------------------------------------------

    /**
     * The wire record's provider label: the configured dialect where one is
     * set, otherwise inferred the same way the reasoning wire infers (the
     * cloud is "openai", any other base is an honest "openai-compat").
     *
     * @return the label the llm-wire record carries
     */
    private String providerLabel() {
        return dialect != null ? dialect
                : isOpenAiCloud(baseUrl) ? "openai" : "openai-compat";
    }

    /**
     * The headers one chat request actually sets, REAL values included: the
     * recorder redacts credential values, the provider never pre-redacts.
     *
     * @return the headers as posted, insertion-ordered
     */
    private Map<String, String> requestHeaders() {
        Map<String, String> headers = new LinkedHashMap<>();
        if (apiKey != null && !apiKey.isBlank()) {
            headers.put("Authorization", "Bearer " + apiKey);
        }
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
     * The path to append to an OpenAI-compatible base URL. Bare-host backends
     * (openai {@code https://api.openai.com}, openrouter {@code …/api}, lmstudio
     * {@code http://localhost:1234}) carry the version in a {@code /v1} segment,
     * so they take {@code /v1} + suffix. Gemini's compat surface is exposed at
     * {@code …/v1beta/openai}, which already carries the version, so paths hang
     * directly off it. A custom base an operator sets that already ends in a
     * version segment (openai's documented {@code …/v1}, a proxy at {@code …/v1})
     * counts as already-versioned too, so it never gets a doubled {@code /v1/v1}.
     * Used for both {@code /chat/completions} and {@code /models}.
     *
     * @param baseUrl the provider's endpoint root
     * @param suffix  the endpoint path, e.g. {@code /chat/completions} or {@code /models}
     * @return the path to request, relative to {@code baseUrl}
     */
    public static String compatPath(String baseUrl, String suffix) {
        String base = baseUrl == null ? "" : baseUrl.replaceAll("/+$", "");
        boolean alreadyVersioned = base.contains("/v1beta/openai") || base.matches(".*/v\\d+");
        return (alreadyVersioned ? "" : "/v1") + suffix;
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
        ReasoningWire reasoning = reasoningWireFor(dialect, baseUrl, model, !tools.isEmpty(),
                request.reasoning(), request.effort());
        return new ChatRequest(model, true, messages, tools.isEmpty() ? null : tools,
                cloud ? null : cap, cloud ? cap : null,
                reasoning.reasoningEffort(), reasoning.reasoning(), reasoning.chatTemplateKwargs(),
                new StreamOptions(true));
    }

    /**
     * The reasoning fields one request puts on this wire — at most one of the
     * three is set, all-null means the request says nothing.
     *
     * @param reasoningEffort    the flat OpenAI/gemini/llama.cpp field, or null
     * @param reasoning          openrouter's unified object, or null
     * @param chatTemplateKwargs llama.cpp template variables, or null
     */
    record ReasoningWire(String reasoningEffort, Map<String, Object> reasoning,
                         Map<String, Object> chatTemplateKwargs) {
        static final ReasoningWire NOTHING = new ReasoningWire(null, null, null);
    }

    /**
     * Maps (mode, effort) onto THIS endpoint's reasoning dialect, gated by the
     * static {@link ReasoningCapability} so the request never pretends:
     *
     * <ul>
     * <li><b>openai cloud</b> — gpt-5.x chat/completions REFUSES function tools
     *     unless the effort is explicitly "none" ("use /v1/responses or set
     *     reasoning_effort to 'none'"); that rule outranks any requested effort.
     *     Otherwise a listed effort passes through, and OFF spends "none" only
     *     where the model's row lists it (gpt-5/o-series reject it).</li>
     * <li><b>gemini</b> (/v1beta/openai) — same flat field; "none" is legal
     *     only on 2.5-flash/-lite, so OFF elsewhere sends nothing.</li>
     * <li><b>openrouter</b> — the nested {@code reasoning} object; effort values
     *     ride verbatim (the gateway snaps unsupported ones), OFF is
     *     {@code enabled:false}.</li>
     * <li><b>lmstudio</b> — per-request control does not exist on
     *     chat/completions (upstream bugs #988/#1250): nothing, ever.</li>
     * <li><b>spectro-local</b> — the bundled llama-server. MEASURED 2026-07-28
     *     (build b10107, Qwen3-1.7B): {@code reasoning_effort:"none"} is
     *     silently ignored, {@code chat_template_kwargs.enable_thinking=false}
     *     suppresses reasoning completely (300 reasoning tokens vs 0). OFF
     *     spends the kwarg on the catalogue models whose row has an off
     *     switch.</li>
     * <li><b>generic local base</b> (no dialect) — best-effort: OFF sends BOTH
     *     accepted llama.cpp forms, an effort passes through; a server that
     *     understands neither ignores unknown fields.</li>
     * </ul>
     *
     * @param dialect  the provider label, or null to infer from the base URL
     * @param baseUrl  the endpoint root
     * @param model    the model id to run
     * @param hasTools whether the request advertises function tools
     * @param mode     the call site's reasoning mode
     * @param effort   the requested effort level, or null
     * @return the fields to put on the wire; {@link ReasoningWire#NOTHING} when
     *         the endpoint has no honest field for the request
     */
    static ReasoningWire reasoningWireFor(String dialect, String baseUrl, String model,
                                          boolean hasTools, ProviderRequest.Reasoning mode,
                                          String effort) {
        String d = dialect != null ? dialect
                : isOpenAiCloud(baseUrl) ? "openai" : "llamacpp";
        if ("openai".equals(d) && !isOpenAiCloud(baseUrl)) {
            d = "llamacpp"; // the label says cloud, the endpoint is a local server
        }
        boolean off = mode == ProviderRequest.Reasoning.OFF;
        ReasoningCapability cap = ReasoningCapabilities.resolve(d, model);
        return switch (d) {
            case "openai" -> {
                if (model.startsWith("gpt-5") && hasTools) {
                    yield new ReasoningWire("none", null, null);
                }
                if (!off && effort != null && cap.efforts().contains(effort)) {
                    yield new ReasoningWire(effort, null, null);
                }
                yield off && cap.offSwitch()
                        ? new ReasoningWire("none", null, null) : ReasoningWire.NOTHING;
            }
            case "gemini" -> {
                if (!off && effort != null && cap.efforts().contains(effort)) {
                    yield new ReasoningWire(effort, null, null);
                }
                yield off && cap.offSwitch()
                        ? new ReasoningWire("none", null, null) : ReasoningWire.NOTHING;
            }
            case "openrouter" -> {
                if (off) {
                    yield new ReasoningWire(null, Map.of("enabled", false), null);
                }
                yield effort != null
                        ? new ReasoningWire(null, Map.of("effort", effort), null)
                        : ReasoningWire.NOTHING;
            }
            case "spectro-local" -> off && cap.offSwitch()
                    ? new ReasoningWire(null, null, Map.of("enable_thinking", false))
                    : ReasoningWire.NOTHING;
            case "lmstudio" -> ReasoningWire.NOTHING;
            default -> {
                if (off) {
                    yield new ReasoningWire("none", null, Map.of("enable_thinking", false));
                }
                yield effort != null
                        ? new ReasoningWire(effort, null, null) : ReasoningWire.NOTHING;
            }
        };
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
