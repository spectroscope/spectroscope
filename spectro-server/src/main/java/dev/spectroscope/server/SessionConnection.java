package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.ProviderFactory;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.WorkspaceResolver;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.events.RunEvent.Attachment;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import dev.spectroscope.core.permission.Allowlist;
import dev.spectroscope.core.image.GenerateImageTool;
import dev.spectroscope.core.image.ImageProviders;
import dev.spectroscope.core.image.ImageStore;
import dev.spectroscope.core.hooks.HookRunner;
import dev.spectroscope.core.mcp.McpServerRegistry;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.SwitchableProvider;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.trace.JsonlSink;
import dev.spectroscope.core.trace.TracingPorts;
import dev.spectroscope.core.skills.SkillLibrary;
import dev.spectroscope.core.subagents.SubagentConfig;
import dev.spectroscope.core.subagents.SubagentManager;
import dev.spectroscope.core.tools.DefaultHttpFetcher;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.tools.WebFetchTool;
import dev.spectroscope.core.web.BrowsePageTool;
import dev.spectroscope.core.web.DefaultChromeRunner;
import dev.spectroscope.core.web.WebSearchTool;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The per-connection state and run wiring: one agent, one session, one run at a
 * time. Everything connection-specific lives HERE (not at module level), so two
 * browser tabs are automatically two independent sessions — two agents, two
 * JSONL files, no shared state.
 */
public final class SessionConnection {

    /** The CLI's base system prompt, verbatim. */
    // Shared with ContextDescriber: /api/context must show EXACTLY this assembly.
    static final String BASE_SYSTEM_PROMPT =
            "You are spectroscope, a coding agent in the terminal. Use the tools when they help, "
                    + "and answer in English. Working directory: ";

    private final WebSocketSession socket;
    private final ObjectMapper mapper;
    private final SpectroConfig config;
    private final String resumeId;

    /** The PROJECT anchor (process cwd): config layers, skills, MCP, SPECTRO.md. */
    private final Path projectDir = Path.of(System.getProperty("user.dir"));

    /** The agent's working world — resolved per session in buildAgentOnce. */
    private Path workspace;

    /** callId -> the future the agent's virtual thread is blocked on. */
    private final Map<String, CompletableFuture<Boolean>> pending = new ConcurrentHashMap<>();

    /** callId -> the parked permission request, so a "remember" response can scope its rule. */
    private final Map<String, PermissionRequest> pendingRequests = new ConcurrentHashMap<>();

    /**
     * Session-scoped "always allow" rules (the web checkbox). Per-socket, never
     * static: a genuinely new tab is a new SessionConnection with an empty set, so
     * a remembered decision never leaks across the two independent tabs.
     */
    private final List<String> rememberedRules = new CopyOnWriteArrayList<>();

    /**
     * The composer gear's live permission-mode switch ("ask"/"auto"/"readonly"),
     * consulted by {@link #parkingBroker()} before the allowlist. Seeded from the
     * boot config; {@link #onSetPermissionMode} updates it in place mid-session.
     */
    private volatile String permissionMode;

    /**
     * True once {@link #onSetPermissionMode} has been called at least once — a
     * live pre-build switch must survive {@link #buildAgentOnce}'s session-moment
     * reseed from the workspace-scoped config, exactly like a pre-build provider
     * switch stays on top via {@code activeConfig}.
     */
    private volatile boolean modeTouched;

    /** True once {@link #onSetThinking} has been called — same contract as
     *  {@link #modeTouched}: a live pre-build toggle survives the session-moment
     *  reseed of the {@link #thinking} seed. */
    private volatile boolean thinkingTouched;

    /** True once {@link #onSetImageProvider} has been called — same contract as
     *  {@link #modeTouched}: a live pre-build dropdown choice survives the
     *  session-moment reseed of {@link #imageProviderName}. */
    private volatile boolean imageProviderTouched;

    private SessionStore store;               // created on the first prompt (or on resume)
    // The tracing seam (KONZEPT §4.3): persistence rides a required port, so
    // bus/OTel consumers can dock without touching the drain loop. Built
    // wherever the store is — the sink holds the store it writes.
    private TracingPorts tracing;
    private List<ProviderMessage> initial = List.of();

