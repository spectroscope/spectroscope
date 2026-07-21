package dev.spectroscope.orchestrator;

import dev.spectroscope.FleetLane;
import dev.spectroscope.FleetPanel;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.trace.TracingPort;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The fleet behind {@link dev.spectroscope.Spectro#panel()}: every lane is a
 * full core agent on its own virtual thread, every event of every lane rides
 * the bus as a {@link BusEnvelope}, and the panel's {@link EventStream} is the
 * aggregator — ONE subscriber draining the fleet's topic into one spectrum.
 *
 * <p>The A2A-lite choreography mirrors the core's SubagentManager: the panel
 * announces each lane with {@code agent_spawn} + a {@code task/submitted}
 * message, the lane reports {@code status/working} when it starts, and every
 * lane ends in a {@code result/completed|failed} message before the panel's
 * own {@code run_end} closes the stream. The Spectrum tab folds exactly this
 * vocabulary into its lanes.</p>
 */
public final class OrchestratorPanel implements FleetPanel {

    /** The panel's own agent id on the stream — the fleet's conductor. */
    public static final String PANEL_AGENT_ID = "panel";

    /** Wire lines a hub-mirror connection may buffer (mirrors the node default). */
    private static final int OUTBOX = 1024;

    /** The embedded-library stance, fleet edition. */
    private static final String UNATTENDED_PROMPT =
            "You are one lane of a spectroscope fleet. There is no human at the "
            + "terminal: carry out your assignment with the available tools and "
            + "summarize your result briefly at the end. If a tool is denied, do "
            + "not retry it — state the denial in your result.";

    private final BusTransport bus; // the LOCAL SPINE — the returned stream rides this, always
    private final boolean ownsBus;
    /** The fleet hub, or null = in-memory only (today's behaviour). When set,
     *  each sender ALSO mirrors its frames to the hub as an additive side
     *  channel; the returned stream never depends on hub liveness. */
    private final HubAddress hub;
    private final Map<String, Lane> lanes = new LinkedHashMap<>();
    private LlmProvider defaultProvider;
    private Path workspaceRoot = Path.of(".");
    private boolean started = false;

    /** The facade path: a private in-memory bus per panel run. Env-aware — when
     *  {@code SPECTRO_HUB} is set, the run ALSO mirrors to that fleet hub so
     *  {@link dev.spectroscope.Spectro#panel()} code fleets are live-visible.
     *  Note the ambient coupling: a process with {@code SPECTRO_HUB} exported
     *  makes EVERY {@code Spectro.panel()} run open a mirror connection. The
     *  returned stream is unaffected either way (it rides the in-memory spine),
     *  but a dead hub means best-effort mirror drops, not a broken run. */
    public OrchestratorPanel() {
        this(new InMemoryBus(), true, HubAddress.fromEnv(System.getenv()));
    }

    /** Test/aggregator seam: run this panel over a caller-supplied transport.
     *  The caller keeps ownership — the panel never closes a bus it did not
     *  create (a shared aggregator or process transport outlives one run). This
     *  seam is NEVER env-teed: a caller who passes a bus means "use exactly
     *  this transport", no SPECTRO_HUB hijack.
     *  @param bus the transport every envelope of this panel rides */
    public OrchestratorPanel(BusTransport bus) {
        this(bus, false, null);
    }

    /** Explicit hub target: run over a private in-memory spine AND mirror every
     *  frame to the fleet hub at {@code hub}, without relying on
     *  {@code SPECTRO_HUB}. The additive counterpart to the env-first facade
     *  path — for a program that wants to point a panel at a hub in code, and
     *  the seam tests use to force the hub path deterministically.
     *  @param hub the fleet hub to mirror to (never null here; use the no-arg
     *             or {@link #OrchestratorPanel(BusTransport)} form for no hub) */
    public OrchestratorPanel(HubAddress hub) {
        this(new InMemoryBus(), true, Objects.requireNonNull(hub, "hub"));
    }

    private OrchestratorPanel(BusTransport bus, boolean ownsBus, HubAddress hub) {
        this.bus = Objects.requireNonNull(bus, "bus");
        this.ownsBus = ownsBus;
        this.hub = hub;
    }

    @Override
    public FleetPanel model(LlmProvider provider) {
        mutable();
        this.defaultProvider = Objects.requireNonNull(provider, "provider");
        return this;
    }

    @Override
    public FleetPanel workspace(Path root) {
        mutable();
        this.workspaceRoot = Objects.requireNonNull(root, "workspace");
        return this;
    }

    @Override
    public FleetLane agent(String agentId) {
        mutable();
        Objects.requireNonNull(agentId, "agentId");
        if (agentId.isBlank() || agentId.equals(PANEL_AGENT_ID)) {
            throw new IllegalArgumentException("lane id must be non-blank and not '" + PANEL_AGENT_ID + "'");
        }
        return lanes.computeIfAbsent(agentId, Lane::new);
    }

    @Override
    public EventStream run() {
        mutable();
        if (lanes.isEmpty()) {
            throw new IllegalStateException("an empty panel has nothing to run — add .agent(id).task(...) first");
        }
        for (Lane lane : lanes.values()) {
            if (lane.task == null || lane.task.isBlank()) {
                throw new IllegalStateException("lane '" + lane.id + "' has no task — call .task(...)");
            }
            if (lane.provider == null && defaultProvider == null) {
                throw new IllegalStateException(
                        "lane '" + lane.id + "' has no model — set one on the lane or on the panel");
            }
            // A lane id becomes a hub NodeCard id + a REST path segment when a
            // hub is configured; validate up front on BOTH paths so a bad id
            // fails fast and legibly here, not as a cryptic mid-run NodeCard
            // throw that only surfaces with a hub set.
            if (!lane.id.matches("[A-Za-z0-9._-]+") || lane.id.equals(".") || lane.id.equals("..")) {
                throw new IllegalArgumentException(
                        "lane id must be URL-safe [A-Za-z0-9._-] and not \".\"/\"..\", was: \"" + lane.id + "\"");
            }
        }
        started = true;

        String contextId = "fleet-" + UUID.randomUUID().toString().substring(0, 8);
        String topic = BusEnvelope.topicFor(contextId);
        long t0 = System.currentTimeMillis();
        CancelSignal signal = new CancelSignal();

        return EventStream.start(signal, sink -> {
            // The aggregator: ONE subscriber unwraps the fleet's envelopes into
            // the merged stream, in publication order (per lane: causal order).
            // It subscribes to the LOCAL SPINE — the returned stream never
            // touches the hub, so a dead hub cannot stall or drop it.
            AutoCloseable subscription = bus.subscribe(topic, env -> sink.accept(env.payload()));
            EnvelopeStamper panelPen = new EnvelopeStamper(PANEL_AGENT_ID, 0L, contextId, topic);
            // The conductor's hub-mirror connection (only when a hub is set): its
            // own card so the aggregator taps the topic, its own async pen so a
            // slow hub only drops-with-a-count, never blocks the run thread.
            ProcessBus conductorBus = null;
            AsyncBusPort conductorHub = null;
            if (hub != null) {
                NodeCard panelCard = new NodeCard(PANEL_AGENT_ID, "conductor", List.of(), topic);
                conductorBus = new ProcessBus(hub.host(), hub.port(), PANEL_AGENT_ID, OUTBOX, panelCard);
                conductorHub = new AsyncBusPort(new BusPublisher(conductorBus, PANEL_AGENT_ID, contextId), OUTBOX);
            }
            final TracingPort conductorOut = conductorHub;
            try {
                publishConductor(panelPen, contextId, conductorOut, new RunEvent.RunStart(
                        contextId, PANEL_AGENT_ID, null,
                        "fleet of " + lanes.size() + " agents", "fleet", null, t0));

                List<Thread> threads = new ArrayList<>();
                for (Lane lane : lanes.values()) {
                    String taskId = "task-" + UUID.randomUUID().toString().substring(0, 8);
                    // The panel announces the lane BEFORE it starts: the tree
                    // edge, then the visible assignment (A2A task message).
                    publishConductor(panelPen, taskId, conductorOut, new RunEvent.AgentSpawn(
                            lane.id, PANEL_AGENT_ID, lane.task, System.currentTimeMillis()));
                    publishConductor(panelPen, taskId, conductorOut, new RunEvent.AgentMessage(
                            PANEL_AGENT_ID, lane.id, "task", "submitted", lane.task, null,
                            System.currentTimeMillis()));
                    CancelSignal laneSignal = new CancelSignal();
                    signal.onCancel(laneSignal::cancel);
                    threads.add(Thread.ofVirtual()
                            .name("spectro-lane-" + lane.id)
                            .start(() -> runLane(lane, taskId, contextId, topic, laneSignal)));
                }
                for (Thread thread : threads) {
                    thread.join();
                }
                publishConductor(panelPen, contextId, conductorOut, new RunEvent.RunEnd(
                        contextId, signal.isCancelled() ? "aborted" : "end_turn",
                        System.currentTimeMillis()));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                publishConductor(panelPen, contextId, conductorOut, new RunEvent.RunEnd(
                        contextId, "aborted", System.currentTimeMillis()));
            } finally {
                // The conductor's hub teardown is best-effort and OFF the spine's
                // critical path (same reason as the lanes): a slow/dead hub must
                // not delay the returned stream's completion. Detach it.
                closeMirrorDetached("spectro-fleet-close-panel", conductorHub, conductorBus);
                try {
                    subscription.close();
                } catch (Exception ignored) {
                    // an in-memory unsubscribe cannot fail meaningfully
                }
                if (ownsBus) {
                    bus.close();
                }
            }
        });
    }

    /** One lane, one virtual thread: announce work, pump the agent's stream
     *  onto the bus verbatim, close with the recorded outcome. Never throws —
     *  a broken lane becomes an error event plus a failed result. */
    private void runLane(Lane lane, String taskId, String contextId, String topic, CancelSignal signal) {
        // The SPINE pen — shared across choreography frames and pumped events so
        // they stay ONE causal chain, stamped only on THIS lane thread.
        EnvelopeStamper spinePen = new EnvelopeStamper(lane.id, 0L, contextId, topic);
        TracingPort spineOut = new BusPublisher(bus, spinePen, taskId);
        ProcessBus laneBus = null;
        AsyncBusPort laneHub = null;
        AtomicBoolean sawError = new AtomicBoolean(false);
        String[] stopReason = {null};
        try {
            // Fan-out at the source: the spine synchronously FIRST (the returned
            // stream), then the hub mirror (its own card + its OWN async pen,
            // stamped only on the AsyncBusPort drain thread) SECOND. A dead hub
            // can only fill the bounded queue and drop-count — never delay or
            // drop a spine frame.
            final TracingPort out;
            if (hub != null) {
                NodeCard card = new NodeCard(lane.id, "worker",
                        laneTools(lane).stream().map(Tool::name).toList(), topic);
                laneBus = new ProcessBus(hub.host(), hub.port(), lane.id, OUTBOX, card);
                laneHub = new AsyncBusPort(new BusPublisher(laneBus, lane.id, contextId), OUTBOX);
                final AsyncBusPort hubOut = laneHub;
                out = event -> {
                    spineOut.onEvent(event);
                    hubOut.onEvent(event);
                };
            } else {
                out = spineOut;
            }

            out.onEvent(new RunEvent.AgentMessage(
                    lane.id, PANEL_AGENT_ID, "status", "working", "lane started",
                    null, System.currentTimeMillis()));
            try {
                dev.spectroscope.core.Agent agent = buildAgent(lane);
                try (EventStream stream = agent.run(lane.task, new RunOptions(signal, null))) {
                    for (RunEvent event : stream) {
                        if (event instanceof RunEvent.ErrorEvent) {
                            sawError.set(true);
                        }
                        if (event instanceof RunEvent.ToolResult result && result.isError()) {
                            sawError.set(true);
                        }
                        if (event instanceof RunEvent.RunEnd end) {
                            stopReason[0] = end.stopReason();
                        }
                        out.onEvent(event);
                    }
                }
            } catch (RuntimeException broken) {
                sawError.set(true);
                out.onEvent(new RunEvent.ErrorEvent(
                        lane.id, "lane failed: " + broken.getMessage(), System.currentTimeMillis()));
            }
            boolean failed = sawError.get() || !"end_turn".equals(stopReason[0]);
            out.onEvent(new RunEvent.AgentMessage(
                    lane.id, PANEL_AGENT_ID, "result", failed ? "failed" : "completed",
                    failed ? "failed (" + (stopReason[0] == null ? "no run_end" : stopReason[0]) + ")"
                           : "completed",
                    null, System.currentTimeMillis()));
        } finally {
            // The hub teardown must NEVER gate the spine: ProcessBus.close()
            // blocks up to its drain-grace waiting for acks, so a dead/slow hub
            // would otherwise delay THIS lane thread's termination — which the
            // conductor joins BEFORE it publishes the terminal run_end. Close
            // the run-private mirror connections on a detached best-effort thread
            // so the returned stream's completion is never gated on hub liveness.
            closeMirrorDetached("spectro-fleet-close-" + lane.id, laneHub, laneBus);
        }
    }

    /** Close a sender's mirror connections OFF the run's critical path: drain
     *  the async port into the still-open bus (fast), then drain the bus outbox
     *  to the hub (up to its grace, best-effort) — all on a detached thread so a
     *  slow/dead hub can never delay the returned spine stream. No-op when both
     *  are null (the in-memory path). */
    private static void closeMirrorDetached(String name, AutoCloseable port, AutoCloseable transport) {
        if (port == null && transport == null) {
            return;
        }
        Thread.ofVirtual().name(name).start(() -> {
            closeQuietly(port);      // drains the queue into the still-open bus (fast)
            closeQuietly(transport); // drains the outbox to the hub (grace-bounded, OFF-path)
        });
    }

    /** Publish a conductor frame: the spine (as today), then the hub mirror
     *  (non-blocking) when a hub is configured. */
    private void publishConductor(EnvelopeStamper spinePen, String taskId,
                                  TracingPort hubPortOrNull, RunEvent event) {
        bus.publish(spinePen.stamp(taskId, event));
        if (hubPortOrNull != null) {
            hubPortOrNull.onEvent(event);
        }
    }

    /** The lane's tools — its own set, or the full registry. The ONE source for
     *  both the advertised card capabilities and the real registry, so the
     *  announced blast radius can never drift from what the lane can actually do. */
    private List<Tool> laneTools(Lane lane) {
        return lane.tools != null ? lane.tools : dev.spectroscope.Tools.all();
    }

    private static void closeQuietly(AutoCloseable closeable) {
        if (closeable == null) {
            return;
        }
        try {
            closeable.close();
        } catch (Exception ignored) {
            // best-effort teardown — a close failure must not mask the run result
        }
    }

    /** Builds the lane's core agent — the same construction path as the
     *  single-agent facade, with the lane's fleet identity stamped on. */
    private dev.spectroscope.core.Agent buildAgent(Lane lane) {
        Path workspace = lane.workspace != null ? lane.workspace : workspaceRoot.resolve(lane.id);
        try {
            Files.createDirectories(workspace);
        } catch (IOException e) {
            throw new IllegalStateException("workspace not creatable: " + workspace, e);
        }
        ToolRegistry registry = new ToolRegistry();
        laneTools(lane).forEach(registry::register);
        LlmProvider provider = lane.provider != null ? lane.provider : defaultProvider;
        String prompt = lane.systemPrompt != null
                ? lane.systemPrompt
                : UNATTENDED_PROMPT + "\nYour lane is " + lane.id + ". The workspace is " + workspace + ".";
        return new dev.spectroscope.core.Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt(prompt)
                .registry(registry)
                .cwd(workspace)
                // Unattended stance: fleet lanes run without a human at the
                // gate, so every request is approved HERE — but the gate path
                // still runs: the core emits permission_request AND
                // permission_decision for each call, so every auto-approval
                // is on the record in the merged stream. Scope a lane's blast
                // radius via lane.tools (the registry is the real control).
                .onPermission(request -> true)
                .agentId(lane.id)
                .parentId(PANEL_AGENT_ID)
                .providerName(providerLabel(provider))
                .build());
    }

    /** run_start's provider field must carry a name, not null (facade rule). */
    private static String providerLabel(LlmProvider provider) {
        String live = provider.providerName();
        if (live != null && !live.isBlank()) {
            return live;
        }
        String simple = provider.getClass().getSimpleName();
        if (simple.isBlank() || simple.contains("$") || simple.contains("Lambda")) {
            return "custom";
        }
        return simple.replaceAll("Provider$", "").toLowerCase();
    }

    private void mutable() {
        if (started) {
            throw new IllegalStateException("the panel is already running — configure before run()");
        }
    }

    /** One lane's configuration — the fluent surface of {@link FleetLane}. */
    private final class Lane implements FleetLane {
        private final String id;
        private LlmProvider provider;
        private List<Tool> tools;
        private Path workspace;
        private String systemPrompt;
        private String task;

        private Lane(String id) {
            this.id = id;
        }

        @Override
        public FleetLane model(LlmProvider provider) {
            mutable();
            this.provider = Objects.requireNonNull(provider, "provider");
            return this;
        }

        @Override
        public FleetLane tools(Tool... tools) {
            mutable();
            this.tools = List.of(tools);
            return this;
        }

        @Override
        public FleetLane workspace(Path workspace) {
            mutable();
            this.workspace = Objects.requireNonNull(workspace, "workspace");
            return this;
        }

        @Override
        public FleetLane systemPrompt(String systemPrompt) {
            mutable();
            this.systemPrompt = Objects.requireNonNull(systemPrompt, "systemPrompt");
            return this;
        }

        @Override
        public FleetLane task(String task) {
            mutable();
            this.task = Objects.requireNonNull(task, "task");
            return this;
        }
    }
}
