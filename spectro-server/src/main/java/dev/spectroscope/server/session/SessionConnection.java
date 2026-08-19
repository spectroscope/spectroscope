package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.WorkspaceResolver;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.events.RunEvent.Attachment;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import dev.spectroscope.core.hooks.HookRunner;
import dev.spectroscope.core.image.GenerateImageTool;
import dev.spectroscope.core.image.ImageProviders;
import dev.spectroscope.core.image.ImageStore;
import dev.spectroscope.core.leveling.LevelingPort;
import dev.spectroscope.core.mcp.McpServerRegistry;
import dev.spectroscope.core.permission.Allowlist;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.SwitchableProvider;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.skills.SkillInvocations;
import dev.spectroscope.core.skills.SkillLibrary;
import dev.spectroscope.core.subagents.SubagentConfig;
import dev.spectroscope.core.subagents.SubagentManager;
import dev.spectroscope.core.tools.DefaultHttpFetcher;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.tools.WebFetchTool;
import dev.spectroscope.core.trace.JsonlSink;
import dev.spectroscope.core.trace.OtlpSink;
import dev.spectroscope.core.trace.TracingPorts;
import dev.spectroscope.core.web.BrowsePageTool;
import dev.spectroscope.core.web.DefaultChromeRunner;
import dev.spectroscope.core.web.WebSearchTool;
import dev.spectroscope.core.wire.BrowserWireRecorder;
import dev.spectroscope.core.wire.LlmWireRecorder;
import dev.spectroscope.orchestrator.BusEnvelope;
import dev.spectroscope.server.fleet.FleetAggregator;
import dev.spectroscope.server.leveling.ServerLeveling;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
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

    private static final Logger log = LoggerFactory.getLogger(SessionConnection.class);

    /** Fleet frames a slow browser may buffer before the oldest is dropped. */
    private static final int FLEET_QUEUE = 1024;

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

    /**
     * Card 267: what this session is FOR, and the command that decides it.
     *
     * <p>It lives on the CONNECTION and not inside the system prompt string
     * above, because {@link #buildAgentOnce} runs once per browser session: a
     * goal baked into that one line could not be stated, changed or cleared
     * without a reconnect. The loop re-reads this object on every turn instead,
     * which is the whole of criterion 2 — the goal steers because it is
     * re-read, not because it was remembered.</p>
     */
    private dev.spectroscope.core.goal.SessionGoal goal;

    /** callId -> the future the agent's virtual thread is blocked on. */
    private final Map<String, CompletableFuture<Boolean>> pending = new ConcurrentHashMap<>();

    /** callId -> the parked permission request, so a "remember" response can scope its rule. */
    private final Map<String, PermissionRequest> pendingRequests = new ConcurrentHashMap<>();

    /**
     * The question side of the same idea (card 265): one extra map, kept apart
     * from {@link #pending} on purpose. {@link #onPermissionResponse}
     * unconditionally does allowlist-rule work, and a question must not trigger
     * any of it; the release rules also differ — a released gate is DENIED, which
     * is a legitimate verdict, while a released question is only ever
     * "nobody answered". Built once per connection, like the broker.
     */
    private final ParkingAsker asker = new ParkingAsker(this::mode, this::runSignal);

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
     *  session-moment reseed of {@link #imageProviderName}, and outranks the
     *  live per-call reading the belt makes (see {@link #liveImageProvider()}). */
    private volatile boolean imageProviderTouched;

    /** The belt {@link #buildAgentOnce} hung on the agent, or null before the
     *  first prompt. Card 222, review finding F4: the registry was a local
     *  variable, so deleting {@code registerSettingsTools(registry)} from the
     *  build removed web_search, web_fetch, browse_page, generate_image and the
     *  twelve browser/launch tools from every real session with the whole gate
     *  staying green. Holding it is what makes that call site assertable. */
    private volatile ToolRegistry belt;
    /** What children of this session inherit — see {@link #childBelt()}. */
    private volatile List<Tool> childBelt = List.of();

    /** The last refusal {@link #liveConfig()} reported, so a settings file the
     *  session may not read is announced when it breaks and not once per tool
     *  call. Holds the MESSAGE rather than a flag: a second, different breakage
     *  is news and gets said. */
    private volatile String reportedUnreadable;

    private SessionStore store;               // created on the first prompt (or on resume)
    // The tracing seam (KONZEPT §4.3): persistence rides a required port, so
    // bus/OTel consumers can dock without touching the drain loop. Built
    // wherever the store is — the sink holds the store it writes.
    private TracingPorts tracing;
    // The backend-to-LLM record (card 184): one recorder per session, minted
    // with the store, closed with the connection. Its metadata listener feeds
    // the llm_exchange socket frame; bodies stay in the sidecar file.
    private LlmWireRecorder llmWire;
    /** The session's browser record (card 204), opened wherever the store is
     *  minted — fresh and resume alike — because the sidecar is keyed by the
     *  store's id and appends across a resume. Null until then: a socket that
     *  never sent a prompt has no id to write under. */
    private BrowserWireRecorder browserWire;
    private List<ProviderMessage> initial = List.of();

    private volatile CancelSignal signal;     // the running run's signal, or null

    /** The live permission mode, for the asker's own short circuit — a method
     *  reference rather than a field read, because the asker is built before both
     *  fields exist and must see the CURRENT value on every question.
     *  @return the session's mode ("ask", "auto" or "readonly") */
    private String mode() {
        return permissionMode;
    }

    /** The running run's cancel signal, or null between runs.
     *  @return the signal the asker re-checks around its park */
    private CancelSignal runSignal() {
        return signal;
    }
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

    /** The picker's reasoning control (card 88): mode "on"|"off"|"default" or
     *  null (untouched), plus the effort level or null. Kept next to the
     *  thinking seed because the agent may not exist yet when the frame
     *  arrives — {@link #buildAgentOnce} replays them onto the fresh agent. */
    private final AtomicReference<String> reasoningMode = new AtomicReference<>();
    private final AtomicReference<String> reasoningEffort = new AtomicReference<>();

    /**
     * The header provider picker swaps this mid-session. The agent is built once
     * with a {@link SwitchableProvider} whose delegate this config feeds; a switch
     * either updates the delegate (agent already built) or seeds the first build.
     */
    private final AtomicReference<SpectroConfig> activeConfig;
    private SwitchableProvider switchable;   // the agent's provider indirection
    /** Card 247: the catalog runPrompt expands /skill tokens against — set with the agent. */
    private SkillLibrary skillLibrary;

    /** The process-wide live-session registry, or null — then this connection
     *  claims nothing and announces nothing, frame for frame the pre-212 one. */
    private final LiveSessions liveSessions;
    /** This connection's tap on the registry; registered on start, removed on close. */
    private LiveSessions.Listener liveListener;
    /**
     * Pending live-set snapshots, drained to the socket on this connection's OWN
     * thread. The registry pushes while holding its monitor, from whichever
     * connection's thread caused the change, so a blocking socket write there
     * would stall every other viewer on the machine — the same reason the fleet
     * frames ride a queue. Depth one and latest-wins: a snapshot is complete, so
     * an older one is worth nothing once a newer one exists.
     */
    private final ArrayBlockingQueue<List<LiveSessions.LiveSession>> liveQueue =
            new ArrayBlockingQueue<>(1);
    private volatile Thread liveDrain;

    /** The server-hosted fleet hub, or null/disabled — then no fleet frames ever. */
    private FleetAggregator fleet;

    /** The visible browsers (cards 201 and 218), or a directory in which no
     *  session has one. Set additively rather than through a seventh constructor
     *  parameter: every existing caller and test keeps compiling, and a run with
     *  no desktop shell behaves exactly as it did before the browser existed.
     *  Card 218 made it a directory: this connection asks it for ITS session's
     *  browser and can name no other. */
    private dev.spectroscope.core.browser.BrowserFaces browsers =
            dev.spectroscope.core.browser.BrowserFaces.none();
    /** What this session has launched (card 202) — one supervisor per session,
     *  for the same reason the browser is one per session: a dev server this
     *  session started is live state, and the session going away is the only
     *  event that can honestly be called "done with it". Closed in
     *  {@link #onClose()} beside the browser, and reaped by a JVM shutdown hook
     *  when nothing gets to run onClose at all. Package-visible so
     *  {@code SessionLaunchLifetimeTest} can put a REAL process under it and
     *  then ask the operating system whether closing the session killed it —
     *  the same move {@code LocalRuntime} makes for its reaper hook. */
    final dev.spectroscope.core.launch.LaunchSupervisor launches =
            dev.spectroscope.core.launch.LaunchSupervisor.real();
    /** This connection's fleet tap; registered on start, removed on close. */
    private FleetAggregator.Listener fleetListener;
    /** Pending fleet frames, drained to the socket on this connection's OWN
     *  thread so the aggregator's hub reader/tap threads never block on I/O. */
    private final ArrayBlockingQueue<FleetFrame> fleetQueue = new ArrayBlockingQueue<>(FLEET_QUEUE);
    private volatile Thread fleetDrain;

    /** One pending fleet frame: a full roster snapshot or a single event. */
    private sealed interface FleetFrame permits FleetRosterFrame, FleetEventFrame {
    }

    private record FleetRosterFrame(List<FleetAggregator.NodeState> roster) implements FleetFrame {
    }

    private record FleetEventFrame(BusEnvelope envelope) implements FleetFrame {
    }

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
        this(socket, mapper, config, resumeId, null);
    }

    /** The fleet form: {@code fleet} may be null or disabled — then this
     *  connection behaves exactly like the pre-fleet one, frame for frame. */
    public SessionConnection(WebSocketSession socket, ObjectMapper mapper,
                             SpectroConfig config, String resumeId, FleetAggregator fleet) {
        this(socket, mapper, config, resumeId, fleet, null);
    }

    /** The full form (card 212): {@code liveSessions} may be null — then this
     *  connection claims no session id and announces no live set, frame for
     *  frame the pre-212 one. */
    public SessionConnection(WebSocketSession socket, ObjectMapper mapper,
                             SpectroConfig config, String resumeId, FleetAggregator fleet,
                             LiveSessions liveSessions) {
        this.socket = socket;
        this.liveSessions = liveSessions;
        this.mapper = mapper;
        this.config = config;
        this.resumeId = resumeId;
        this.fleet = fleet;
        this.activeConfig = new AtomicReference<>(config);
        this.imageProviderName.set(config.imageProvider());
        this.thinking.set(config.thinking());
        this.permissionMode = config.permissionMode();
    }

    /**
     * Points this connection at the desktop browser pane.
     *
     * <p>Additive on purpose. The browser is the DESKTOP face's, and the owner
     * ratified that trade: a reader on {@code spectro web} gets a face that is
     * never attached and seven tools whose refusal sentences say so and name the
     * address they were asked for.
     *
     * @param faces the control channel, or {@code null} for no browser at all
     */
    public void useBrowser(dev.spectroscope.core.browser.BrowserFaces faces) {
        this.browsers = faces == null
                ? dev.spectroscope.core.browser.BrowserFaces.none() : faces;
    }

    /** The operator's side of this session's browser (card 227): the view
     *  socket resolves a session id to its sidecar recorder, its launch
     *  supervisor and its project folder through this bridge, and the fight
     *  rule counts agent browser calls on it. Null means no bridge — the
     *  pre-227 behaviour, which every existing test still constructs. */
    private dev.spectroscope.server.browser.SessionBrowserBridge browserBridge;

    /**
     * Points this connection at the operator bridge.
     *
     * @param bridge the bridge, or {@code null} for none
     */
    public void useBrowserBridge(dev.spectroscope.server.browser.SessionBrowserBridge bridge) {
        this.browserBridge = bridge;
    }

    /**
     * The folder this session's launch file is read from — the workspace once
     * one is resolved, else the pinned or configured folder by the same rule
     * {@code sendProspectiveWorkspace} mirrors, else null. Null is honest for
     * a fresh random-workspace session: its temp folder carries no launch
     * file, and naming one would mint a folder for a choice not yet made.
     *
     * @return the project folder, or null while this session has none
     */
    private Path launchProjectDir() {
        Path resolved = this.workspace;
        if (resolved != null) {
            return resolved;
        }
        String pinned = store == null ? null : SessionWorkspaces.pinned(store.id());
        String configured = pinned != null && !pinned.isBlank() ? pinned : config.workspace();
        if (configured == null || configured.isBlank()) {
            return null;
        }
        return WorkspaceResolver.locate(configured, null);
    }

    /**
     * This session's own browser, resolved per call.
     *
     * <p>Per call rather than once, for two reasons that both cost a live run
     * somewhere: the desktop shell can attach, detach and restart between two
     * tool calls, and the session id does not exist until the store is minted.
     * A session that never sent a prompt has no id and therefore no browser, and
     * the honest answer for it is the detached face rather than somebody else's
     * page.
     *
     * @return the face the seven browser tools drive
     */
    private dev.spectroscope.core.browser.BrowserFace ownBrowser() {
        SessionStore current = this.store;
        return current == null
                ? dev.spectroscope.core.browser.BrowserFace.none()
                : browsers.forSession(current.id());
    }

    /** Announces the boot provider, then (for a resume) loads the history; a bad id closes the socket. */
    public void start() {
        // Card 212, BEFORE anything is loaded or announced: one socket per
        // session id. A second connection on a session another socket already
        // drives would mean two stores appending to one JSONL file and two
        // agents replaying one history, so it is REFUSED — told which session,
        // and closed. The refusal costs the holder nothing: no frame, no state.
        if (liveSessions != null && resumeId != null
                && !liveSessions.claim(socket.getId(), resumeId)) {
            sendSessionBusy(resumeId);
            close();
            return;
        }
        // Every fresh socket learns the ACTIVE backend up front — the header
        // chip and the trace host column start from wire truth, not a guess.
        sendProviderInfo();
        sendPermissionModeInfo();
        // Fleet frames exist ONLY when the operator opted the hub in — with
        // the hub off, this connection is frame-for-frame the pre-fleet one.
        if (fleet != null && fleet.enabled()) {
            // The blocking socket writes happen on THIS connection's own drain
            // thread; the listener — invoked on the hub's reader/tap threads —
            // only offers to a bounded queue, so a slow browser can never stall
            // a joining node's ingest or another tab's fleet feed.
            fleetDrain = Thread.ofVirtual().name("spectro-fleet-drain").start(this::drainFleet);
            fleetListener = new FleetAggregator.Listener() {
                @Override
                public void onRoster(List<FleetAggregator.NodeState> roster) {
                    offerFleet(new FleetRosterFrame(roster));
                }

                @Override
                public void onFleetEvent(BusEnvelope envelope) {
                    offerFleet(new FleetEventFrame(envelope));
                }
            };
            // addListener delivers the connect-time roster into the queue
            // ATOMICALLY with registration: no join can slip through a gap
            // between snapshotting and listening.
            fleet.addListener(fleetListener);
        }
        // The live set, for THIS page's rail. Registration hands over the state
        // of the world in the same breath (see LiveSessions#addListener), so a
        // tab opened mid-run draws the other runs immediately instead of waiting
        // for one of them to change.
        if (liveSessions != null) {
            liveDrain = Thread.ofVirtual().name("spectro-live-drain").start(this::drainLive);
            liveListener = this::offerLive;
            liveSessions.addListener(liveListener);
        }
        if (resumeId == null) {
            sendProspectiveWorkspace();
            return;
        }
        try {
            initial = SessionStore.loadSession(resumeId); // reconstructs the provider messages
            store = new SessionStore(resumeId);           // appends to the existing JSONL file
            // Resume appends to an existing file, so the ladder counts from its
            // end — a receipt that names an event must name the right one.
            openSessionStack(SessionStore.eventCount(resumeId));
            // A resumed session knows its workspace immediately — announce it so
            // the Files tab points at the right folder before any prompt. A pin
            // from an earlier pick (same server process) wins over the config.
            String pinned = SessionWorkspaces.pinned(store.id());
            workspace = resolveAndRecord(
                    pinned != null ? pinned : config.workspace(), store.id());
            sendWorkspaceInfo();
        } catch (Exception missing) {
            // The claim was taken before the load; a session that cannot be
            // loaded must not stay held by a socket that is about to close.
            if (liveSessions != null) {
                liveSessions.release(socket.getId());
            }
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

    /**
     * A question_response completes the parked question (card 265) — and that is
     * ALL it does. No allowlist rule, no "remember", no persistence: a question
     * is not a permission, and a person answering one has consented to nothing.
     *
     * @param callId    the parked question this answers
     * @param answers   one answer per question asked; ignored when {@code cancelled}
     * @param cancelled true when the person closed the question without answering
     *                  (the bar's skip). Released, never answered: an empty string
     *                  is a person saying nothing, which is a different fact from
     *                  nobody saying anything
     */
    public void onQuestionResponse(String callId, List<String> answers, boolean cancelled) {
        asker.answer(callId, cancelled ? null : new dev.spectroscope.core.Asker.Answer(answers));
    }

    /** This session's asker — the seam the ask tests park on. */
    ParkingAsker asker() {
        return asker;
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
     *  connect-time snapshot) plus the remembered ones.
     *
     *  <p>Deliberately NOT on {@link #liveConfig()}, and this is the one place in
     *  the file where card 222's answer is "no". The belt was made live so the
     *  operator's choices reach the agent; the gate exists to protect the
     *  operator FROM the agent, and the agent can write files in the workspace —
     *  including {@code .spectro/settings.local.json}. A live allowlist would let
     *  a run widen its own permissions between two tool calls, with no human
     *  ever seeing the settings page. A saved {@code autoApprove} rule therefore
     *  takes effect in the next session, which is what the settings page says.</p> */
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
        reasoningMode.set(null);   // the plain toggle supersedes a picker choice
        reasoningEffort.set(null);
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
     * The picker's full reasoning control (card 88): mode plus optional effort
     * level. "off" reaches the provider WIRE in its own dialect (ollama
     * think:false, the bundled engine's chat-template switch, anthropic
     * thinking:disabled) — providers gate on their capability record, so an
     * endpoint without an off switch honestly sends nothing. The effort value
     * itself is validated by the provider against the same record; here only
     * the shape is checked.
     *
     * @param mode   "on" | "off" | "default"
     * @param effort a lowercase level token ("low".."max"), or blank for the
     *               model's default
     */
    public void onSetReasoning(String mode, String effort) {
        if (!Set.of("on", "off", "default").contains(mode)) {
            sendError("Unknown reasoning mode: \"" + mode + "\" (allowed: on, off, default).");
            return;
        }
        String level = effort == null || effort.isBlank() ? null : effort;
        if (level != null && !level.matches("[a-z]{1,16}")) {
            sendError("Unknown reasoning effort: \"" + effort + "\".");
            return;
        }
        reasoningMode.set(mode);
        reasoningEffort.set(level);
        thinking.set(!"off".equals(mode)); // keep the visibility seed coherent
        thinkingTouched = true;
        Agent current = this.agent;
        if (current != null) {
            applyReasoning(current);
        }
    }

    /** Replays the picker's reasoning choice onto an agent (live or fresh-built). */
    private void applyReasoning(Agent target) {
        String mode = reasoningMode.get();
        if (mode == null) {
            return;
        }
        target.setReasoning(switch (mode) {
            case "on" -> LlmProvider.ProviderRequest.Reasoning.ON;
            case "off" -> LlmProvider.ProviderRequest.Reasoning.OFF;
            default -> LlmProvider.ProviderRequest.Reasoning.DEFAULT;
        }, reasoningEffort.get());
    }

    /**
     * The header provider picker: switch the LLM backend (and optionally its model)
     * mid-session. Applies on the NEXT run, via the {@link SwitchableProvider} — the
     * agent and its history stay put. A missing key (anthropic) is reported and the
     * switch is refused, exactly like the CLI's provider construction.
     *
     * @param providerName one of {@link SpectroConfig#KNOWN_PROVIDERS} (anthropic,
     *        ollama, openai, lmstudio, openrouter, gemini) — anything else is refused
     * @param model the model to pair with the switch; blank picks the new provider's
     *        default, never the previous provider's model. A provider with no honest
     *        default (gemini, openrouter) needs an explicit model.
     */
    public void onSetProvider(String providerName, String model) {
        if (!SpectroConfig.isKnownProvider(providerName)) {
            sendError("Unknown provider: \"" + providerName + "\" (allowed: "
                    + SpectroConfig.KNOWN_PROVIDERS_DISPLAY + ").");
            return;
        }
        // Refuse a key-requiring cloud provider with no key AT SWITCH TIME, so the
        // header chip never flips to a backend whose only failure mode is a deferred
        // 401 on the next run (openai is exempt — the compat escape hatch, see
        // SpectroConfig#switchRequiresKey).
        if (SpectroConfig.switchRequiresKey(providerName)
                && !SpectroConfig.hasApiKey(SpectroConfig.keyEnvFor(providerName))) {
            sendError("\"" + providerName + "\" needs " + SpectroConfig.keyEnvFor(providerName)
                    + " — set a key in Settings, then switch.");
            return;
        }
        SpectroConfig current = activeConfig.get();
        String useModel;
        if (model != null && !model.isBlank()) {
            useModel = model.trim();
        } else {
            // A blank model on a switch must NOT carry the previous provider's model
            // (that shoved the Claude id into ollama/lmstudio). Resolve the target's
            // own default; a provider with no honest default needs an explicit model.
            useModel = SpectroConfig.defaultModelFor(providerName);
            if (useModel == null) {
                sendError("\"" + providerName + "\" needs a model — pick one in the picker.");
                return;
            }
        }
        SpectroConfig derived = current.withProvider(providerName, useModel);
        LlmProvider next;
        try {
            next = ServerProviders.build(derived); // spectro-local -> local runtime; else factory + key check
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
     * The new-chat workspace chooser: pin THIS session's workspace by MODE. Only
     * possible before the agent exists — afterwards the file sandbox, glob/grep,
     * run_command and every subagent are already anchored there, so a late switch
     * is refused with a readable error.
     * <ul>
     *   <li>{@code random} — a throwaway per-session temp folder (the default,
     *       even when a workspace is configured, so it can bypass one).</li>
     *   <li>{@code default} — the configured workspace, or the fixed
     *       {@code ~/spectroscope-workspace} when none is set.</li>
     *   <li>{@code set} — a specific folder ({@code path}) the operator picked.</li>
     * </ul>
     *
     * @param mode one of {@code random | default | set} (empty defaults to set)
     * @param path the picked directory — required for {@code set}, ignored otherwise
     */
    public void onSetWorkspace(String mode, String path) {
        if (agent != null) {
            sendError("The workspace is fixed once the agent has run — start a new chat to change it.");
            return;
        }
        try {
            ensureStore(); // the announcement carries the session id
            String picked;
            switch (mode) {
                case "random" -> picked = WorkspaceResolver.locate(null, store.id()).toString();
                case "default" -> {
                    String configured = activeConfig.get().workspace();
                    picked = (configured != null && !configured.isBlank())
                            ? configured.strip()
                            : WorkspaceResolver.defaultDir().toString();
                }
                case "set" -> {
                    if (path == null || path.isBlank()) {
                        sendError("set_workspace 'set' needs a path.");
                        return;
                    }
                    picked = path.strip();
                }
                default -> {
                    sendError("Unknown workspace mode: \"" + mode + "\" (random | default | set).");
                    return;
                }
            }
            workspace = resolveAndRecord(picked, store.id());
            // The pin is SHARED state: the REST side (/api/files) must root the
            // Files tab at the same folder the sandbox uses, and a resume in
            // this server process finds the folder again.
            SessionWorkspaces.pin(store.id(), picked);
            workspaceAnnounced = false; // re-announce: the Files tab re-roots live
            sendWorkspaceInfo();
        } catch (RuntimeException rejected) {
            sendError("Workspace rejected: " + rejected.getMessage());
        }
    }

    /** The stop button: cancel the run's signal — the same signal the loop checks.
     *  Detached to a virtual thread: cancel listeners close provider streams (I/O),
     *  and the WebSocket handler thread must neither block on that nor die on it —
     *  a listener exception here used to ride up into Spring's decorator and CLOSE
     *  the whole session (card 78). The frame handler stays instant either way. */
    public void onAbort() {
        CancelSignal current = this.signal;
        if (current != null) {
            Thread.ofVirtual().name("spectro-abort").start(current::cancel);
        }
    }

    /** Socket closed: cancel the run, release orphaned questions, close MCP. The file stays. */
    public void onClose() {
        onAbort();
        releasePending();
        // Card 218: the session is closed, so its browser is closed. "Closed"
        // here is exactly this event — the socket that held the session went
        // away, which is the same thing that cancels its run and releases its
        // permission questions. The JSONL survives and the id survives; the
        // browser does not, because a browser is live state (a logged-in page, a
        // cookie jar, a scroll position) and not a record. A session that never
        // minted a store never had one to close.
        SessionStore opened = this.store;
        if (opened != null) {
            browsers.closeSession(opened.id());
        }
        // Card 202: and so does everything this session launched. Same event,
        // same reasoning as the browser — a dev server left holding a port after
        // the session that started it is gone is an orphan nobody will remember
        // to kill. Unconditional: the supervisor exists from the constructor,
        // and closing an empty one costs nothing.
        launches.close();
        // Card 212: stop listening BEFORE releasing, so this dying socket is not
        // one of the viewers its own departure is announced to; then let the id
        // go, which is what makes a reload or a dropped connection safe rather
        // than a lockout.
        if (liveSessions != null) {
            if (liveListener != null) {
                liveSessions.removeListener(liveListener);
            }
            liveSessions.release(socket.getId());
            if (liveDrain != null) {
                liveDrain.interrupt();
            }
        }
        if (fleet != null && fleetListener != null) {
            fleet.removeListener(fleetListener); // no fleet frames to a dead socket
            if (fleetDrain != null) {
                fleetDrain.interrupt(); // stop draining; the abandoned queue is collected
            }
        }
        McpServerRegistry current = this.mcp;
        if (current != null) {
            current.close(); // tear down this connection's MCP server processes/connections
        }
        LlmWireRecorder wire = this.llmWire;
        if (wire != null) {
            wire.close(); // flushed per line, so closing only releases the writer
        }
        BrowserWireRecorder browserRecord = this.browserWire;
        if (browserRecord != null) {
            browserRecord.close(); // same: per-line appends, nothing buffered to lose
        }
        // Card 227: the operator's bridge entry dies with the socket that fed
        // it — a view-socket verb for this session now says "not open" instead
        // of writing through a closed recorder.
        if (browserBridge != null && store != null) {
            browserBridge.unregister(store.id());
        }
    }

    /**
     * Lazily mints the session store. Attachments pull this ahead of the run:
     * blob writes need the session id (store.id()) before runPrompt starts.
     */
    private void ensureStore() {
        if (store == null) {
            store = new SessionStore();   // the store mints the id (store.id())
            openSessionStack(0);          // a fresh file counts its ladder from zero
            // A fresh session becomes live the moment it has an id — that is
            // the first moment anything can be said about it. The claim stays
            // HERE, after the stack and only on the fresh path — the resume
            // path claims BEFORE it loads (card 212's ordering), and that
            // difference is behavior, not duplication.
            if (liveSessions != null) {
                liveSessions.claim(socket.getId(), store.id());
            }
        }
    }

    /**
     * ONE assembly of the session's store-side stack (finding 10 of the
     * 2026-08-14 review): the llm-wire sidecar, the required JSONL sink, the
     * optional OTLP sink with this connection's export mirror, and the leveling
     * ladder. Both entry points — a fresh store and a resume — used to spell
     * this chain out by hand, which meant the NEXT sink (card 137's Langfuse
     * direction) would have been wired twice or, worse, once.
     *
     * <p>What stays at the entry points is what genuinely differs: who mints or
     * loads the store, and when the live-set claim happens (the resume path
     * claims before loading, the fresh path after minting — card 212).</p>
     *
     * @param levelingStartIndex where the ladder starts counting — 0 for a
     *        fresh file, the existing event count on a resume, so a receipt
     *        that names an event names the right one
     */
    private void openSessionStack(int levelingStartIndex) {
        openLlmWire();                // the sidecar shares the store's id
        tracing = new TracingPorts().require(new JsonlSink(store));
        OtlpSink.fromConfig(activeConfig.get(), store.id())
                .ifPresent(sink -> tracing.register(sink.withListener(this::sendOtlpExport)));
        // Registered, never required: the ladder watches the same stream the UI
        // renders, and a leveling defect must never cost a run its life.
        tracing.register(new LevelingPort(store.id(), ServerLeveling.recorder(), levelingStartIndex));
    }

    /**
     * Opens the session's llm-wire sidecar recorder (card 184) and wires its
     * metadata listener to the {@code llm_exchange} frame. Called wherever the
     * store is minted, fresh and resume alike, so both paths record their
     * backend calls under the same session id the read endpoints resolve.
     */
    private void openLlmWire() {
        llmWire = LlmWireRecorder.forSession(store.id());
        llmWire.onExchange(this::sendLlmExchange);
        llmWire.onRequest(this::sendLlmRequest);
        // Card 204, opened in the same breath and for the same reason: the
        // browser record is keyed by the store's id and appends across a resume.
        // It has no listener — a browser call announces itself as an ordinary
        // additive `browser_action` RunEvent from the tool that made it, so it
        // takes the file-then-socket road every other event takes rather than a
        // second path through this class.
        browserWire = BrowserWireRecorder.forSession(store.id());
        // Card 227: the moment this session has an id and a recorder, the view
        // socket's operator verbs can reach both — same recorder, so a human's
        // navigation lands in the same file under the same epoch as the
        // agent's, and the launch supervisor whose lifetime IS the session's.
        if (browserBridge != null) {
            browserBridge.register(store.id(),
                    new dev.spectroscope.server.browser.SessionBrowserBridge.Live(
                            browserWire, launches, this::launchProjectDir));
        }
    }

    /**
     * This session's browser record, for the tools to write through and for the
     * lifetime test to measure.
     *
     * @return the recorder, or null while this connection has no session id
     */
    BrowserWireRecorder browserWire() {
        return browserWire;
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
        // Card 265, release path 1: the stop button cancels this signal while the
        // agent's own thread may be parked on a question, and the run's finally
        // below cannot run until that thread comes back. So cancellation releases
        // the parked questions itself — the same listener GateBroker registers in
        // its constructor, and the reason the asker re-checks after publishing.
        runSignal.onCancel(asker::releaseAllPending);
        ensureStore();
        reportRunning(true);   // every rail on this machine, not just this page

        try {
            // Everything below is exactly what the CLI builds — nothing new in the core.
            buildAgentOnce();
            refreshContinuationBudget(); // card 266: the operator's number, per prompt
            sendWorkspaceInfo();
            sendGoalInfo(); // card 267: what this run is for, where it is watched

            // The run goes through the SubagentManager: parent and child
            // events merge into ONE stream. ONE sender virtual thread drains it and
            // writes each event out — Spring's WebSocketSession does not tolerate
            // concurrent sends, so one drainer per connection is the whole story.
            // Card 247: /skill tokens expand into the skill bodies — for the
            // MODEL only. The record (run_start.prompt, the user's bubble)
            // keeps the literal text; the llm-wire proves what was sent.
            String expanded = skillLibrary == null
                    ? text
                    : SkillInvocations.expand(text, skillLibrary::find);
            try (EventStream events = subagents.run(agent, text,
                    new RunOptions(runSignal, attachments, expanded.equals(text) ? null : expanded))) {
                for (RunEvent event : events) {
                    tracing.onEvent(event); // file and socket get the SAME object
                    send(event);
                }
            }
        } catch (RuntimeException failure) {
            sendError("Run ended with an error: " + failure.getMessage());
        } finally {
            running = false;
            reportRunning(false);      // a run that died still stopped running
            this.signal = null;
            releasePending();          // orphaned questions: deny them
        }
    }

    /**
     * Tells the registry whether THIS session has a run in flight, so every
     * other viewer's rail can draw the pulse. Silent without a registry or
     * before the store exists — there is no session to talk about yet.
     *
     * @param inFlight true when a run just started, false when it ended
     */
    private void reportRunning(boolean inFlight) {
        SessionStore current = this.store;
        if (liveSessions != null && current != null) {
            liveSessions.running(socket.getId(), current.id(), inFlight);
        }
    }

    /**
     * Builds agent + manager on the first prompt and keeps BOTH for the whole
     * connection: the agent instance carries the multi-turn history (a second
     * prompt in the same tab continues the conversation, like the CLI REPL),
     * and the spawn tools inside the registry reference exactly this manager
     * instance — a rebuilt manager would leave them pointing at a dead one.
     *
     * <p>Package-private, like {@link #adoptSessionConfig} and
     * {@link #registerSettingsTools} beside it: card 222's review found that
     * nothing pinned this method's own call sites. Deleting one line of it took
     * six tool families out of every session and left the gate green.</p>
     */
    void buildAgentOnce() {
        if (agent != null) {
            return;
        }
        // The agent's working world: a folder the user picked for this session
        // (the shared pin — a resume in this process finds it too), else the
        // configured workspace, else this session's deterministic temp folder
        // (the store minted the id already). The Files tab learns it through
        // the workspace_info frame below.
        String pinned = SessionWorkspaces.pinned(store.id());
        workspace = resolveAndRecord(
                pinned != null ? pinned : config.workspace(), store.id());

        // Card 199, criterion 8: the one-time, in-place migration of allowlist
        // entries onto tiers, run BEFORE the session-moment load so the config
        // this session reads is the migrated one. Idempotent (the ledger decides
        // "once") and never throwing.
        migrateAllowlistOnce();

        SpectroConfig sessionConfig = adoptSessionConfig();

        PermissionBroker broker = parkingBroker();

        // The provider is wrapped in a SwitchableProvider so the header picker can
        // swap the backend mid-session (activeConfig carries any pre-run switch).
        SpectroConfig active = activeConfig.get();
        switchable = new SwitchableProvider(ServerProviders.build(active), active.provider());
        LlmProvider provider = switchable;
        // the skill catalog rides in the system prompt, bodies come via use_skill.
        SkillLibrary skills = SkillLibrary.load(SkillLibrary.defaultRoots(projectDir));
        this.skillLibrary = skills; // card 247: runPrompt expands /skill tokens against it
        String systemPrompt = BASE_SYSTEM_PROMPT + workspace + SpectroConfig.loadProjectMd(projectDir)
                + SpectroConfig.loadAgentsMd(workspace) + skills.systemPromptSection();
        // Card 267: the goal is NOT part of that line, on purpose. This assembly
        // is evaluated ONCE per session and the goal has to be re-readable per
        // turn; the loop appends it to each request's system prompt instead. Off
        // disk, so a resumed session resumes its goal — the same durable-artifact
        // pattern loadAgentsMd uses one line above.
        goal = new dev.spectroscope.core.goal.SessionGoal(
                new dev.spectroscope.core.goal.CommandGoalCheck());
        goal.state(dev.spectroscope.core.goal.GoalStore.read(
                dev.spectroscope.core.goal.GoalStore.fileFor(store.id())));

        ToolRegistry registry = new ToolRegistry();
        StandardTools.all().forEach(registry::register);
        // ONE supplier step, two consumers (card 270, criterion 3): the settings
        // belt is assembled once and its tools go on the parent registry AND into
        // the belt the children inherit. The returned trio inside it is the
        // research role's web grant (card 205) — the SAME instances, so a child
        // call passes the same gate.
        SettingsToolBelt.Belt settingsBelt = registerSettingsTools(registry);
        List<Tool> webTools = settingsBelt.webGrant();
        // The plan tool is main-only (see SpectroCli) — the flat UI plan
        // snapshot must not be clobbered by a subagent. describeContext lists it
        // from its own instance; this registration only feeds the live agent.
        registry.register(new dev.spectroscope.core.tools.UpdatePlanTool());
        // Card 265: the ask, registered HERE and only here on this face, for the
        // same reason as the plan tool above — registration IS the fence. This
        // face has a person attached (a browser holding a socket), so the model
        // may see the verb; a headless run, a cron fire, a library lane and a
        // subagent never assemble their belts from this method, so the tool
        // cannot reach a face where nobody could answer. Not in childBase either:
        // a child's question would park the CHILD's loop behind a bar the
        // operator's own run does not own.
        registry.register(new dev.spectroscope.core.tools.AskUserQuestionTool(asker));
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
        // Card 270: the child's belt is the PARENT's belt, assembled from the same
        // steps and in the same order — standard tools, the settings belt
        // (browser family, launch family, generate_image, the web trio), the MCP
        // tools the operator configured, and use_skill when skills exist.
        //
        // Before this card it was hand-listed here as StandardTools.all() plus
        // use_skill, and everything registered in the four lines above reached the
        // PARENT only. A `test` child advertised verification and held no way to
        // open a page; a child could not touch a single MCP server the operator
        // had configured. The baseline session in konzept/ORCHESTRATION.md §2
        // caught the model reasoning its way to exactly that and declining the
        // role — correctly.
        //
        // Every entry is one of the parent's OWN tool instances, so a child's call
        // passes the same broker, the same allowlist and the same card-199 tiers
        // as the parent's. What a role gives up out of this belt is declared in
        // RoleCatalog.beltPolicy and readable from RoleCatalog.roleProfiles —
        // explore keeps its read-only keep-list, a worker carries the belt whole.
        //
        // update_plan is deliberately NOT here: the flat UI plan snapshot is
        // main-only and a child writing it would clobber the operator's view.
        // Neither are the spawn and dev verbs, registered below — depth stays 1
        // by construction.
        List<Tool> childBase = new ArrayList<>(StandardTools.all());
        childBase.addAll(settingsBelt.tools());
        childBase.addAll(mcp.tools());
        if (!skills.skills().isEmpty()) {
            childBase.add(skills.useSkillTool());
        }
        // Config-only pre/post_tool_use shell hooks — from the SESSION-scoped config
        // (the workspace's own settings, resolved above), like mcpServers just above.
        // Loaded before the SubagentManager so children run the same guard as the parent.
        HookRunner hooks = HookRunner.load(sessionConfig.hooks());

        // Card 270: ONE latency window per session, shared by the parent agent
        // and every child. The parent's own exchanges are what price the
        // children, which is the whole point — a child's budget is derived from
        // the backend this session is actually talking to, not from a literal.
        // The window is empty on the first prompt, so the first child of a
        // session is priced at ChildBudget's floor and every later one on
        // measurement.
        dev.spectroscope.core.provider.ExchangeLatency latency =
                new dev.spectroscope.core.provider.ExchangeLatency();

        subagents = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(workspace)
                .parentAgentId("main")
                .onPermission(broker)
                .baseTools(childBelt = List.copyOf(childBase))
                .hooks(hooks)
                .llmWire(llmWire) // the SAME recorder the parent writes on (card 231)
                .webTools(webTools)
                .budget(dev.spectroscope.core.subagents.ChildBudget.derivedFrom(latency))
                // card 263 AC 3: the same number the parent agent is built with
                // below, so the operator's instruction governs the whole tree
                .compactionThreshold(active.compactionThreshold())
                .build());
        // spawn + dev tools ONLY in the parent registry — otherwise a browser run
        // could never emit agent_spawn events, which the graph tab needs live.
        subagents.tools().forEach(registry::register);
        subagents.devTools().forEach(registry::register);
        this.belt = registry;   // card 222 F4: what this session actually carries

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
                .llmWire(llmWire) // the backend-to-LLM record rides the session's recorder (card 184)
                .latency(latency) // the parent's own exchanges price its children (card 270)
                // Card 262: this face has a person attached (a browser holding a
                // socket), so the guard can do what the owner decided — warn AND
                // pause — through the very asker card 265 built. It reuses that
                // park rather than inventing a second waiting mechanism, because
                // two of those can disagree about who is waiting.
                .progressGuard(new dev.spectroscope.core.progress.ProgressGuard(
                        new dev.spectroscope.core.progress.ProgressSettings(
                                active.progressGuardWrites(),
                                active.progressGuardFailures(),
                                active.progressGuardPlanTurns()),
                        asker))
                // Card 266: a browser holds this socket, so somebody is
                // watching the bill — the owner's first call names the attended
                // face as the one that continues. The budget is re-read per
                // PROMPT below, not only here, because the agent is built once
                // per session and a number readable only at build time would
                // need a reconnect to change.
                .continuationLeash(new dev.spectroscope.core.loop.ContinuationLeash(
                        active.continuationBudget()))
                // Card 267: the goal, with the SHIPPED teeth — a command whose
                // exit code is the verdict. The evaluator variant exists and is
                // wired nowhere: on this house's own backend the judge would be
                // weaker than the worker it judges, which is what owner call 1
                // is about and what the card measured.
                .goal(goal)
                .build());
        // A picker reasoning choice made before the first prompt must survive
        // the build — the boolean seed above cannot carry mode "off" or an
        // effort level.
        applyReasoning(agent);
    }

    /**
     * Re-reads the operator's continuation budget onto the live leash (card 266,
     * criterion 7).
     *
     * <p>Called at the top of every prompt. {@code buildAgentOnce} runs once per
     * browser session, so a budget read only there could not be changed without
     * a reconnect — which is a rebuild by another name. The settings panel
     * already writes this key through {@code SettingsWriter}; this is what makes
     * the number it wrote govern the very next run.</p>
     */
    void refreshContinuationBudget() {
        if (agent == null || agent.continuationLeash() == null) {
            return;
        }
        SpectroConfig active = activeConfig.get();
        if (active != null) {
            agent.continuationLeash().setBudget(active.continuationBudget());
        }
    }

    /** This session's agent, for the tests that pin what the live build wired
     *  onto it rather than what a test wired onto one of its own.
     *  @return the agent {@link #buildAgentOnce} built, or null before the first
     *          prompt */
    Agent agent() {
        return agent;
    }

    /** This session's id — the basename its JSONL, its llm-wire sidecar and its
     *  goal file are all named after.
     *  @return the id, or null before the store exists */
    String sessionId() {
        return store == null ? null : store.id();
    }

    /** The tool belt this session's agent carries, for the test that pins the
     *  registrations to the build rather than to a registry a test made itself.
     *  @return the registry {@link #buildAgentOnce} built, or null before the
     *          first prompt */
    ToolRegistry belt() {
        return belt;
    }

    /**
     * The belt this session hands its CHILDREN — the other half of the same
     * evidence, and the half card 270 left unreadable.
     *
     * <p>Card 270 widened this from a hand-listed {@code StandardTools.all()}
     * plus {@code use_skill} to the parent's whole assembly, and decided at the
     * same seam that {@code update_plan} and {@code ask_user_question} stay off
     * it. Both are decisions made by REGISTRATION — a line's position in
     * {@link #buildAgentOnce} and nothing else — so like the parent's fence they
     * are only provable by reading what the face actually built. Without this
     * reader, one moved line hands every worker child the power to park the
     * operator behind a question of its own, with the whole suite green.</p>
     *
     * @return the child belt {@link #buildAgentOnce} assembled, empty before the
     *         first prompt
     */
    List<Tool> childBelt() {
        return childBelt;
    }

    /**
     * The session moment: the workspace's own {@code .spectro} pair joins the
     * chain now, and what it resolves to becomes this session's active config.
     *
     * <p>A pre-build provider switch (activeConfig differs from the connect
     * snapshot) stays on top of the re-resolved config; a broken workspace file
     * is loud but never fatal — the session falls back to the connect-time view.
     * The three live seeds (permission mode, thinking, image provider) are only
     * overwritten where the operator has not already touched them.</p>
     *
     * <p>Package-private beside {@link #registerSettingsTools}: the two together
     * are what {@link #buildAgentOnce} does to the settings, and a test that
     * only called the second one would be testing a belt no session ever has.
     * That is not hypothetical — it is how the card-222 test first failed its
     * own premise.</p>
     *
     * @return the session-scoped config, for the collaborators that must be
     *         built from the session moment and not from a later reading
     */
    SpectroConfig adoptSessionConfig() {
        SpectroConfig sessionConfig;
        try {
            sessionConfig = SpectroConfig.loadForWorkspace(SpectroConfig.Overrides.none(), projectDir, workspace);
            SpectroConfig switched = activeConfig.get();
            if (!switched.provider().equals(config.provider()) || !switched.model().equals(config.model())) {
                sessionConfig = sessionConfig.withProvider(switched.provider(), switched.model());
            }
        } catch (IllegalArgumentException invalidWorkspaceScope) {
            // Through the same door as the belt's per-call reading, so the
            // session moment and the first tool call cannot say it twice.
            reportUnreadable(invalidWorkspaceScope);
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
        return sessionConfig;
    }

    /**
     * The settings as they stand RIGHT NOW — the reading every tool on the belt
     * makes, on every call.
     *
     * <p>Card 222, and the part of it that is not obvious. {@link #activeConfig}
     * is a SNAPSHOT: it is written at connect, again at the session moment
     * ({@link #adoptSessionConfig()}), and by a provider switch — and by nothing
     * else, ever. No settings write touches it, because a settings write happens
     * in a REST controller that has never heard of this connection. So the
     * per-call suppliers the belt already had (the image model, the Chrome
     * binary, the net fence) were per-call over a frozen value: they re-read a
     * reference nobody was updating. That is why the comments above them claimed
     * a liveness the code did not have — the shape was right and the source was
     * dead.</p>
     *
     * <p>This method reads the settings files again, so the reading is live for
     * real. Two deliberate choices:</p>
     * <ul>
     *   <li><b>No caching.</b> A stat-and-compare would have to decide when a
     *       hand-edited file counts, and the cost being avoided is four small
     *       JSON reads next to a network call or an LLM round trip.</li>
     *   <li><b>The provider and model do not come from here.</b> They belong to
     *       the header picker and the {@link SwitchableProvider} it swaps, which
     *       is a live path of its own; a file-scope provider change would have to
     *       swap that delegate, and doing it from a tool call is a different
     *       card. So the currently active pair is carried over the fresh read.</li>
     * </ul>
     *
     * <p>A settings file this session may not use — unparsable, or a workspace
     * scope holding a key that scope is refused (see
     * {@code SpectroConfig.rejectProcessGlobals}) — is neither fatal nor silent:
     * the session's own config answers, and {@link #reportUnreadable} says so
     * over the same error frame the session moment uses. Note WHICH config that
     * is: the one adopted at the session moment, not the last live reading that
     * happened to succeed. A file the agent broke must not leave the session
     * standing on a value from the same hand.</p>
     *
     * @return the freshly resolved settings for this session's workspace, or the
     *         session's own config when the files cannot be read
     */
    SpectroConfig liveConfig() {
        SpectroConfig last = activeConfig.get();
        if (workspace == null) {
            return last;   // before the session moment there is nothing newer to read
        }
        try {
            SpectroConfig fresh =
                    SpectroConfig.loadForWorkspace(SpectroConfig.Overrides.none(), projectDir, workspace);
            reportedUnreadable = null;   // a good read makes the next breakage news again
            return fresh.withProvider(last.provider(), last.model());
        } catch (RuntimeException unreadable) {
            reportUnreadable(unreadable);
            return last;
        }
    }

    /**
     * Says ONCE that a settings file in this session's chain is being ignored.
     *
     * <p>Card 222, review finding F3. The javadoc above claimed the reader was
     * told; the body was {@code catch (RuntimeException unreadable) { return
     * last; }} — no frame, nothing. That is criterion 4's own defect, a comment
     * stating an intent the code cancels, reintroduced by the change ordered to
     * remove two of them. The silence costs more than it reads: a refused
     * workspace scope drops EVERY key in that file, so the operator's project
     * model or image backend quietly stops applying with nothing on screen.</p>
     *
     * <p>Once, not once per call: the belt makes this reading on every tool
     * call, so an unconditional frame would be a storm. The memory holds the
     * message rather than a flag — a second, different breakage is news — and a
     * successful read clears it, so the same file breaking again is said
     * again.</p>
     *
     * @param unreadable what the settings loader refused with
     */
    private void reportUnreadable(RuntimeException unreadable) {
        String message = "workspace settings ignored: " + unreadable.getMessage();
        if (!message.equals(reportedUnreadable)) {
            reportedUnreadable = message;
            sendError(message);
        }
    }

    /**
     * Every tool on the belt whose behaviour depends on the SETTINGS, wired in
     * one place and over one reading: {@link #liveConfig()}.
     *
     * <p>They are gathered here rather than left inline in {@link #buildAgentOnce}
     * because the registry is built exactly once per session and these are the
     * registrations for which that matters. Card 222 is the bill for the version
     * that was spread out: {@code web_search} resolved its tier eagerly among
     * neighbours that looked as though they resolved theirs per call, and nobody
     * could see the difference by reading down the method.</p>
     *
     * <p><b>The answer is the same for all of them.</b> Not "web_search is fixed
     * now" — every setting a tool here reads is read again on the call. What
     * this method does NOT cover is listed on the card and said on the settings
     * page: the workspace, the MCP servers, the shell hooks, the system prompt
     * and its skills, and the CONFIGURED compaction threshold are settled when
     * the agent is built and stay settled, because changing them mid-session
     * would mean killing processes or rewriting a conversation that already
     * happened.</p>
     *
     * <p>Half of that last one moved with card 263 and the sentence above would
     * otherwise be the harder kind of stale — true enough to believe. What the
     * operator TYPED is still read once, at {@code buildAgentOnce}. What is
     * DERIVED when they typed nothing is re-computed at the head of every run
     * from the window the backend reports, so a backend that loads a different
     * model mid-session changes the threshold on the next run and not on this
     * one.</p>
     *
     * <p>Package-private so a test can hold this belt without a provider and a
     * whole run: the tier a tool USED is only assertable on the tool object the
     * session actually carries.</p>
     *
     * @param registry the session's registry, already carrying the standard tools
     * @return the assembled belt: every tool it put on the registry, plus the
     *         three web tools (web_search, web_fetch, browse_page) called out as
     *         the research role's web grant (card 205). Card 270 needs the whole
     *         list rather than the trio alone — the belt a child inherits IS this
     *         belt, so returning only part of it was how the browser and launch
     *         families came to be missing from every child
     */
    SettingsToolBelt.Belt registerSettingsTools(ToolRegistry registry) {
        // Built lazily per call, through ONE method, so a test can hold the
        // answer without a picture being generated: card 222's review finding
        // F6 measured that reverting the model half of this to the connect-time
        // snapshot left the full gate green — the page said "live" and nothing
        // said it here.
        //
        // The belt's membership and order live in SettingsToolBelt (card 231
        // criterion 3), shared with ContextDescriber, so the introspection list
        // cannot under-report a family again. What stays HERE is the live
        // wiring: every configuration-shaped seam is a reader over liveConfig()
        // (card 222), and the browser tap carries card 227's agent guard.
        //
        // Card 204: the browser recorder is read per call, like the fence and
        // the face — this registry is built once and a resume opens a NEW
        // recorder under the same session id, so a recorder captured here would
        // be the one that has already been closed. Card 227: wrapped in the
        // bridge's agent guard, so "an agent browser call is in flight" is
        // measured on the very seam that records it.
        java.util.function.Supplier<dev.spectroscope.core.wire.BrowserWireTap> recorderTap =
                () -> browserWire == null
                        ? dev.spectroscope.core.wire.BrowserWireTap.none() : browserWire;
        java.util.function.Supplier<dev.spectroscope.core.wire.BrowserWireTap> guardedTap =
                browserBridge == null
                        ? recorderTap
                        : () -> browserBridge.agentGuard(
                                () -> store == null ? null : store.id(), recorderTap);
        SettingsToolBelt.Belt belt = SettingsToolBelt.assemble(new SettingsToolBelt.Seams(
                this::liveImageBackend,
                ImageStore.inUserHome(),
                llmWire, // non-null here: ensureStore() ran before buildAgentOnce() (card 184)
                new DefaultHttpFetcher(),
                this::liveConfig,
                this::liveFence,
                // chromeEnv() overlays the settings-hierarchy chromeBinary onto
                // the process env; read fresh per call, like every seam here.
                () -> BrowsePageTool.findChrome(liveConfig().chromeEnv()),
                new DefaultChromeRunner(),
                this::ownBrowser,
                guardedTap,
                // The supervisor is the connection's own field, so what a
                // session starts dies when that session's socket does (card 202).
                launches));
        belt.tools().forEach(registry::register);
        // The whole belt back: the parent registry just took it, and card 270's
        // child base takes the same instances.
        return belt;
    }

    /**
     * The image backend {@code generate_image} runs on, resolved and built for
     * the call being made — the whole of it, in one method, so a test can hold
     * the answer without a picture being generated.
     *
     * @return the provider for this call
     * @throws IllegalStateException when the resolved backend has no key — the
     *         tool turns that into an error naming the variable
     */
    dev.spectroscope.core.image.ImageProvider liveImageBackend() {
        return ImageProviders.create(
                liveImageProvider(), liveConfig().imageModel(), SpectroConfig.imageEnv());
    }

    /**
     * The image backend for the call being made.
     *
     * <p>Three sources, and the order between them is the point.</p>
     * <ol>
     *   <li>The composer's dropdown, when a human used it: it writes
     *       {@link #imageProviderName} over the websocket and sets
     *       {@link #imageProviderTouched}. A live choice the operator made in
     *       this session outranks a file saved under it — the same rule the
     *       session moment already applies to this seed, to the permission mode
     *       and to thinking. This is the ONE condition the settings page's image
     *       block still has to state, and it does.</li>
     *   <li>Otherwise the settings, read again on the call, like the image model
     *       beside it — so a backend saved while this session is open decides
     *       the next generation.</li>
     *   <li>…unless that backend has no key and another one does, in which case
     *       the generation runs where it can actually run
     *       ({@link ImageProviders#withAKey}). That is the owner's smart default
     *       from 2026-07-20, and it is a FUNCTION of the settings and the keys —
     *       re-derived here on every call, so giving the configured backend a
     *       key makes it evaporate.</li>
     * </ol>
     *
     * <p>Card 222, review finding F1: this method used to be
     * {@code imageProviderName.get()} alone, an in-memory reference written at
     * connect, at the session moment and by that websocket message — and by no
     * settings write, ever. The page said "applies immediately, including to a
     * session already open" directly under the dropdown that saves it.</p>
     *
     * <p>Review finding F5, one round later: the smart default was the web app's,
     * and the app announced it with {@code set_image_provider} — the same message
     * a human dropdown pick sends. So the app set {@link #imageProviderTouched}
     * on its own, on a plain reconnect, and case 1 above swallowed the settings
     * page for the rest of the session with nobody having touched anything. The
     * rule is not a choice and is no longer remembered as one: it moved here, to
     * the call, and the app now only pre-selects what this will resolve to.</p>
     *
     * @return the backend name {@code generate_image} should resolve now
     */
    private String liveImageProvider() {
        if (imageProviderTouched) {
            return imageProviderName.get();
        }
        return ImageProviders.withAKey(liveConfig().imageProvider(), SpectroConfig.imageEnv());
    }

    /** The net fence as the settings define it right now — one spelling for the
     *  five tools that take one, so an {@code allowLocalhost} opt-in cannot
     *  reach four of them and miss the fifth.
     *  @return the fence to apply to the call being made */
    private dev.spectroscope.core.net.NetFence liveFence() {
        return dev.spectroscope.core.net.NetFence.withSystemDns(liveConfig().allowLocalhost());
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
            // Card 199: one verdict, read once, so the gate audit line names the
            // same tier and the same entry the decision was actually made on.
            Allowlist.Verdict verdict = allowlistNow().decide(request);
            Boolean byMode = PermissionModes.decide(permissionMode, request);
            if (byMode != null) {
                gateAudit().record(request, "mode:" + permissionMode, byMode, verdict);
                return byMode;
            }
            if (verdict.approved()) {
                gateAudit().record(request, "allowlist", true, verdict);
                return true;
            }
            pendingRequests.put(request.callId(), request);
            CompletableFuture<Boolean> future = new CompletableFuture<>();
            pending.put(request.callId(), future);
            boolean allowed = future.join();   // parks the agent's virtual thread — cheap
            gateAudit().record(request, "user", allowed, verdict);
            return allowed;
        };
    }

    /** Card 199, criterion 8: every settings file in this session's chain is
     *  migrated onto tiers exactly once, recorded entry by entry in
     *  {@code ~/.spectro/gate-audit/allowlist-migration.jsonl}. The ledger, not
     *  a marker inside the settings file, decides "once" — the settings schema
     *  stays untouched and the migration is auditable by the same act. The chain
     *  itself comes from {@code AllowlistMigration.settingsChain} rather than
     *  being listed here: three hand-written copies of that list drifted apart,
     *  and the workspace-local layer fell out of all three. */
    private void migrateAllowlistOnce() {
        var tiers = dev.spectroscope.core.permission.ToolTierMap.shipped();
        var ledger = dev.spectroscope.core.permission.AllowlistMigration.defaultLedger();
        for (java.nio.file.Path file : dev.spectroscope.core.permission.AllowlistMigration
                .settingsChain(projectDir, workspace)) {
            dev.spectroscope.core.permission.AllowlistMigration.migrateFileOnce(file, tiers, ledger);
        }
    }

    /** Card 199: the gate audit sidecar of this session, or a throwaway one when
     *  no store exists yet (a decision without a session still gets recorded, it
     *  simply lands in the sessionless file rather than a named one). */
    private dev.spectroscope.core.permission.GateAudit gateAudit() {
        return dev.spectroscope.core.permission.GateAudit.forSession(
                store != null ? store.id() : "sessionless");
    }

    /**
     * Serialize a RunEvent and push it out.
     *
     * @param event the event to serialize; dropped silently when the socket is gone
     */
    private synchronized void send(RunEvent event) {
        // A dead socket is not a run failure — the JSONL file already has it.
        sendFrame(event);
    }

    /**
     * The ONE transport line for this socket — every frame sender goes through
     * here (finding 9 of the 2026-08-14 review: this exact guard + serialize +
     * swallow triple existed ten times, and ten copies of a transport line are
     * ten places for the next fix to miss). Callers keep their own
     * preconditions, payload shapes and monitor ({@code synchronized}) — this
     * is only the last line, shared.
     *
     * @param payload the frame object; serialized by the connection's mapper
     * @return true when the frame left the socket — senders that latch state on
     *         a successful announcement (workspace_info) key on this
     */
    private boolean sendFrame(Object payload) {
        if (!socket.isOpen()) {
            return false;
        }
        try {
            socket.sendMessage(new TextMessage(mapper.writeValueAsString(payload)));
            return true;
        } catch (Exception ignored) {
            // A dead socket never fails the caller: every frame's durable copy
            // (the JSONL, a sidecar) or its next resend covers the loss.
            return false;
        }
    }

    /**
     * Resolves a workspace AND records it as this session's, the single door,
     * so the REST side can never be blind to a folder the agent is already
     * working in. Every resolve site goes through here for exactly that reason:
     * "resolved" and "known to /api/files" must not be two facts that drift.
     *
     * @param picked the pinned or configured path, or null for the temp folder
     * @param sessionId the session the workspace belongs to
     * @return the resolved, existing workspace directory
     */
    private static Path resolveAndRecord(String picked, String sessionId) {
        Path resolved = WorkspaceResolver.resolve(picked, sessionId);
        SessionWorkspaces.resolved(sessionId, resolved.toString());
        return resolved;
    }

    /** Whether the workspace_info frame already went out on this connection. */
    private boolean workspaceAnnounced = false;

    /**
     * The PROSPECTIVE workspace: what a run started right now would use, sent on
     * connect so the Files tab can say "no folder yet" instead of falling back to
     * a sessionless listing of the server's own working directory.
     *
     * <p>Computed with {@link WorkspaceResolver#locate} and nothing else. The
     * eager alternative was tried and reverted: {@code resolve()} CREATES the
     * directory and {@code ensureStore()} mints a session id and a JSONL store,
     * so every tab opened and closed would leave a folder and a session row
     * behind, for a choice the operator can still change. Naming is free;
     * creating is a decision that belongs to the first run.</p>
     *
     * <p>The mode mirrors what {@code buildAgentOnce} will actually do
     * ({@code pinned != null ? pinned : config.workspace()}), so the chooser can
     * pre-select the mode in effect instead of hardcoding one.</p>
     */
    private synchronized void sendProspectiveWorkspace() {
        if (!socket.isOpen()) {
            return;
        }
        String configured = config.workspace();
        boolean hasConfigured = configured != null && !configured.isBlank();
        Map<String, Object> frame = new java.util.LinkedHashMap<>();
        frame.put("type", "workspace_info");
        frame.put("resolved", false);
        frame.put("mode", hasConfigured ? "default" : "random");
        frame.put("configured", hasConfigured);
        if (hasConfigured) {
            // locate() needs no session id once a workspace is configured, and
            // it creates nothing, the read-only twin of resolve().
            Path named = WorkspaceResolver.locate(configured, null);
            frame.put("path", named.toString());
            frame.put("exists", Files.isDirectory(named));
        }
        // No path for "random": the folder is keyed by a session id that does
        // not exist yet, and inventing one would mint the session.
        // A dead socket just misses the hint, the pane stays on its
        // pending state until the first run announces for real.
        sendFrame(frame);
    }

    /**
     * Tells the client where THIS session's agent works — a socket-only UI
     * frame, never appended to the JSONL (the store writes run events only;
     * clients ignore unknown types per forward compatibility, and the trace
     * tab shows the frame). Sent once, after the workspace is resolved; the
     * Files tab then queries {@code GET /api/files?session=<id>}.
     *
     * <p>Carries {@code resolved: true} to separate it from the connect-time
     * proposal, which names a folder that may not exist for a session that does
     * not exist yet. The pane draws a tree for one and a waiting state for the
     * other, and cannot tell them apart without being told.</p>
     */
    /**
     * The operator states (or clears) this session's goal (card 267,
     * criterion 1).
     *
     * <p>The OPERATOR, and never the model: there is no goal tool anywhere in
     * the registry, because a model-written goal is a run defining its own
     * success and {@code konzept/PROMPT-ORCHESTRATION.md} §3 rule 2 already
     * refuses a model-written definition that out-grants its author's session.
     * This frame comes from a browser a person is sitting at.</p>
     *
     * <p>It is written to disk in the same breath, so it survives the socket and
     * a person can open it in an editor. Stating a goal grants nothing: no tool
     * appears, no tier moves, and the check itself asks the same gate any other
     * command asks before it runs.</p>
     *
     * @param outcome what the run is for; blank clears the goal entirely
     * @param check   the command whose exit code decides it; blank means the run
     *                will be reported untested rather than met
     */
    void onSetGoal(String outcome, String check) {
        // The store mints the id the goal file is named after, and a goal may
        // be stated before the first prompt has built an agent.
        ensureStore();
        dev.spectroscope.core.goal.RunGoal stated =
                outcome == null || outcome.isBlank()
                        ? null
                        : new dev.spectroscope.core.goal.RunGoal(outcome,
                                check == null || check.isBlank() ? null : check);
        if (goal != null) {
            goal.state(stated);
        }
        try {
            dev.spectroscope.core.goal.GoalStore.write(
                    dev.spectroscope.core.goal.GoalStore.fileFor(store.id()), stated);
        } catch (java.io.IOException unwritable) {
            log.warn("could not write the goal file: {}", unwritable.getMessage());
        }
        sendGoalInfo();
    }

    /**
     * Tells the page what this session is for — the "shown where the run is
     * watched" half of criterion 1.
     *
     * <p>A socket frame and deliberately NOT a {@link RunEvent}: the wire union
     * is the session's HISTORY, and the goal in force is a property of the
     * session right now. What DOES belong in the history is the check's verdict,
     * and that travels as {@code goal_check} from the loop itself.</p>
     */
    synchronized void sendGoalInfo() {
        if (!socket.isOpen() || store == null) {
            return;
        }
        dev.spectroscope.core.goal.RunGoal stated = goal == null ? null : goal.stated();
        Map<String, Object> frame = new java.util.HashMap<>();
        frame.put("type", "goal_info");
        frame.put("sessionId", store.id());
        frame.put("stated", stated != null);
        frame.put("outcome", stated == null ? "" : stated.outcome());
        frame.put("check", stated == null || !stated.hasCheck() ? "" : stated.check());
        frame.put("file", dev.spectroscope.core.goal.GoalStore.fileFor(store.id()).toString());
        sendFrame(frame);
    }

    private synchronized void sendWorkspaceInfo() {
        if (workspaceAnnounced || workspace == null || !socket.isOpen()) {
            return;
        }
        String pinned = SessionWorkspaces.pinned(store.id());
        boolean configured = pinned != null || config.workspace() != null;
        // A dead socket just misses the hint, the Files tab stays on its
        // waiting state until the next announcement — announced latches only
        // on a frame that actually left, exactly as before.
        if (sendFrame(Map.of(
                "type", "workspace_info",
                "resolved", true,
                "mode", pinned != null ? "set" : (config.workspace() != null ? "default" : "random"),
                "exists", Files.isDirectory(workspace),
                "sessionId", store.id(),
                "path", workspace.toString(),
                "configured", configured))) {
            workspaceAnnounced = true;
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
        // A dead socket just misses the hint — the next frame retries nothing.
        sendFrame(Map.of(
                "type", "provider_info",
                "provider", active.provider(),
                "model", active.model(),
                "host", active.providerHost()));
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
        // A dead socket just misses the hint — the next frame retries nothing.
        sendFrame(Map.of(
                "type", "permission_mode_info",
                "mode", permissionMode == null ? "ask" : permissionMode));
    }

    /**
     * Queues one live-set snapshot for this connection without ever blocking the
     * registry. Latest-wins: a snapshot is the whole truth, so a stale one
     * waiting in the queue is simply replaced. Producers are serialised by the
     * registry's monitor, so the drop-then-offer runs at most once.
     *
     * @param live the snapshot the registry just published
     */
    private void offerLive(List<LiveSessions.LiveSession> live) {
        while (!liveQueue.offer(live)) {
            liveQueue.poll();
        }
    }

    /** Drains the live-set queue on this connection's own thread until
     *  interrupted (onClose) — the only place a live_sessions frame touches
     *  the blocking socket. */
    private void drainLive() {
        try {
            while (true) {
                sendLiveSessions(liveQueue.take());
            }
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt(); // the connection is closing — done
        }
    }

    /**
     * Tells the client WHICH sessions are live on this server — the card-212
     * frame, socket-only and additive, never appended to the JSONL. The
     * RunEvent wire is byte-frozen, so nothing existing carries this: it is a
     * new type next to {@code provider_info} and {@code workspace_info}, and a
     * client that has never heard of it drops it through the reducer's default.
     *
     * <p>Sent on connect and again on every change. The REST twin,
     * {@code GET /api/sessions/live}, serves the same list to a client that
     * missed a push or holds no socket at all.</p>
     *
     * @param live every live session, as the registry ordered them
     */
    private synchronized void sendLiveSessions(List<LiveSessions.LiveSession> live) {
        if (!socket.isOpen()) {
            return;
        }
        // A dead socket just misses this snapshot; the next change resends
        // the whole set, so nothing has to be replayed.
        sendFrame(Map.of(
                "type", "live_sessions",
                "sessions", live,
                "ts", System.currentTimeMillis()));
    }

    /**
     * Tells a refused connection WHICH session it may not have — socket-only
     * and additive, like the frame above. Deliberately not an
     * {@code ErrorEvent}: the client words this one itself, in the reader's
     * language, and it also has to act on it (drop the resume, so a retrying
     * socket does not hammer a session it will keep being refused).
     *
     * @param sessionId the session another socket is driving
     */
    private synchronized void sendSessionBusy(String sessionId) {
        if (!socket.isOpen()) {
            return;
        }
        // The socket is closing anyway — the refusal stands either way.
        sendFrame(Map.of(
                "type", "session_busy",
                "sessionId", sessionId));
    }

    /**
     * Queues a fleet frame for this connection, NEVER blocking the caller: the
     * listener runs on the hub's reader/tap threads, so a blocking socket write
     * here would stall a joining node and every other browser. On overflow the
     * OLDEST pending frame is dropped, not the newest — a roster is latest-wins,
     * and a dropped event is logged, never silent. The node's own session JSONL
     * remains the durable copy of every event regardless.
     */
    private void offerFleet(FleetFrame frame) {
        if (fleetQueue.offer(frame)) {
            return;
        }
        FleetFrame dropped = fleetQueue.poll();
        log.warn("fleet frame dropped for a slow socket: {}",
                dropped == null ? "?" : dropped.getClass().getSimpleName());
        fleetQueue.offer(frame);
    }

    /** Drains the fleet queue on this connection's own thread until interrupted
     *  (onClose) — the only place fleet frames touch the blocking socket. */
    private void drainFleet() {
        try {
            while (true) {
                sendFleet(fleetQueue.take());
            }
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt(); // the connection is closing — done
        }
    }

    /**
     * Serializes and sends ONE fleet frame as a socket-only UI frame, never
     * appended to this session's JSONL. Runs on the fleet drain thread and, like
     * every other send, holds the connection monitor so it never interleaves
     * with a concurrent run-event write. A roster mirrors {@code provider_info}
     * (full latest state); an event rides in its canonical line form — the one
     * serialization the wire, the JSONL import and this frame all share.
     */
    private synchronized void sendFleet(FleetFrame frame) {
        if (!socket.isOpen()) {
            return;
        }
        try {
            Map<String, Object> payload = switch (frame) {
                case FleetRosterFrame roster -> Map.of(
                        "type", "fleet_roster",
                        "nodes", roster.roster().stream().map(FleetAggregator::nodeJson).toList());
                case FleetEventFrame event -> Map.of(
                        "type", "fleet_event",
                        "frame", mapper.readTree(event.envelope().toLine(mapper)));
            };
            sendFrame(payload);
        } catch (Exception ignored) {
            // An unparseable envelope just misses the hint — the next frame retries nothing.
        }
    }

    /**
     * Mirrors one OTLP export outcome as a socket-only UI frame (card 86) —
     * never appended to the JSONL, never carrying auth. The trace tab shows
     * the frame behind its default-off "otel" toggle; export failures also
     * stay visible in the doctor line as before. Runs on the sink's export
     * virtual thread and holds the connection monitor like every send.
     */
    /** Above this, the frame carries span names instead of the full payload —
     *  a whole-session re-export can reach megabytes, the socket must not. */
    private static final int OTLP_FRAME_BODY_CAP_BYTES = 64 * 1024;

    private synchronized void sendOtlpExport(OtlpSink.ExportReport report) {
        if (!socket.isOpen()) {
            return;
        }
        try {
            Map<String, Object> payload = new java.util.LinkedHashMap<>();
            payload.put("type", "otlp_export");
            payload.put("endpoint", report.endpoint());
            payload.put("spans", report.spans());
            payload.put("bytes", report.bytes());
            payload.put("ok", report.ok());
            if (report.message() != null) {
                payload.put("message", report.message());
            }
            // The content itself (owner): the full OTLP batch as a navigable
            // tree while it fits, else the span names + an honest omission note.
            if (report.body() != null) {
                if (report.bytes() <= OTLP_FRAME_BODY_CAP_BYTES) {
                    payload.put("export", mapper.readTree(report.body()));
                } else {
                    payload.put("exportOmitted",
                            "payload " + report.bytes() + " bytes — span names only");
                    payload.put("spanNames", spanNames(report.body()));
                }
            }
            payload.put("ts", report.ts());
            sendFrame(payload);
        } catch (Exception ignored) {
            // An unparseable body just misses the mirror — the export itself already ran.
        }
    }

    /**
     * Mirrors one finished backend exchange (card 184) as a socket-only UI
     * frame like {@code provider_info}, never appended to the JSONL. Metadata
     * only, exactly the recorder's {@code ExchangeMeta}: the sidecar file under
     * {@code ~/.spectro/llm-wire/} keeps the bodies, and the read endpoints
     * serve them on demand. Runs on the exchange's closing thread and holds
     * the connection monitor like every send.
     */
    /**
     * Mirrors ONE request the moment it leaves, before the provider has answered
     * anything (card 184 leg 2). Without this the socket heard about an exchange
     * only at close, so a call in flight was invisible and the finished row
     * landed after its own text deltas: measured on a real turn, the POST left
     * at 48.291, the first token arrived at 50.035, the stream closed at 50.138,
     * and only the last of those was ever on screen.
     *
     * <p>No status, no duration, no response size: those facts do not exist yet
     * and a zero would be a claim. The bodies stay in the sidecar as always.</p>
     */
    private synchronized void sendLlmRequest(LlmWireRecorder.RequestMeta meta) {
        if (!socket.isOpen()) {
            return;
        }
        try {
            Map<String, Object> payload = new java.util.LinkedHashMap<>();
            payload.put("type", "llm_request");
            payload.put("xid", meta.xid());
            payload.put("agentId", meta.agentId());
            payload.put("turn", meta.turn());
            payload.put("kind", meta.kind());
            payload.put("provider", meta.provider());
            payload.put("model", meta.model());
            payload.put("transport", meta.transport());
            payload.put("method", meta.method());
            payload.put("url", meta.url());
            payload.put("requestBytes", meta.requestBytes());
            payload.put("fidelity", meta.fidelity());
            payload.put("ts", meta.ts());
            sendFrame(payload);
        } catch (Exception ignored) {
            // A dead socket just misses the mirror; the sidecar already has it.
        }
    }

    /**
     * A finished exchange becomes a line of the SESSION, not only a frame on the
     * socket (card 184 leg 3).
     *
     * <p>It used to be socket-only, and that cost exactly what socket-only always
     * costs: reopening a stored session lost the fact that any model call had
     * happened, and the spectrum's second line per agent could only exist while
     * somebody was watching. Now it is a {@link RunEvent} like every other, so it
     * takes the ordinary road — appended to the file first, mirrored to the
     * socket second, in that order, because a dead socket must never cost the
     * record.</p>
     *
     * <p>Bodies still do not travel: they stay in the sidecar and the gated
     * endpoint serves them on the gesture that asks.</p>
     *
     * @param meta the closed exchange, every field measured by the recorder
     */
    private synchronized void sendLlmExchange(LlmWireRecorder.ExchangeMeta meta) {
        RunEvent.LlmExchange event = new RunEvent.LlmExchange(
                meta.xid(), meta.agentId(), meta.turn(), meta.kind(),
                meta.provider(), meta.model(), meta.transport(), meta.url(),
                meta.status(), meta.requestBytes(), meta.responseBytes(),
                meta.responseLines(), meta.aborted(), meta.fidelity(),
                meta.durationMs(), meta.ts());
        // The file first. A session whose socket died mid-run still has to be
        // able to say what it spent.
        if (store != null) {
            try {
                store.append(event);
            } catch (RuntimeException unwritable) {
                // The sidecar still holds the exchange; losing the mirror line is
                // not worth losing the run.
            }
        }
        send(event);
    }

    /** The span names of an OTLP batch, bounded — the over-cap frame's summary. */
    private List<String> spanNames(String body) {
        List<String> names = new ArrayList<>();
        try {
            JsonNode spans = mapper.readTree(body).path("resourceSpans").path(0)
                    .path("scopeSpans").path(0).path("spans");
            for (JsonNode span : spans) {
                if (names.size() >= 100) {
                    names.add("… +" + (spans.size() - 100) + " more");
                    break;
                }
                names.add(span.path("name").asText());
            }
        } catch (Exception unparsable) {
            names.add("(unparsable payload)");
        }
        return names;
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
        // Card 265: and every parked QUESTION — released as cancelled, never as
        // an answer. A denial is a verdict a gate can honestly report; a question
        // has no such verdict, and one invented answer in a JSONL is permanent.
        asker.releaseAllPending();
    }
}