    private volatile CancelSignal signal;     // the running run's signal, or null
    private volatile boolean running = false;
    private Agent agent;                      // one agent per connection, built lazily
    private SubagentManager subagents;        // built together with the agent — the spawn
                                              // tools inside the registry reference exactly
                                              // this instance, so it must never be rebuilt
    private McpServerRegistry mcp;            // connected once with the agent,
                                              // closed on onClose (server processes/connections)

    /**
     * the UI's provider dropdown swaps this mid-session. The
     * generate_image tool reads through it on every call, so the switch takes
     * effect on the NEXT generation without rebuilding agent or registry.
     */
    private final AtomicReference<String> imageProviderName = new AtomicReference<>();

    /**
     * The header "Thinking" toggle flips this mid-session. It seeds the agent
     * build AND is forwarded to the live agent ({@link Agent#setThinking}), so
     * the flip acts immediately — the build-time option alone could never
     * reach the already-built agent (kept for the whole connection to
     * preserve history), which used to strand the toggle after the first run.
     */
    private final AtomicBoolean thinking = new AtomicBoolean();

    /**
     * The header provider picker swaps this mid-session. The agent is built once
     * with a {@link SwitchableProvider} whose delegate this config feeds; a switch
     * either updates the delegate (agent already built) or seeds the first build.
     */
    private final AtomicReference<SpectroConfig> activeConfig;
    private SwitchableProvider switchable;   // the agent's provider indirection

    /**
     * Captures the per-connection collaborators; nothing heavy happens here —
     * the agent is built lazily on the first prompt.
     *
     * @param socket the WebSocket this connection writes every event to
     * @param mapper the module's shared Jackson mapper
     * @param config the boot config — the base layer for provider switches, MCP and hooks
     * @param resumeId a stored session to reopen and append to, or {@code null} for a fresh one
     */
    public SessionConnection(WebSocketSession socket, ObjectMapper mapper,
                             SpectroConfig config, String resumeId) {
        this.socket = socket;
        this.mapper = mapper;
        this.config = config;
        this.resumeId = resumeId;
        this.activeConfig = new AtomicReference<>(config);
        this.imageProviderName.set(config.imageProvider());
        this.thinking.set(config.thinking());
        this.permissionMode = config.permissionMode();
    }

    /** Announces the boot provider, then (for a resume) loads the history; a bad id closes the socket. */
    public void start() {
        // Every fresh socket learns the ACTIVE backend up front — the header
        // chip and the trace host column start from wire truth, not a guess.
        sendProviderInfo();
        sendPermissionModeInfo();
        if (resumeId == null) {
            return;
        }
        try {
            initial = SessionStore.loadSession(resumeId); // reconstructs the provider messages
            store = new SessionStore(resumeId);           // appends to the existing JSONL file
            tracing = new TracingPorts().require(new JsonlSink(store));
            // A resumed session knows its workspace immediately — announce it so
            // the Files tab points at the right folder before any prompt. A pin
            // from an earlier pick (same server process) wins over the config.
            String pinned = SessionWorkspaces.pinned(store.id());
            workspace = WorkspaceResolver.resolve(
                    pinned != null ? pinned : config.workspace(), store.id());
            sendWorkspaceInfo();
        } catch (Exception missing) {
            sendError("Session " + resumeId + " not found.");
            close();
        }
    }

    /**
     * A user_message starts one run on a virtual thread; the Tomcat thread returns.
     *
     * @param text the prompt text as typed in the composer
     * @param wireAttachments the additive attachments array from the frame
     *                        ({@code {mediaType, dataBase64}} items), may be absent
     */
    public void onUserMessage(String text, JsonNode wireAttachments) {
        if (running) {
            sendError("A run is already active — stop it first.");
            return;
        }

        // decode + store the blobs BEFORE the run starts — a rejected
        // (oversized, unsupported) upload must never start a run. Blob files need
        // the session id, so the store is minted here when absent.
        List<Attachment> attachments = List.of();
        if (wireAttachments != null && wireAttachments.isArray() && !wireAttachments.isEmpty()) {
            try {
                ensureStore();
                attachments = storeAttachments(store.id(), wireAttachments);
            } catch (IllegalArgumentException rejected) {
                sendError(rejected.getMessage());
                return;
            }
        }

        running = true;
        List<Attachment> runAttachments = attachments;
        Thread.ofVirtual().name("spectroscope-run").start(() -> runPrompt(text, runAttachments));
    }

