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

    /** The embedded-library stance, fleet edition. */
    private static final String UNATTENDED_PROMPT =
            "You are one lane of a spectroscope fleet. There is no human at the "
            + "terminal: carry out your assignment with the available tools and "
            + "summarize your result briefly at the end. If a tool is denied, do "
            + "not retry it — state the denial in your result.";

    private final BusTransport bus;
    private final boolean ownsBus;
    private final Map<String, Lane> lanes = new LinkedHashMap<>();
    private LlmProvider defaultProvider;
    private Path workspaceRoot = Path.of(".");
    private boolean started = false;

    /** The facade path: a private in-memory bus per panel run. */
    public OrchestratorPanel() {
        this(new InMemoryBus(), true);
    }

    /** Test/aggregator seam: run this panel over a caller-supplied transport.
     *  The caller keeps ownership — the panel never closes a bus it did not
     *  create (a shared aggregator or process transport outlives one run).
     *  @param bus the transport every envelope of this panel rides */
    public OrchestratorPanel(BusTransport bus) {
        this(bus, false);
    }

    private OrchestratorPanel(BusTransport bus, boolean ownsBus) {
        this.bus = Objects.requireNonNull(bus, "bus");
        this.ownsBus = ownsBus;
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
        }
        started = true;

        String contextId = "fleet-" + UUID.randomUUID().toString().substring(0, 8);
        String topic = BusEnvelope.topicFor(contextId);
        long t0 = System.currentTimeMillis();
        CancelSignal signal = new CancelSignal();

        return EventStream.start(signal, sink -> {
            // The aggregator: ONE subscriber unwraps the fleet's envelopes into
            // the merged stream, in publication order (per lane: causal order).
            AutoCloseable subscription = bus.subscribe(topic, env -> sink.accept(env.payload()));
            EnvelopeStamper panelPen = new EnvelopeStamper(PANEL_AGENT_ID, 0L, contextId, topic);
            try {
                bus.publish(panelPen.stamp(contextId, new RunEvent.RunStart(
                        contextId, PANEL_AGENT_ID, null,
                        "fleet of " + lanes.size() + " agents", "fleet", null, t0)));

                List<Thread> threads = new ArrayList<>();
                for (Lane lane : lanes.values()) {
                    String taskId = "task-" + UUID.randomUUID().toString().substring(0, 8);
                    // The panel announces the lane BEFORE it starts: the tree
                    // edge, then the visible assignment (A2A task message).
                    bus.publish(panelPen.stamp(taskId, new RunEvent.AgentSpawn(
                            lane.id, PANEL_AGENT_ID, lane.task, System.currentTimeMillis())));
                    bus.publish(panelPen.stamp(taskId, new RunEvent.AgentMessage(
                            PANEL_AGENT_ID, lane.id, "task", "submitted", lane.task, null,
                            System.currentTimeMillis())));
                    CancelSignal laneSignal = new CancelSignal();
                    signal.onCancel(laneSignal::cancel);
                    threads.add(Thread.ofVirtual()
                            .name("spectro-lane-" + lane.id)
                            .start(() -> runLane(lane, taskId, contextId, topic, laneSignal)));
                }
                for (Thread thread : threads) {
                    thread.join();
                }
                bus.publish(panelPen.stamp(contextId, new RunEvent.RunEnd(
                        contextId, signal.isCancelled() ? "aborted" : "end_turn",
                        System.currentTimeMillis())));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                bus.publish(panelPen.stamp(contextId, new RunEvent.RunEnd(
                        contextId, "aborted", System.currentTimeMillis())));
            } finally {
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
        EnvelopeStamper pen = new EnvelopeStamper(lane.id, 0L, contextId, topic);
        // The lane publishes its agent's events through the tracing port —
        // sharing the pen, so choreography frames and pumped events stay ONE
        // causal chain. The core-side drain sites register the same port type.
        BusPublisher publisher = new BusPublisher(bus, pen, taskId);
        AtomicBoolean sawError = new AtomicBoolean(false);
        String[] stopReason = {null};
        bus.publish(pen.stamp(taskId, new RunEvent.AgentMessage(
                lane.id, PANEL_AGENT_ID, "status", "working", "lane started",
                null, System.currentTimeMillis())));
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
                    publisher.onEvent(event);
                }
            }
        } catch (RuntimeException broken) {
            sawError.set(true);
            bus.publish(pen.stamp(taskId, new RunEvent.ErrorEvent(
                    lane.id, "lane failed: " + broken.getMessage(), System.currentTimeMillis())));
        }
        boolean failed = sawError.get() || !"end_turn".equals(stopReason[0]);
        bus.publish(pen.stamp(taskId, new RunEvent.AgentMessage(
                lane.id, PANEL_AGENT_ID, "result", failed ? "failed" : "completed",
                failed ? "failed (" + (stopReason[0] == null ? "no run_end" : stopReason[0]) + ")"
                       : "completed",
                null, System.currentTimeMillis())));
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
        (lane.tools != null ? lane.tools : dev.spectroscope.Tools.all()).forEach(registry::register);
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
