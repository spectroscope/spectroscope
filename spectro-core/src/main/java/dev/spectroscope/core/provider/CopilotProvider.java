package dev.spectroscope.core.provider;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.github.copilot.AllowCopilotExperimental;
import com.github.copilot.CopilotClient;
import com.github.copilot.CopilotSession;
import com.github.copilot.SystemMessageMode;
import com.github.copilot.generated.AssistantMessageDeltaEvent;
import com.github.copilot.generated.AssistantMessageEvent;
import com.github.copilot.generated.AssistantReasoningDeltaEvent;
import com.github.copilot.generated.AssistantUsageEvent;
import com.github.copilot.generated.SessionErrorEvent;
import com.github.copilot.generated.SessionEvent;
import com.github.copilot.generated.SessionIdleEvent;
import com.github.copilot.rpc.BlobAttachment;
import com.github.copilot.rpc.CopilotClientOptions;
import com.github.copilot.rpc.GitHubTokenProviderResult;
import com.github.copilot.rpc.InfiniteSessionConfig;
import com.github.copilot.rpc.MessageAttachment;
import com.github.copilot.rpc.MessageOptions;
import com.github.copilot.rpc.ModelInfo;
import com.github.copilot.rpc.PermissionRequest;
import com.github.copilot.rpc.PermissionRequestResult;
import com.github.copilot.rpc.SessionConfig;
import com.github.copilot.rpc.SystemMessageConfig;
import com.github.copilot.rpc.ToolBinaryResult;
import com.github.copilot.rpc.ToolDefinition;
import com.github.copilot.rpc.ToolInvocation;
import com.github.copilot.rpc.ToolResultObject;
import com.github.copilot.rpc.ToolSet;
import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.provider.LlmProvider.PStop.StopReason;
import dev.spectroscope.core.wire.LlmWireTap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.Closeable;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * GitHub Copilot as an {@link LlmProvider}, on the official Java SDK
 * ({@code com.github:copilot-sdk-java}, card 494). macOS only.
 *
 * <p>The SDK starts the Copilot runtime (the {@code copilot} CLI) as a child
 * process and talks JSON-RPC to it. The runtime owns the conversation and runs
 * an agent loop of its own; card 478 measured how to keep the harness loop in
 * charge instead:</p>
 *
 * <ul>
 * <li>Built-in and MCP tools are switched off ({@code availableTools =
 * custom:*}, {@code excludedTools = builtin:*, mcp:*}). The harness tools are
 * registered as custom tools only so the model can see them.</li>
 * <li>When the model calls one, the SDK hands it to a handler here, which parks
 * an open future and yields a {@link PToolCall}. The stream then ends with
 * {@code TOOL_USE}. The harness runs the tool in its own loop, and the next
 * {@link #stream} completes the parked future with the harness's result; the
 * runtime then makes its next model call. One stream is one model call.</li>
 * <li>The permission handler approves exactly one thing: a custom tool this
 * provider registered. Everything else the runtime asks for is refused.</li>
 * </ul>
 *
 * <p><b>The runtime holds the history.</b> The SDK cannot take a transcript, so
 * this class keeps one runtime session per harness conversation and sends only
 * what is new. A request whose history continues one the runtime has seen
 * reuses that session. Any other history (harness compaction, a resumed
 * session, an edit) opens a new runtime session whose first message carries the
 * earlier conversation as plain text.</p>
 *
 * <p><b>Credentials.</b> Token variables are removed from the runtime's
 * environment. A {@link TokenSource} hands a token to the runtime through the
 * SDK's token callback; without one, the stored CLI login is read only when
 * {@link Options#useStoredLogin()} says the user chose it. No token is
 * logged, recorded on the wire tap, or put into an error message.</p>
 */
@AllowCopilotExperimental
public final class CopilotProvider implements LlmProvider, AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(CopilotProvider.class);

    /** The provider label on {@code run_start} and on the wire record. */
    public static final String NAME = "copilot";

    /**
     * Variables that would hand the runtime a credential behind the user's back.
     * The first three are the CLI's documented token variables; the last two
     * point the runtime at a direct API token (docs.github.com, Copilot SDK
     * authentication, read 2026-10-09).
     */
    static final List<String> TOKEN_VARIABLES = List.of("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN",
            "GITHUB_COPILOT_API_TOKEN", "COPILOT_API_URL");

    private static final ObjectMapper JSON = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

    /**
     * Runtime sessions kept open at once; the least recently used one closes
     * first. Nobody has measured how many sessions one runtime holds well.
     */
    @Governs(kind = Governs.Kind.UNEXAMINED, unit = Governs.Unit.COUNT)
    private static final int MAX_CONVERSATIONS = 8;

    /**
     * A silence this long during a stream makes the provider ping the runtime,
     * which is how a runtime that died is told from a model that is thinking.
     */
    @Governs(kind = Governs.Kind.UNEXAMINED, unit = Governs.Unit.MILLISECONDS)
    private static final long PROBE_AFTER_MS = 500;

    /** A ping slower than this counts as a busy runtime, not a dead one. */
    @Governs(kind = Governs.Kind.UNEXAMINED, unit = Governs.Unit.MILLISECONDS)
    private static final long PING_TIMEOUT_MS = 2_000;

    /**
     * How long a cancelled turn waits for the runtime's idle before it returns.
     * Card 478 measured the idle 9 ms after abort; this is a ceiling, not that.
     */
    @Governs(kind = Governs.Kind.UNEXAMINED, unit = Governs.Unit.MILLISECONDS)
    private static final long ABORT_SETTLE_MS = 5_000;

    /** How long the runtime may take to start. Card 478 measured 574 and 752 ms. */
    @Governs(kind = Governs.Kind.UNEXAMINED, unit = Governs.Unit.SECONDS)
    private static final long START_TIMEOUT_S = 60;

    /** How long one request to the runtime may take before the stream fails. */
    @Governs(kind = Governs.Kind.UNEXAMINED, unit = Governs.Unit.SECONDS)
    private static final long CALL_TIMEOUT_S = 60;

    private final Options options;
    private final String osName;
    private final String cliUrl;
    private final List<Conversation> conversations = new ArrayList<>();
    private CopilotClient client;
    private Thread shutdownHook;
    private volatile List<CopilotModel> models;

    /**
     * What the provider is built from.
     *
     * @param model          the Copilot model id, for example {@code claude-sonnet-5} or {@code auto}
     * @param cliPath        the {@code copilot} executable the SDK starts (card 497 finds it)
     * @param tokenSource    where a GitHub token comes from (card 495), or null
     * @param useStoredLogin true when the user chose the login the CLI already stores;
     *                       ignored when a token source is given
     */
    public record Options(String model, String cliPath, TokenSource tokenSource, boolean useStoredLogin) {}

    /** Supplies a GitHub token when the runtime asks for one (initially and on refresh). */
    @FunctionalInterface
    public interface TokenSource {
        /**
         * Returns a token for the runtime. Called on the SDK's thread.
         *
         * @param host   the GitHub host the runtime authenticates against
         * @param reason {@code initial} or {@code refresh}, as the runtime says it
         * @return the token and how many seconds it stays valid
         * @throws Exception when no token can be had; the runtime then fails the request
         */
        Token token(String host, String reason) throws Exception;
    }

    /**
     * A GitHub token. {@link #toString()} never shows the value.
     *
     * @param value            the token itself
     * @param expiresInSeconds seconds until it expires
     */
    public record Token(String value, long expiresInSeconds) {
        @Override
        public String toString() {
            return "Token[value=<redacted>, expiresInSeconds=" + expiresInSeconds + "]";
        }
    }

    /**
     * One entry of the runtime's model list.
     *
     * @param id            the model id to put into {@link Options#model()}
     * @param name          the display name
     * @param vision        SEES or BLIND when the runtime says so, UNKNOWN otherwise
     * @param contextWindow the prompt limit the runtime states, else its context window, else 0
     */
    public record CopilotModel(String id, String name, Vision vision, int contextWindow) {}

    /**
     * A provider that starts the runtime at {@link Options#cliPath()} on first use.
     *
     * @param options model, runtime path and credential choice
     */
    public CopilotProvider(Options options) {
        this(options, System.getProperty("os.name"), null);
    }

    /**
     * Visible for the fake-runtime tests: {@code cliUrl} connects to a runtime
     * that is already listening instead of starting one.
     */
    CopilotProvider(Options options, String osName, String cliUrl) {
        this.options = Objects.requireNonNull(options, "options");
        this.osName = osName;
        this.cliUrl = cliUrl;
    }

    /**
     * @param osName the value of the {@code os.name} property
     * @return true on macOS, the only platform this provider runs on (card 494)
     */
    static boolean supportedPlatform(String osName) {
        return osName != null && osName.toLowerCase(Locale.ROOT).startsWith("mac");
    }

    /**
     * The environment the runtime starts with: the caller's, minus every token variable.
     *
     * @param env the environment to start from
     * @return a copy without {@link #TOKEN_VARIABLES}
     */
    static Map<String, String> runtimeEnvironment(Map<String, String> env) {
        Map<String, String> copy = new HashMap<>(env);
        TOKEN_VARIABLES.forEach(copy::remove);
        return copy;
    }

    private void requireSupportedPlatform() {
        if (!supportedPlatform(osName)) {
            throw new UnsupportedOperationException("copilot: not supported on this platform (" + osName
                    + "); the Copilot provider runs on macOS only");
        }
    }

    @Override
    public String modelName() {
        return options.model();
    }

    @Override
    public String providerName() {
        return NAME;
    }

    // ---- the model list ------------------------------------------------------

    /**
     * The models the runtime offers this account, asked once and remembered.
     *
     * @return the runtime's model list, in its order
     */
    public List<CopilotModel> models() {
        requireSupportedPlatform();
        List<CopilotModel> known = models;
        if (known == null) {
            List<ModelInfo> listed = await(client().listModels(), CALL_TIMEOUT_S, "list the models");
            known = listed.stream().map(CopilotProvider::toModel).toList();
            models = known;
        }
        return known;
    }

    private static CopilotModel toModel(ModelInfo info) {
        Vision vision = Vision.UNKNOWN;
        int window = 0;
        var capabilities = info.getCapabilities();
        if (capabilities != null && capabilities.getSupports() != null) {
            vision = capabilities.getSupports().isVision() ? Vision.SEES : Vision.BLIND;
        }
        if (capabilities != null && capabilities.getLimits() != null) {
            Integer prompt = capabilities.getLimits().getMaxPromptTokens();
            window = prompt != null && prompt > 0 ? prompt : capabilities.getLimits().getMaxContextWindowTokens();
        }
        return new CopilotModel(info.getId(), info.getName(), vision, Math.max(0, window));
    }

    private CopilotModel chosenModel() {
        if (!supportedPlatform(osName)) {
            return null;
        }
        try {
            for (CopilotModel model : models()) {
                if (model.id().equals(options.model())) {
                    return model;
                }
            }
        } catch (RuntimeException unknown) {
            log.debug("copilot: model list unavailable, nothing is claimed about the model", unknown);
        }
        return null;
    }

    /**
     * The prompt limit the runtime states for the chosen model (its
     * {@code max_prompt_tokens}, else {@code max_context_window_tokens}).
     *
     * @return the window in tokens, or 0 when the runtime states none
     */
    @Override
    public int contextWindow() {
        CopilotModel model = chosenModel();
        return model == null ? 0 : model.contextWindow();
    }

    @Override
    public int publishedWindow() {
        return contextWindow();
    }

    @Override
    public Vision vision() {
        CopilotModel model = chosenModel();
        return model == null ? Vision.UNKNOWN : model.vision();
    }

    // ---- the runtime --------------------------------------------------------

    private synchronized CopilotClient client() {
        requireSupportedPlatform();
        if (client != null) {
            return client;
        }
        CopilotClientOptions clientOptions = new CopilotClientOptions();
        if (cliUrl != null) {
            clientOptions.setCliUrl(cliUrl);
        } else {
            String path = options.cliPath();
            if (path == null || path.isBlank()) {
                throw new IllegalStateException("copilot: no runtime is configured; install the Copilot CLI"
                        + " and name the path of its copilot executable");
            }
            clientOptions.setCliPath(path)
                    .setLogLevel("warning")
                    .setUseLoggedInUser(options.tokenSource() == null && options.useStoredLogin())
                    .setEnvironment(runtimeEnvironment(System.getenv()));
        }
        CopilotClient started = new CopilotClient(clientOptions);
        try {
            await(started.start(), START_TIMEOUT_S, "start the runtime");
        } catch (RuntimeException failure) {
            started.close();
            throw failure;
        }
        client = started;
        // The runtime is a child process: it goes when this JVM goes, even
        // when nobody calls close().
        shutdownHook = new Thread(started::forceStop, "copilot-runtime-stop");
        Runtime.getRuntime().addShutdownHook(shutdownHook);
        return client;
    }

    /** Stops every runtime session and the runtime process. */
    @Override
    public void close() {
        List<Conversation> open;
        CopilotClient running;
        synchronized (this) {
            open = new ArrayList<>(conversations);
            conversations.clear();
            running = client;
            client = null;
        }
        open.forEach(Conversation::close);
        if (running != null) {
            try {
                running.stop().get(10, TimeUnit.SECONDS);
            } catch (Exception slow) {
                log.debug("copilot: runtime did not stop in time, forcing it", slow);
                running.forceStop();
            }
            removeShutdownHook();
        }
    }

    private synchronized void removeShutdownHook() {
        if (shutdownHook != null) {
            try {
                Runtime.getRuntime().removeShutdownHook(shutdownHook);
            } catch (IllegalStateException shuttingDown) {
                // the JVM is already stopping and runs the hook itself
            }
            shutdownHook = null;
        }
    }

    // ---- streaming ------------------------------------------------------------

    @Override
    public Iterable<ProviderEvent> stream(ProviderRequest request) {
        requireSupportedPlatform();
        if (request.signal() != null && request.signal().isCancelled()) {
            return List.of(new PStop(StopReason.ABORTED));
        }
        return () -> new TurnIterator(request);
    }

    /** What a request asks of the runtime once it is matched to a conversation. */
    private record Plan(Conversation conversation, boolean deliverResults, ProviderMessage newMessage) {}

    private Plan plan(ProviderRequest request) {
        List<ProviderMessage> history = request.messages();
        if (history.isEmpty() || history.getLast().role() != ProviderMessage.Role.USER) {
            throw new IllegalArgumentException("copilot: a request must end with a user message");
        }
        ProviderMessage last = history.getLast();
        synchronized (this) {
            for (Conversation c : conversations) {
                if (c.busy || !c.system.equals(request.system()) || history.size() != c.seen.size() + 1
                        || !continues(c.seen, history)) {
                    continue;
                }
                boolean results = last.content().stream().anyMatch(p -> p instanceof ToolResultContent);
                if (results != c.hasParked()) {
                    continue;
                }
                c.busy = true;
                conversations.remove(c);
                conversations.addFirst(c);
                return new Plan(c, results, last);
            }
        }
        Conversation fresh = open(request);
        return new Plan(fresh, false, null);
    }

    /**
     * Whether {@code history} continues what the runtime has seen. A tool
     * result may come back shortened (card 467 sends old results as stubs):
     * the runtime holds the full one, so only its call id and error flag count.
     */
    static boolean continues(List<ProviderMessage> seen, List<ProviderMessage> history) {
        if (history.size() < seen.size()) {
            return false;
        }
        for (int i = 0; i < seen.size(); i++) {
            ProviderMessage a = seen.get(i);
            ProviderMessage b = history.get(i);
            if (a.role() != b.role() || a.content().size() != b.content().size()) {
                return false;
            }
            for (int j = 0; j < a.content().size(); j++) {
                ProviderContent x = a.content().get(j);
                ProviderContent y = b.content().get(j);
                boolean same = x instanceof ToolResultContent rx && y instanceof ToolResultContent ry
                        ? rx.callId().equals(ry.callId()) && rx.isError() == ry.isError()
                        : x.equals(y);
                if (!same) {
                    return false;
                }
            }
        }
        return true;
    }

    private Conversation open(ProviderRequest request) {
        Conversation conversation = new Conversation(request.system(), request.effort());
        conversation.tools(request.tools());
        SessionConfig config = new SessionConfig()
                .setModel(options.model())
                .setStreaming(true)
                .setTools(conversation.definitions)
                .setAvailableTools(new ToolSet().addCustom("*"))
                .setExcludedTools(new ToolSet().addBuiltIn("*").addMcp("*"))
                .setSystemMessage(new SystemMessageConfig().setMode(SystemMessageMode.REPLACE)
                        .setContent(request.system() == null ? "" : request.system()))
                .setSkipCustomInstructions(true)
                .setInfiniteSessions(new InfiniteSessionConfig().setEnabled(false))
                .setOnPermissionRequest((permission, invocation) ->
                        CompletableFuture.completedFuture(conversation.decide(permission)));
        if (request.effort() != null) {
            config.setReasoningEffort(request.effort());
        }
        TokenSource source = options.tokenSource();
        if (source != null) {
            config.setGitHubTokenProvider(args -> CompletableFuture.supplyAsync(() -> {
                try {
                    Token token = source.token(args.host(),
                            args.reason() == null ? null : args.reason().getValue());
                    return GitHubTokenProviderResult.token(token.value(), token.expiresInSeconds());
                } catch (Exception failure) {
                    // The message of a failed source is not passed on: it may quote what it read.
                    throw new IllegalStateException("copilot: the token source gave no token ("
                            + failure.getClass().getSimpleName() + ")");
                }
            }));
        }
        CopilotSession session = await(client().createSession(config), CALL_TIMEOUT_S, "create a session");
        conversation.attach(session);
        List<Conversation> evicted = new ArrayList<>();
        synchronized (this) {
            conversation.busy = true;
            conversations.addFirst(conversation);
            while (conversations.size() > MAX_CONVERSATIONS) {
                Conversation oldest = conversations.getLast();
                if (oldest.busy) {
                    break;
                }
                evicted.add(conversations.removeLast());
            }
        }
        evicted.forEach(Conversation::close);
        return conversation;
    }

    private void forget(Conversation conversation) {
        synchronized (this) {
            conversations.remove(conversation);
        }
        conversation.close();
    }

    /** A harness tool call that waits for the harness to run it. */
    private record Parked(String callId, String name, CompletableFuture<Object> result) {}

    /** The SDK's handler arrived with a call: what the stream turns into a {@link PToolCall}. */
    private record CallArrived(String callId, String name, JsonNode input) {}

    /** Markers on a turn's queue that are not runtime events. */
    private enum Signal { CANCEL, RUNTIME_GONE }

    /** One runtime session, matched to one harness conversation. */
    private final class Conversation {
        final String system;
        String effort;
        CopilotSession session;
        Closeable subscription;
        List<ProviderMessage> seen = List.of();
        volatile Set<String> toolNames = Set.of();
        List<ToolSpec> toolSpecs = List.of();
        List<ToolDefinition> definitions = List.of();
        final Map<String, Parked> parked = new LinkedHashMap<>();
        volatile BlockingQueue<Object> turn;
        boolean busy;

        Conversation(String system, String effort) {
            this.system = system == null ? "" : system;
            this.effort = effort;
        }

        void attach(CopilotSession created) {
            this.session = created;
            this.subscription = created.on(event -> {
                BlockingQueue<Object> sink = turn;
                if (sink != null) {
                    sink.add(event);
                }
            });
        }

        /** Registers the harness tools as custom tools; their handlers park. */
        void tools(List<ToolSpec> specs) {
            List<ToolSpec> given = specs == null ? List.of() : List.copyOf(specs);
            List<ToolDefinition> defs = new ArrayList<>();
            Set<String> names = new LinkedHashSet<>();
            for (ToolSpec spec : given) {
                names.add(spec.name());
                defs.add(ToolDefinition.create(spec.name(), spec.description() == null ? "" : spec.description(),
                        schemaOf(spec.inputSchema()), this::park));
            }
            toolSpecs = given;
            definitions = List.copyOf(defs);
            toolNames = Set.copyOf(names);
        }

        private CompletableFuture<Object> park(ToolInvocation invocation) {
            CompletableFuture<Object> result = new CompletableFuture<>();
            JsonNode input = invocation.getArgumentsAs(JsonNode.class);
            String callId = invocation.getToolCallId();
            synchronized (this) {
                parked.put(callId, new Parked(callId, invocation.getToolName(), result));
            }
            BlockingQueue<Object> sink = turn;
            if (sink != null) {
                sink.add(new CallArrived(callId, invocation.getToolName(),
                        input == null ? JSON.createObjectNode() : input));
            }
            return result;
        }

        /**
         * Deny by default. The one approval: a custom tool this provider
         * registered, because the harness gates and runs that tool itself.
         */
        PermissionRequestResult decide(PermissionRequest permission) {
            Object toolName = permission.getExtensionData() == null ? null
                    : permission.getExtensionData().get("toolName");
            if ("custom-tool".equals(permission.getKind()) && toolName instanceof String name
                    && toolNames.contains(name)) {
                return PermissionRequestResult.approveOnce();
            }
            log.debug("copilot: refused a runtime permission request of kind {}", permission.getKind());
            return PermissionRequestResult.reject("spectroscope runs its own tools; the Copilot runtime may"
                    + " not run " + permission.getKind() + " requests");
        }

        synchronized boolean hasParked() {
            return !parked.isEmpty();
        }

        synchronized List<Parked> takeParked() {
            List<Parked> all = new ArrayList<>(parked.values());
            parked.clear();
            return all;
        }

        void close() {
            turn = null;
            for (Parked p : takeParked()) {
                p.result().complete(ToolResultObject.error("the conversation was closed"));
            }
            try {
                if (subscription != null) {
                    subscription.close();
                }
            } catch (Exception ignored) {
                // nothing left to unsubscribe
            }
            if (session != null) {
                try {
                    session.close();
                } catch (RuntimeException gone) {
                    log.debug("copilot: session close failed", gone);
                }
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> schemaOf(JsonNode schema) {
        if (schema == null || !schema.isObject()) {
            return Map.of("type", "object", "properties", Map.of());
        }
        return JSON.convertValue(schema, Map.class);
    }

    /** One stream: one model call of the runtime, translated. */
    private final class TurnIterator implements Iterator<ProviderEvent> {

        private final ProviderRequest request;
        private final Deque<ProviderEvent> pending = new ArrayDeque<>();
        private final BlockingQueue<Object> queue = new LinkedBlockingQueue<>();
        private final StringBuilder text = new StringBuilder();
        private final List<PToolCall> calls = new ArrayList<>();
        private final LlmWireTap.Exchange exchange;
        private final Runnable unhookCancel;
        private Conversation conversation;
        private int expectedCalls = -1;
        private boolean sawDelta;
        private String finishReason;
        private boolean finished;

        TurnIterator(ProviderRequest request) {
            this.request = request;
            Plan plan = plan(request);
            this.conversation = plan.conversation();
            conversation.turn = queue;
            this.unhookCancel = request.signal() == null ? () -> { }
                    : request.signal().onCancel(() -> queue.add(Signal.CANCEL));
            LlmWireTap.Exchange opened = null;
            try {
                if (!sameTools(conversation.toolSpecs, request.tools())) {
                    conversation.tools(request.tools());
                    await(conversation.session.setTools(conversation.definitions), CALL_TIMEOUT_S, "set the tools");
                }
                if (!Objects.equals(conversation.effort, request.effort()) && request.effort() != null) {
                    await(conversation.session.setModel(options.model(), request.effort()), CALL_TIMEOUT_S,
                            "set the reasoning effort");
                    conversation.effort = request.effort();
                }
                if (plan.deliverResults()) {
                    opened = tap("session.tools.handlePendingToolCall", resultsBody(plan.newMessage()));
                    deliver(plan.newMessage());
                } else {
                    MessageOptions message = message(request.messages(), plan.newMessage() == null);
                    opened = tap("session.send", sendBody(message));
                    await(conversation.session.send(message), CALL_TIMEOUT_S, "send the message");
                }
            } catch (RuntimeException failure) {
                end(opened, false, failure.getMessage());
                abandon();
                throw failure;
            }
            this.exchange = opened;
        }

        private LlmWireTap.Exchange tap(String method, String body) {
            if (request.tap() == null) {
                return null;
            }
            return request.tap().begin(new LlmWireTap.WireRequest(NAME, options.model(), "json-rpc", method,
                    "copilot-runtime", Map.of(), "sdk-reconstructed", body, System.currentTimeMillis()));
        }

        private String sendBody(MessageOptions message) {
            ObjectNode body = JSON.createObjectNode();
            body.put("sessionId", conversation.session.getSessionId());
            body.put("prompt", message.getPrompt());
            body.put("attachments", message.getAttachments() == null ? 0 : message.getAttachments().size());
            return body.toString();
        }

        private String resultsBody(ProviderMessage results) {
            ObjectNode body = JSON.createObjectNode();
            body.put("sessionId", conversation.session.getSessionId());
            var array = body.putArray("results");
            for (ProviderContent part : results.content()) {
                if (part instanceof ToolResultContent r) {
                    array.addObject().put("toolCallId", r.callId()).put("isError", r.isError())
                            .put("output", r.output());
                }
            }
            return body.toString();
        }

        /** Completes the parked futures with the harness's results. */
        private void deliver(ProviderMessage results) {
            Map<String, ToolResultContent> byCall = new LinkedHashMap<>();
            List<String> notes = new ArrayList<>();
            List<ToolBinaryResult> images = new ArrayList<>();
            for (ProviderContent part : results.content()) {
                switch (part) {
                    case ToolResultContent r -> byCall.put(r.callId(), r);
                    case TextContent t -> notes.add(t.text());
                    case ImageContent i -> images.add(new ToolBinaryResult(i.dataBase64(), i.mediaType(), "image",
                            "an image the harness attached"));
                    case DocumentContent d -> notes.add("[document " + d.name() + " attached; the Copilot"
                            + " provider passes documents on in a user message only]");
                    case ToolCallContent ignored -> { }
                }
            }
            List<Parked> waiting = conversation.takeParked();
            for (int i = 0; i < waiting.size(); i++) {
                Parked p = waiting.get(i);
                ToolResultContent r = byCall.get(p.callId());
                String output = r == null ? "ERROR: the harness returned no result for this call" : r.output();
                boolean error = r == null || r.isError();
                if (i == waiting.size() - 1 && !notes.isEmpty()) {
                    // Text beside the results (an operator note, card 380) rides on the last result.
                    output = output + "\n\n" + String.join("\n\n", notes);
                }
                List<ToolBinaryResult> binaries = i == waiting.size() - 1 && !images.isEmpty() ? images : null;
                p.result().complete(new ToolResultObject(error ? "failure" : "success", output, binaries,
                        error ? output : null, null, null, null));
            }
        }

        /** The user message to send: new text, or the whole history for a fresh runtime session. */
        private MessageOptions message(List<ProviderMessage> history, boolean fresh) {
            ProviderMessage last = history.getLast();
            StringBuilder prompt = new StringBuilder();
            if (fresh && history.size() > 1) {
                prompt.append(transcript(history.subList(0, history.size() - 1)));
            }
            List<MessageAttachment> attachments = new ArrayList<>();
            List<String> lastText = new ArrayList<>();
            for (ProviderContent part : last.content()) {
                switch (part) {
                    case TextContent t -> lastText.add(t.text());
                    case ImageContent i -> attachments.add(new BlobAttachment().setData(i.dataBase64())
                            .setMimeType(i.mediaType()).setDisplayName("image"));
                    case DocumentContent d -> attachments.add(new BlobAttachment().setData(d.dataBase64())
                            .setMimeType(d.mediaType()).setDisplayName(d.name()));
                    case ToolResultContent r -> lastText.add(resultLine(r));
                    case ToolCallContent ignored -> { }
                }
            }
            prompt.append(String.join("\n\n", lastText));
            MessageOptions options = new MessageOptions().setPrompt(prompt.toString());
            if (!attachments.isEmpty()) {
                options.setAttachments(attachments);
            }
            return options;
        }

        @Override
        public boolean hasNext() {
            fill();
            return !pending.isEmpty();
        }

        @Override
        public ProviderEvent next() {
            if (!hasNext()) {
                throw new NoSuchElementException();
            }
            return pending.poll();
        }

        private void fill() {
            while (pending.isEmpty() && !finished) {
                Object item;
                try {
                    item = queue.poll(PROBE_AFTER_MS, TimeUnit.MILLISECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    fail("copilot runtime: the stream was interrupted");
                    return;
                }
                if (item == null) {
                    probe();
                    continue;
                }
                translate(item);
            }
        }

        /** A silence: ask the runtime whether it is still there. */
        private void probe() {
            CopilotClient running;
            synchronized (CopilotProvider.this) {
                running = client;
            }
            if (running == null) {
                queue.add(Signal.RUNTIME_GONE);
                return;
            }
            try {
                running.ping(null).get(PING_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            } catch (TimeoutException slow) {
                // busy, not gone
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } catch (ExecutionException | RuntimeException gone) {
                queue.add(Signal.RUNTIME_GONE);
            }
        }

        private void translate(Object item) {
            if (exchange != null && item instanceof SessionEvent event) {
                exchange.line(json(event));
            }
            switch (item) {
                case Signal.CANCEL -> abort();
                case Signal.RUNTIME_GONE -> fail("copilot runtime: the connection closed mid-stream"
                        + " (the runtime process exited or was killed)");
                case CallArrived call -> {
                    PToolCall event = new PToolCall(call.callId(), call.name(), call.input());
                    calls.add(event);
                    pending.add(event);
                    if (expectedCalls >= 0 && calls.size() >= expectedCalls) {
                        finish(StopReason.TOOL_USE);
                    }
                }
                case AssistantMessageDeltaEvent delta -> {
                    var data = delta.getData();
                    if (data != null && data.parentToolCallId() == null && data.deltaContent() != null
                            && !data.deltaContent().isEmpty()) {
                        sawDelta = true;
                        text.append(data.deltaContent());
                        pending.add(new PTextDelta(data.deltaContent()));
                    }
                }
                case AssistantReasoningDeltaEvent reasoning -> {
                    var data = reasoning.getData();
                    if (data != null && data.deltaContent() != null && !data.deltaContent().isEmpty()) {
                        pending.add(new PThinkingDelta(data.deltaContent()));
                    }
                }
                case AssistantUsageEvent usage -> {
                    var data = usage.getData();
                    if (data != null && data.parentToolCallId() == null) {
                        int cacheRead = count(data.cacheReadTokens());
                        // The Copilot wire counts cached tokens inside inputTokens (card 468 takes them out).
                        pending.add(new PUsage(Math.max(0, count(data.inputTokens()) - cacheRead),
                                count(data.outputTokens()), cacheRead, count(data.cacheWriteTokens())));
                        finishReason = data.finishReason();
                    }
                }
                case AssistantMessageEvent message -> {
                    var data = message.getData();
                    if (data == null) {
                        return;
                    }
                    if (!sawDelta && data.content() != null && !data.content().isEmpty()) {
                        text.append(data.content());
                        pending.add(new PTextDelta(data.content()));
                    }
                    if (data.toolRequests() != null && !data.toolRequests().isEmpty()) {
                        Set<String> ours = conversation.toolNames;
                        expectedCalls = (int) data.toolRequests().stream()
                                .filter(r -> r.name() != null && ours.contains(r.name())).count();
                        if (expectedCalls > 0 && calls.size() >= expectedCalls) {
                            finish(StopReason.TOOL_USE);
                        }
                    }
                }
                case SessionErrorEvent error -> {
                    var data = error.getData();
                    fail("copilot runtime reported an error: " + (data == null ? "no detail"
                            : data.message() + (data.errorType() == null ? "" : " (" + data.errorType() + ")")));
                }
                case SessionIdleEvent idle -> {
                    if (idle.getData() != null && Boolean.TRUE.equals(idle.getData().aborted())) {
                        finish(StopReason.ABORTED);
                    } else if (!calls.isEmpty()) {
                        finish(StopReason.TOOL_USE);
                    } else {
                        finish("length".equals(finishReason) ? StopReason.MAX_TOKENS : StopReason.END_TURN);
                    }
                }
                case SessionEvent other -> { }
                default -> { }
            }
        }

        /** Cancel: abort the runtime turn, wait for its idle, drop whatever it still sends. */
        private void abort() {
            CompletableFuture<Void> aborting = conversation.session.abort();
            long deadline = System.currentTimeMillis() + ABORT_SETTLE_MS;
            try {
                while (System.currentTimeMillis() < deadline) {
                    Object item = queue.poll(Math.max(1, deadline - System.currentTimeMillis()),
                            TimeUnit.MILLISECONDS);
                    if (item instanceof SessionIdleEvent || item == Signal.RUNTIME_GONE || item == null) {
                        break;
                    }
                }
                aborting.get(Math.max(1, deadline - System.currentTimeMillis()), TimeUnit.MILLISECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } catch (ExecutionException | TimeoutException | RuntimeException slow) {
                log.debug("copilot: abort did not settle", slow);
            }
            for (Parked p : conversation.takeParked()) {
                p.result().complete(ToolResultObject.error("aborted"));
            }
            pending.clear();
            finish(StopReason.ABORTED);
        }

        private void finish(StopReason reason) {
            if (finished) {
                return;
            }
            pending.add(new PStop(reason));
            finished = true;
            conversation.turn = null;
            unhookCancel.run();
            List<ProviderMessage> seen = new ArrayList<>(request.messages());
            if (reason != StopReason.ABORTED) {
                List<ProviderContent> assistant = new ArrayList<>();
                if (!text.isEmpty()) {
                    assistant.add(new TextContent(text.toString()));
                }
                calls.forEach(c -> assistant.add(new ToolCallContent(c.callId(), c.name(), c.input())));
                if (!assistant.isEmpty()) {
                    seen.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.copyOf(assistant)));
                }
            }
            synchronized (CopilotProvider.this) {
                conversation.seen = List.copyOf(seen);
                conversation.busy = false;
            }
            end(exchange, reason == StopReason.ABORTED, null);
        }

        private void fail(String message) {
            finished = true;
            end(exchange, false, message);
            abandon();
            throw new IllegalStateException(message);
        }

        /** After a failure the runtime's history is unknown: the conversation is dropped. */
        private void abandon() {
            conversation.turn = null;
            unhookCancel.run();
            forget(conversation);
        }

        private void end(LlmWireTap.Exchange open, boolean aborted, String error) {
            if (open != null) {
                open.end(new LlmWireTap.WireOutcome(null, "sdk-events", null, aborted, error,
                        System.currentTimeMillis()));
            }
        }

    }

    private static boolean sameTools(List<ToolSpec> a, List<ToolSpec> b) {
        List<ToolSpec> left = a == null ? List.of() : a;
        List<ToolSpec> right = b == null ? List.of() : b;
        return left.equals(right);
    }

    private static int count(Long value) {
        return value == null ? 0 : (int) Math.min(Integer.MAX_VALUE, Math.max(0, value));
    }

    /** The earlier conversation as plain text, for a runtime session that never saw it. */
    static String transcript(List<ProviderMessage> earlier) {
        StringBuilder out = new StringBuilder(
                "The conversation so far, carried over because this session starts fresh:\n\n");
        for (ProviderMessage message : earlier) {
            for (ProviderContent part : message.content()) {
                String role = message.role() == ProviderMessage.Role.USER ? "user" : "assistant";
                switch (part) {
                    case TextContent t -> out.append('[').append(role).append("]\n").append(t.text()).append("\n\n");
                    case ToolCallContent c -> out.append("[assistant called ").append(c.name()).append(" as ")
                            .append(c.callId()).append(" with ").append(c.input()).append("]\n\n");
                    case ToolResultContent r -> out.append(resultLine(r)).append("\n\n");
                    case ImageContent i -> out.append('[').append(role).append(" attached an image]\n\n");
                    case DocumentContent d -> out.append('[').append(role).append(" attached ")
                            .append(d.name()).append("]\n\n");
                }
            }
        }
        out.append("[end of the earlier conversation]\n\n");
        return out.toString();
    }

    private static String resultLine(ToolResultContent r) {
        return "[tool result for " + r.callId() + (r.isError() ? ", failed" : "") + "]\n" + r.output();
    }

    private static <T> T await(CompletableFuture<T> future, long seconds, String what) {
        try {
            return future.get(seconds, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("copilot runtime: interrupted while waiting to " + what);
        } catch (TimeoutException slow) {
            throw new IllegalStateException("copilot runtime: no answer within " + seconds + " s to " + what);
        } catch (ExecutionException failed) {
            Throwable cause = failed.getCause() == null ? failed : failed.getCause();
            throw new IllegalStateException("copilot runtime: could not " + what + ": " + cause.getMessage(), cause);
        }
    }

    private static String json(Object value) {
        try {
            return JSON.writeValueAsString(value);
        } catch (JsonProcessingException failure) {
            return "{\"unserialisable\":\"" + value.getClass().getSimpleName() + "\"}";
        }
    }
}