    /**
     * Decodes wire attachments, fits each under the providers' 5 MB wire limit
     * and stores the blob (dedup by hash). file_upload: an oversized IMAGE is
     * no longer rejected — the shared {@link dev.spectroscope.core.image.ImageDownscaler}
     * ladder (the view_image policy) shrinks it, so real iPhone photos ride
     * the composer; oversized non-images still refuse readably.
     *
     * @param sessionId the session whose blob folder receives the files
     * @param wireAttachments the raw attachments array from the client frame
     * @return the stored attachments, each carrying its blob path and sha256
     */
    private List<Attachment> storeAttachments(String sessionId, JsonNode wireAttachments) {
        List<Attachment> stored = new ArrayList<>();
        for (JsonNode wire : wireAttachments) {
            byte[] bytes = Base64.getDecoder().decode(wire.path("dataBase64").asText());
            String mediaType = wire.path("mediaType").asText();
            dev.spectroscope.core.image.ImageDownscaler.Result fitted;
            try {
                fitted = dev.spectroscope.core.image.ImageDownscaler.fitWireLimit(bytes, mediaType);
            } catch (java.io.IOException oversized) {
                throw new IllegalArgumentException("Attachment: " + oversized.getMessage());
            }
            SessionStore.StoredBlob blob =
                    SessionStore.saveBlob(sessionId, fitted.bytes(), fitted.mediaType());
            stored.add(new Attachment("image", fitted.mediaType(), blob.blobPath(), blob.sha256()));
        }
        return stored;
    }

    /**
     * A permission_response completes the parked future; when {@code allowed} and the
     * client asked, it also remembers the (prefix-scoped) rule for this session and,
     * if {@code persist}, appends it to the {@link #persistHome()} settings file —
     * the session's real workspace when it has one, else the launch-dir fallback.
     *
     * @param callId the tool call the answer belongs to — keys the parked future
     * @param allowed the user's decision; {@code false} simply denies
     * @param remember when {@code true} (and allowed), keep the rule for this session
     * @param persist when {@code true} (and allowed), also write the rule to {@link #persistHome()}
     */
    public void onPermissionResponse(String callId, boolean allowed, boolean remember, boolean persist) {
        PermissionRequest request = pendingRequests.remove(callId);
        CompletableFuture<Boolean> future = pending.remove(callId);
        if (future != null) {
            future.complete(allowed);
        }
        if (allowed && request != null && (remember || persist)) {
            String rule = Allowlist.rememberRule(request.name(), request.input());
            if (remember && !rememberedRules.contains(rule)) {
                rememberedRules.add(rule);
            }
            if (persist) {
                try {
                    SettingsWriter.appendAutoApprove(persistHome(), rule);
                } catch (IOException failure) {
                    sendError("Could not persist the permission rule: " + failure.getMessage());
                }
            }
        }
    }

    /** Where a persisted rule belongs: the session's real workspace when one is
     *  pinned or configured (one home with the composer gear), else the launch-dir
     *  project file — the deprecated compat layer for throwaway temp workspaces. */
    private Path persistHome() {
        boolean realWorkspace = store != null
                && (SessionWorkspaces.pinned(store.id()) != null || config.workspace() != null);
        return realWorkspace && workspace != null ? workspace : projectDir;
    }

    /** The effective allowlist right now: the session-scoped autoApprove rules
     *  (the workspace's own config once buildAgentOnce has resolved it, else the
     *  connect-time snapshot) plus the remembered ones. */
    private Allowlist allowlistNow() {
        List<String> rules = new ArrayList<>(activeConfig.get().autoApprove());
        rules.addAll(rememberedRules);
        return Allowlist.fromEntries(rules);
    }

    /**
     * The dropdown in the web UI: switch the image backend mid-session.
     *
     * @param name "gemini" or "openai" — anything else is refused with an error event
     */
    public void onSetImageProvider(String name) {
        if (!Set.of("gemini", "openai").contains(name)) {
            sendError("Unknown image provider: \"" + name + "\" (allowed: gemini, openai).");
            return;
        }
        imageProviderName.set(name);
        imageProviderTouched = true; // a live choice must survive the session-moment reseed
    }

    /**
     * The composer gear's live mode switch. In-memory + immediate; persistence
     * is the client's separate PUT to the settings API.
     *
     * @param mode "ask", "auto" or "readonly" — anything else is refused with an error event
     */
    public void onSetPermissionMode(String mode) {
        if (!Set.of("ask", "auto", "readonly").contains(mode)) {
            sendError("Unknown permission mode: \"" + mode + "\" (allowed: ask, auto, readonly).");
            return;
        }
        this.permissionMode = mode;
        this.modeTouched = true; // a live switch must survive buildAgentOnce's session-moment reseed
        sendPermissionModeInfo();
    }

    /**
     * The header toggle in the web UI: switch reasoning visibility mid-session.
     * Applies on the NEXT run — the agent is built once per connection and kept
     * (it carries the multi-turn history), same pattern as the image provider.
     *
     * @param enabled the reasoning visibility for subsequent runs
     */
    public void onSetThinking(boolean enabled) {
        thinking.set(enabled);
        thinkingTouched = true; // a live toggle must survive the session-moment reseed
        // The agent may already exist (built on the first prompt) — its options
        // are immutable, so the live override is the only way the toggle can
        // still act. Models that reason unconditionally (Ollama's gpt-oss) are
        // silenced by the agent's emission filter, not by the wire flag.
        Agent current = this.agent;
        if (current != null) {
            current.setThinking(enabled);
        }
    }

    /**
     * The header provider picker: switch the LLM backend (and optionally its model)
     * mid-session. Applies on the NEXT run, via the {@link SwitchableProvider} — the
     * agent and its history stay put. A missing key (anthropic) is reported and the
     * switch is refused, exactly like the CLI's provider construction.
     *
     * @param providerName "anthropic" | "ollama" | "openai" — anything else is refused
     * @param model the model to pair with the switch; blank keeps the current one
     */
    public void onSetProvider(String providerName, String model) {
        if (!Set.of("anthropic", "ollama", "openai").contains(providerName)) {
            sendError("Unknown provider: \"" + providerName + "\" (allowed: anthropic, ollama, openai).");
            return;
        }
        SpectroConfig current = activeConfig.get();
        String useModel = (model != null && !model.isBlank()) ? model.trim() : current.model();
        SpectroConfig derived = current.withProvider(providerName, useModel);
        LlmProvider next;
        try {
            next = ProviderFactory.providerFromConfig(derived); // validates + anthropic key check
        } catch (RuntimeException rejected) {
            sendError(rejected.getMessage());
            return;
        }
        activeConfig.set(derived);
        if (switchable != null) {
            switchable.swap(next, providerName);   // agent already built: swap the delegate
        }
        // else: no run yet — buildAgentOnce reads activeConfig and starts on the new provider.
        // The switch is not silent: the client sees the new backend as a frame
        // (trace row, header chip, map locality) instead of trusting its own
        // optimistic state.
        sendProviderInfo();
    }

    /**
     * The Files tab's folder picker: pin THIS session's workspace to a chosen
     * directory. Only possible before the agent exists — afterwards the file
     * sandbox, glob/grep, run_command and every subagent are already anchored
     * there, so a late switch is refused with a readable error.
     *
     * @param path the absolute directory the native picker returned
     */
    public void onSetWorkspace(String path) {
        if (path == null || path.isBlank()) {
            sendError("set_workspace needs a path.");
            return;
        }
        if (agent != null) {
            sendError("The workspace is fixed once the agent has run — start a new chat to change it.");
            return;
        }
        try {
            ensureStore(); // the announcement carries the session id
            String picked = path.strip();
            workspace = WorkspaceResolver.resolve(picked, store.id());
            // The pin is SHARED state: the REST side (/api/files) must root the
            // Files tab at the same folder the sandbox uses, and a resume in
            // this server process finds the picked folder again.
            SessionWorkspaces.pin(store.id(), picked);
            workspaceAnnounced = false; // re-announce: the Files tab re-roots live
            sendWorkspaceInfo();
        } catch (RuntimeException rejected) {
            sendError("Workspace rejected: " + rejected.getMessage());
        }
    }

    /** The stop button: cancel the run's signal — the same signal the loop checks. */
    public void onAbort() {
        CancelSignal current = this.signal;
        if (current != null) {
            current.cancel();
        }
    }

    /** Socket closed: cancel the run, release orphaned questions, close MCP. The file stays. */
    public void onClose() {
        onAbort();
        releasePending();
        McpServerRegistry current = this.mcp;
        if (current != null) {
            current.close(); // tear down this connection's MCP server processes/connections
        }
    }

    /**
     * Lazily mints the session store. Attachments pull this ahead of the run:
     * blob writes need the session id (store.id()) before runPrompt starts.
     */
    private void ensureStore() {
        if (store == null) {
            store = new SessionStore();   // the store mints the id (store.id())
            tracing = new TracingPorts().require(new JsonlSink(store));
        }
    }

    /**
     * One full run on the virtual thread: build (or reuse) the agent, stream every
     * event to file AND socket, and always release the run flag and any parked
     * permission questions — even when the run dies with an exception.
     *
     * @param text the user prompt to run
     * @param attachments already-stored blobs riding along with the prompt
     */
    private void runPrompt(String text, List<Attachment> attachments) {
        CancelSignal runSignal = new CancelSignal();
        this.signal = runSignal;
        ensureStore();

        try {
            // Everything below is exactly what the CLI builds — nothing new in the core.
            buildAgentOnce();
            sendWorkspaceInfo();

            // The run goes through the SubagentManager: parent and child
            // events merge into ONE stream. ONE sender virtual thread drains it and
            // writes each event out — Spring's WebSocketSession does not tolerate
            // concurrent sends, so one drainer per connection is the whole story.
            try (EventStream events = subagents.run(agent, text, new RunOptions(runSignal, attachments))) {
                for (RunEvent event : events) {
                    tracing.onEvent(event); // file and socket get the SAME object
                    send(event);
                }
            }
        } catch (RuntimeException failure) {
            sendError("Run ended with an error: " + failure.getMessage());
        } finally {
            running = false;
            this.signal = null;
            releasePending();          // orphaned questions: deny them
        }
    }

    /**
     * Builds agent + manager on the first prompt and keeps BOTH for the whole
     * connection: the agent instance carries the multi-turn history (a second
     * prompt in the same tab continues the conversation, like the CLI REPL),
     * and the spawn tools inside the registry reference exactly this manager
     * instance — a rebuilt manager would leave them pointing at a dead one.
     */
    private void buildAgentOnce() {
        if (agent != null) {
            return;
        }
        // The agent's working world: a folder the user picked for this session
        // (the shared pin — a resume in this process finds it too), else the
        // configured workspace, else this session's deterministic temp folder
        // (the store minted the id already). The Files tab learns it through
        // the workspace_info frame below.
        String pinned = SessionWorkspaces.pinned(store.id());
        workspace = WorkspaceResolver.resolve(
                pinned != null ? pinned : config.workspace(), store.id());

        // The session moment: the workspace's own .spectro pair joins the chain now.
        // A pre-build provider switch (activeConfig differs from the connect snapshot)
        // stays on top of the re-resolved config; a broken workspace file is loud but
        // never fatal — the session falls back to the connect-time view.
        SpectroConfig sessionConfig;
        try {
            sessionConfig = SpectroConfig.loadForWorkspace(SpectroConfig.Overrides.none(), projectDir, workspace);
            SpectroConfig switched = activeConfig.get();
            if (!switched.provider().equals(config.provider()) || !switched.model().equals(config.model())) {
                sessionConfig = sessionConfig.withProvider(switched.provider(), switched.model());
            }
        } catch (IllegalArgumentException invalidWorkspaceScope) {
            sendError("workspace settings ignored: " + invalidWorkspaceScope.getMessage());
            sessionConfig = activeConfig.get();
        }
        activeConfig.set(sessionConfig);
        if (!modeTouched) {
            permissionMode = sessionConfig.permissionMode();
        }
        if (!thinkingTouched) {
            thinking.set(sessionConfig.thinking());
        }
        if (!imageProviderTouched) {
            imageProviderName.set(sessionConfig.imageProvider());
        }
        // The reseed above can silently change the ACTIVE provider/model and
        // permission mode (a workspace's own .spectro pair outranking the
        // connect-time snapshot) — re-announce both frames right here so the
        // header chip, the map locality and the composer gear reflect the
        // override the moment it takes effect, exactly like a live mid-session
        // switch does. Idempotent and harmless when nothing actually changed.
        sendProviderInfo();
        sendPermissionModeInfo();

        PermissionBroker broker = parkingBroker();

        // The provider is wrapped in a SwitchableProvider so the header picker can
        // swap the backend mid-session (activeConfig carries any pre-run switch).
        SpectroConfig active = activeConfig.get();
        switchable = new SwitchableProvider(ProviderFactory.providerFromConfig(active), active.provider());
        LlmProvider provider = switchable;
        // the skill catalog rides in the system prompt, bodies come via use_skill.
        SkillLibrary skills = SkillLibrary.load(SkillLibrary.defaultRoots(projectDir));
        String systemPrompt = BASE_SYSTEM_PROMPT + workspace + SpectroConfig.loadProjectMd(projectDir)
                + skills.systemPromptSection();

        ToolRegistry registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        // created lazily per call through the AtomicReference — the dropdown
        // switch applies to the next generation, and a missing key errors readably.
        registry.register(new GenerateImageTool(
                () -> ImageProviders.create(imageProviderName.get(),
                        activeConfig.get().imageModel(), System.getenv()),
                ImageStore.inUserHome()));
        // Real tool: web_fetch — permission-gated network egress, injectable HTTP seam.
        registry.register(new WebFetchTool(new DefaultHttpFetcher()));
        // web_search branch: tiered search (Tavily when TAVILY_API_KEY is set, else
        // the keyless DuckDuckGo fallback) + browse_page through the system Chrome
        // headless (renders JS). Both network egress -> permission-gated.
        registry.register(WebSearchTool.fromEnv(System.getenv()));
        // chromeEnv() overlays the settings-hierarchy chromeBinary onto the process
        // env; read fresh from activeConfig per call, like imageModel above, so a
        // pre-run provider switch (which carries chromeBinary along) stays honoured.
        registry.register(new BrowsePageTool(
                () -> BrowsePageTool.findChrome(activeConfig.get().chromeEnv()),
                new DefaultChromeRunner()));
        // The plan tool is main-only (see SpectroCli) — the flat UI plan
        // snapshot must not be clobbered by a subagent. describeContext lists it
        // from its own instance; this registration only feeds the live agent.
        registry.register(new dev.spectroscope.core.tools.UpdatePlanTool());
        if (!skills.skills().isEmpty()) {
            registry.register(skills.useSkillTool());
        }
        // MCP tools register alongside the standard ones, exactly like the
        // CLI — the model calls mcp__<server>__<tool> and the events flow unchanged.
        // The mcpServers block comes from the SESSION-scoped config (the workspace's
        // own settings, resolved above) — connected once per socket; a LATER provider
        // switch never rebuilds this registry, so it stays independent of that.
        mcp = McpServerRegistry.load(sessionConfig.mcpServers(), projectDir);
        mcp.tools().forEach(registry::register);
        // Children get the standard tools PLUS use_skill (when skills exist), so a
        // dev-tool child can actually load the skill its role prompt points at.
        List<Tool> childBase = new ArrayList<>(StandardTools.all());
        if (!skills.skills().isEmpty()) {
            childBase.add(skills.useSkillTool());
        }
        // Config-only pre/post_tool_use shell hooks — from the SESSION-scoped config
        // (the workspace's own settings, resolved above), like mcpServers just above.
        // Loaded before the SubagentManager so children run the same guard as the parent.
        HookRunner hooks = HookRunner.load(sessionConfig.hooks());

        subagents = new SubagentManager(new SubagentConfig(
                provider, workspace, "main", broker, List.copyOf(childBase), hooks));
        // spawn + dev tools ONLY in the parent registry — otherwise a browser run
        // could never emit agent_spawn events, which the graph tab needs live.
        subagents.tools().forEach(registry::register);
        subagents.devTools().forEach(registry::register);

        agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt(systemPrompt)
                .registry(registry)
                .cwd(workspace)   // the agent works IN the workspace, not the repo
                .agentId("main")
                .onPermission(broker)
                .initialMessages(initial)
                .providerName(active.provider())
                .compactionThreshold(active.compactionThreshold())
                .introspection(true) // additive: context introspection for the ring in the web UI
                .thinking(thinking.get()) // reasoning visibility; the header toggle applies on the next run
                .hooks(hooks) // external pre/post_tool_use shell hooks (config-only)
                .build());
    }

    /**
     * The web face's permission strategy: the broker parks a future instead of
     * asking y/N. The permission_request event goes out in PARALLEL over the
     * event stream (the sender loop); here we only wait for the response with
     * the SAME callId. The live {@link #permissionMode} ("auto"/"readonly")
     * decides first and short-circuits everything below it; "ask" (the
     * default) falls through to {@link #allowlistNow()} (the session-scoped
     * autoApprove rules plus the session's "always allow" rules); the core
     * still emits permission_request/permission_decision regardless of who
     * decided, so every decision stays auditable (mirrors the CLI broker's
     * allowlist short-circuit).
     */
    private PermissionBroker parkingBroker() {
        return request -> {
            Boolean byMode = PermissionModes.decide(permissionMode, request);
            if (byMode != null) {
                return byMode;
            }
            if (allowlistNow().allows(request)) {
                return true;
            }
            pendingRequests.put(request.callId(), request);
            CompletableFuture<Boolean> future = new CompletableFuture<>();
            pending.put(request.callId(), future);
            return future.join();   // parks the agent's virtual thread — cheap
        };
    }

    /**
     * Serialize a RunEvent and push it out — the ONLY writer for this socket.
     *
     * @param event the event to serialize; dropped silently when the socket is gone
     */
    private synchronized void send(RunEvent event) {
        if (!socket.isOpen()) {
            return;
        }
        try {
            socket.sendMessage(new TextMessage(mapper.writeValueAsString(event)));
        } catch (Exception ignored) {
            // A dead socket is not a run failure — the JSONL file already has it.
        }
    }

    /** Whether the workspace_info frame already went out on this connection. */
    private boolean workspaceAnnounced = false;

    /**
     * Tells the client where THIS session's agent works — a socket-only UI
     * frame, never appended to the JSONL (the store writes run events only;
     * clients ignore unknown types per forward compatibility, and the trace
     * tab shows the frame). Sent once, after the workspace is resolved; the
     * Files tab then queries {@code GET /api/files?session=<id>}.
     */
    private synchronized void sendWorkspaceInfo() {
        if (workspaceAnnounced || workspace == null || !socket.isOpen()) {
            return;
        }
        try {
            socket.sendMessage(new TextMessage(mapper.writeValueAsString(Map.of(
                    "type", "workspace_info",
                    "sessionId", store.id(),
                    "path", workspace.toString(),
                    "configured", SessionWorkspaces.pinned(store.id()) != null
                            || config.workspace() != null))));
            workspaceAnnounced = true;
        } catch (Exception ignored) {
            // A dead socket just misses the hint — the Files tab falls back.
        }
    }

    /**
     * Tells the client which LLM backend is ACTIVE — a socket-only UI frame
     * like {@code workspace_info}, never appended to the JSONL. Sent on every
     * fresh connection and again after each successful provider switch, so
     * the header chip, the map locality and the trace host column always
     * reflect wire truth. The trace tab shows the frame itself — a provider
     * switch is a visible event, not a silent client-side swap.
     */
    private synchronized void sendProviderInfo() {
        if (!socket.isOpen()) {
            return;
        }
        SpectroConfig active = activeConfig.get();
        try {
            socket.sendMessage(new TextMessage(mapper.writeValueAsString(Map.of(
                    "type", "provider_info",
                    "provider", active.provider(),
                    "model", active.model(),
                    "host", active.providerHost()))));
        } catch (Exception ignored) {
            // A dead socket just misses the hint — the next frame retries nothing.
        }
    }

    /**
     * Tells the client which permission mode is ACTIVE — a socket-only UI frame
     * like {@code provider_info}, never appended to the JSONL. Sent on every
     * fresh connection and again after each successful mode switch, so the
     * composer gear always reflects wire truth rather than optimistic client
     * state.
     */
    private synchronized void sendPermissionModeInfo() {
        if (!socket.isOpen()) {
            return;
        }
        try {
            socket.sendMessage(new TextMessage(mapper.writeValueAsString(Map.of(
                    "type", "permission_mode_info",
                    "mode", permissionMode == null ? "ask" : permissionMode))));
        } catch (Exception ignored) {
            // A dead socket just misses the hint — the next frame retries nothing.
        }
    }

    /**
     * Pushes a readable problem to the client over the same event channel as
     * everything else — no side channel, the reducer folds it like any event.
     *
     * @param message the human-readable error text
     */
    public void sendError(String message) {
        // ErrorEvent is a first-class RunEvent, so the reducer handles it like any other.
        send(new RunEvent.ErrorEvent("main", message, System.currentTimeMillis()));
    }

    /** Closes the socket, best effort — used when a resume id cannot be loaded. */
    private void close() {
        try {
            socket.close();
        } catch (Exception ignored) {
            // best effort
        }
    }

    /**
     * Denies every parked permission question and clears both maps — no agent
     * thread may stay parked behind a socket that will never answer.
     */
    private void releasePending() {
        pending.values().forEach(future -> future.complete(false)); // deny orphans so no thread hangs
        pending.clear();
        pendingRequests.clear();
    }
}
