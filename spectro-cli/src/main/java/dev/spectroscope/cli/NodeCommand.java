package dev.spectroscope.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.cli.trace.TracingProvider;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.ProviderFactory;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.WorkspaceResolver;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.scheduler.HeadlessRunner;
import dev.spectroscope.core.scheduler.HeadlessRunners;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.orchestrator.AsyncBusPort;
import dev.spectroscope.orchestrator.BusEnvelope;
import dev.spectroscope.orchestrator.BusPublisher;
import dev.spectroscope.orchestrator.NodeCard;
import dev.spectroscope.orchestrator.ProcessBus;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;
import picocli.CommandLine.ParentCommand;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.function.Consumer;

/**
 * spectroscope node -p "..." --hub host:port --context fleet-1 [--id node-x] [--role r]
 *
 * <p>Runs one prompt headless as a FLEET NODE: the whole event stream rides
 * the ProcessBus to a hub — behind a bounded queue on its own thread
 * ({@link AsyncBusPort}), registered next to the required JSONL sink. The
 * local session file stays the durability anchor, and a dead or stalled hub
 * never blocks the run: events beyond the buffers are dropped from the BUS
 * VIEW only, counted and warned loudly (at-least-once still holds for
 * everything the outbox accepted). Identity lives at the source: the events
 * themselves, the bus envelopes and the node's {@link NodeCard} (announced
 * on the connection handshake) all carry the same node id.</p>
 *
 * <p>Each process start stamps a fresh wall-clock epoch, so a restarted node
 * is a NEW stream on the bus — delivered, never misread as redelivery. The
 * honest limits: the epoch is trusted from the clock (a backwards clock jump
 * across a restart could reuse one, and that stream would dedup like any
 * replayed epoch), and the epoch protects RESTARTS, not parallel identity —
 * two concurrently RUNNING nodes sharing an {@code --id} are an identity
 * collision regardless of their epochs.</p>
 */
@Command(name = "node",
        description = "Run one prompt as a fleet node (events ride the bus to a hub).")
public final class NodeCommand implements Callable<Integer> {

    /** Unacked frames the node's outbox holds before its publisher blocks. */
    private static final int OUTBOX = 1024;

    @Option(names = {"-p", "--prompt"}, required = true, description = "The task text.")
    String prompt;

    @Option(names = "--hub", paramLabel = "<host:port>",
            description = "The fleet hub address (default: $SPECTRO_HUB).")
    String hub;

    @Option(names = "--id", description = "This node's sender id (default: node-<pid>).")
    String id;

    @Option(names = "--context", required = true,
            description = "The fleet session to join — the bus topic derives from it.")
    String context;

    @Option(names = "--role", defaultValue = "worker",
            description = "The node's role on its card (default: worker).")
    String role;

    @Option(names = "--permissions", defaultValue = "readonly",
            description = "Headless policy: readonly (default), auto, or ask "
                    + "(park each tool for an operator to answer over the hub).")
    String permissions;

    @Option(names = "--max-turns",
            description = "Cancel the run when a turn exceeds this 1-based limit.")
    Integer maxTurns;

    @Option(names = "--verbose", description = "Trace the agent<->provider protocol on stderr (cyan).")
    boolean verbose;

    @Option(names = "--linger",
            description = "Stay a controllable fleet node after the run, until ctl{stop} or SIGTERM.")
    boolean linger;

    @ParentCommand
    private SpectroCli parent;

    /** Global flags (--provider/--model/--base-url) come from the parent command;
     *  standalone construction (tests) falls back to no overrides.
     *
     * @return the flag-derived overrides, or {@link SpectroConfig.Overrides#none()} without a parent
     */
    SpectroConfig.Overrides effectiveOverrides() {
        return parent != null ? parent.cliOverrides() : SpectroConfig.Overrides.none();
    }

    /**
     * The hub address, flag first, then {@code $SPECTRO_HUB}.
     *
     * @return the raw host:port string, or null when neither names a hub
     */
    static String resolveHub(String flag, Map<String, String> env) {
        if (flag != null && !flag.isBlank()) {
            return flag;
        }
        String fromEnv = env.get("SPECTRO_HUB");
        return fromEnv == null || fromEnv.isBlank() ? null : fromEnv;
    }

    /** A parsed host:port pair. */
    record HubAddress(String host, int port) {
    }

    /**
     * Strict host:port — a fleet address typo must fail before the run
     * starts, not as a silent connect-retry loop.
     */
    static HubAddress parseHub(String address) {
        int colon = address.lastIndexOf(':');
        if (colon <= 0 || colon == address.length() - 1) {
            throw new IllegalArgumentException("--hub must be host:port, got \"" + address + "\"");
        }
        String host = address.substring(0, colon);
        if (host.indexOf(':') >= 0 || host.indexOf('[') >= 0 || host.indexOf(']') >= 0) {
            // "::1" would split into host ":" and "[::1]:7000" into an
            // unresolvable bracket name — refuse loudly instead of dialing junk.
            throw new IllegalArgumentException(
                    "--hub must be an IPv4/hostname host:port (IPv6 literals are not"
                            + " supported yet), got \"" + address + "\"");
        }
        int port;
        try {
            port = Integer.parseInt(address.substring(colon + 1));
        } catch (NumberFormatException notANumber) {
            throw new IllegalArgumentException("--hub port must be a number, got \"" + address + "\"");
        }
        if (port < 1 || port > 65_535) {
            throw new IllegalArgumentException("--hub port out of range: " + port);
        }
        return new HubAddress(host, port);
    }

    /**
     * Everything one node run needs — the parameter object the command builds
     * from its flags, and the tests (in-process and child-JVM proof) build
     * directly to drive the very same path.
     */
    record NodeSpec(String hubHost, int hubPort, String nodeId, long epoch, String contextId,
                    String role, String prompt, Path workspace, boolean autoApprove,
                    Integer maxTurns) {
    }

    /**
     * Single-shot node run: connect, run once, exit. The frozen contract —
     * every existing caller and test lands here.
     *
     * @param providerOverride a pre-built (scripted or tracing) provider, or
     *                         null to build one from config inside the runner
     * @return 0 only on a regular end_turn — the run command's contract
     */
    static int execute(ObjectMapper mapper, SpectroConfig config, LlmProvider providerOverride,
                       NodeSpec spec, SessionStore store, Consumer<String> log) {
        return execute(mapper, config, providerOverride, spec, store, log, false);
    }

    /**
     * The single-shot / linger node run WITHOUT ask-mode gating — delegates to
     * the full {@link #execute(ObjectMapper, SpectroConfig, LlmProvider, NodeSpec,
     * SessionStore, Consumer, boolean, boolean)} with the fixed readonly/auto
     * policy. Every frozen caller and test lands here.
     *
     * @param linger when true, the node stays connected after the run until a stop
     * @return 0 only on a regular end_turn — the run command's contract
     */
    static int execute(ObjectMapper mapper, SpectroConfig config, LlmProvider providerOverride,
                       NodeSpec spec, SessionStore store, Consumer<String> log, boolean linger) {
        return execute(mapper, config, providerOverride, spec, store, log, linger, false);
    }

    /**
     * The node run: connect the bus (the card rides the handshake), publish the
     * whole headless run through the tracing seam, then drain on close — a
     * finishing node must not strand its outbox tail. Reverse control is wired
     * throughout: a hub {@code ctl{stop}} ends a running turn and a lingering
     * node's idle wait; in ask mode a hub {@code ctl{gate}} answers a parked
     * permission request.
     *
     * @param linger  when true, the node stays connected (roster-visible,
     *                controllable) after the run instead of exiting, until a
     *                ctl{stop} arrives (or, in production, SIGTERM)
     * @param askMode when true, a needsPermission tool PARKS until an operator
     *                answers over the hub (block 4) instead of a fixed yes/no —
     *                the parking broker replaces the readonly/auto policy
     * @return 0 only on a regular end_turn — the run command's contract
     */
    static int execute(ObjectMapper mapper, SpectroConfig config, LlmProvider providerOverride,
                       NodeSpec spec, SessionStore store, Consumer<String> log, boolean linger,
                       boolean askMode) {
        String topic = BusEnvelope.topicFor(spec.contextId());
        List<String> capabilities = StandardTools.all().stream().map(Tool::name).toList();
        NodeCard card = new NodeCard(spec.nodeId(), spec.role(), capabilities, topic);
        // The node's own cancel signal: a hub ctl{stop} ends a RUNNING turn.
        // Owned here (not minted inside the runner) so the bus's reverse-control
        // seam can reach it. The latch releases a lingering node's idle wait.
        CancelSignal cancel = new CancelSignal();
        CountDownLatch stopped = new CountDownLatch(1);
        // Ask mode: a PARKING broker holds each needsPermission tool until an
        // operator answers over the hub. Built here (not in call) because it needs
        // THIS run's cancel signal — a stop denies every parked gate. Null in
        // readonly/auto, where the runner keeps its fixed autoApprove policy.
        GateBroker gateBroker = askMode ? new GateBroker(cancel) : null;
        // Close order is the reverse of opening: the port drains its queue
        // into the still-open bus, THEN the bus drains its outbox to the hub.
        try (ProcessBus bus = new ProcessBus(spec.hubHost(), spec.hubPort(), spec.nodeId(),
                OUTBOX, card);
             AsyncBusPort port = new AsyncBusPort(
                     new BusPublisher(bus, spec.nodeId(), spec.contextId(), spec.epoch()),
                     OUTBOX)) {
            // Wire reverse control BEFORE the run: a stop that arrives mid-turn
            // must land on the live signal. Runs on the bus reader thread, so it
            // only flips the (thread-safe) signal and the latch — no blocking here.
            bus.onControl(action -> {
                if ("stop".equals(action)) {
                    log.accept("control: stop received — cancelling the run");
                    cancel.cancel();
                    stopped.countDown();
                }
            });
            // Ask mode: the hub's answer to a parked gate lands on the reader
            // thread; the broker only completes the future — non-blocking by contract.
            if (gateBroker != null) {
                bus.onGate(gateBroker::answer);
                // A gate can only be answered by a LIVE hub. If the hub dies while
                // a gate is parked, none of the cancel triggers can fire — stop
                // needs a live hub, the turn brake needs a TurnStart the parked
                // producer never emits, and the EventStream teardown needs an END
                // it never emits either. Releasing parked gates on hub loss lets
                // the run proceed (denied) and the node exit. Coverage is honest:
                // a hub that CLOSES or RESETS is surfaced promptly; a SILENT
                // partition (no FIN/RST) is surfaced by the connection's TCP
                // keepalive within its window (minutes); and a node still stuck
                // beyond that is ultimately reaped by SIGTERM, the documented
                // fleet backstop. Fires only after an established link drops.
                bus.onDisconnect(gateBroker::denyAllPending);
            }
            HeadlessRunner runner = (providerOverride != null
                    ? HeadlessRunners.withProvider(mapper, config, providerOverride)
                    : new HeadlessRunner(mapper, config))
                    .withIdentity(spec.nodeId())
                    .withAuxiliaryPort(port)
                    .withCancelSignal(cancel);
            if (gateBroker != null) {
                runner = runner.withBroker(gateBroker); // ask mode replaces the fixed policy
            }
            HeadlessRunner.Outcome outcome = runner.runOnce(spec.prompt(), spec.workspace(),
                    spec.autoApprove(), spec.maxTurns(), null, log, store, List.of());

            // Report the run's result NOW — a lingering node's answer must be
            // visible while it waits, not held back until it is finally stopped.
            int code;
            if (outcome.exitOk()) {
                System.out.println(outcome.finalText().stripTrailing());
                code = 0;
            } else {
                System.err.println("Node run did not end regularly (" + outcome.stopReason()
                        + "). Session: " + outcome.sessionId());
                code = 1;
            }

            // A lingering node stays connected until a ctl{stop}. Gate on the
            // stop LATCH, never on the run's cancel signal: the EventStream close
            // cancels that signal on EVERY normal teardown, so it cannot tell an
            // operator stop from an ordinary finish. If a stop already arrived
            // (the run was itself ended by it), the latch is down — skip the wait.
            if (linger && stopped.getCount() > 0) {
                log.accept("node idle — lingering until stop (ctl{stop} or SIGTERM)");
                try {
                    stopped.await();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            return code;
        } finally {
            // A defensive final sweep — NOT the real backstop. It runs only after
            // runOnce returns, which cannot happen WHILE a gate is parked (the
            // parked producer blocks the run from ending), so here pending is
            // already empty. The genuine hub-loss release is bus.onDisconnect
            // above; the genuine stop release is the cancel signal. This guard
            // only matters if a future refactor lets the try body exit with a
            // gate still parked. Idempotent — safe to repeat.
            if (gateBroker != null) {
                gateBroker.denyAllPending();
            }
        }
    }

    /**
     * Validates the flags, resolves hub and config, then hands one
     * {@link NodeSpec} to {@link #execute}. Mirrors the run command's exit
     * contract: 0 only on a regular end_turn.
     *
     * @return 0 on a regular end_turn; 1 for invalid flags, a missing hub,
     *         a missing key, or any other stop reason
     */
    @Override
    public Integer call() {
        if (!"readonly".equals(permissions) && !"auto".equals(permissions)
                && !"ask".equals(permissions)) {
            System.err.println("--permissions must be \"readonly\", \"auto\" or \"ask\" "
                    + "(headless default: readonly).");
            return 1;
        }
        if (maxTurns != null && maxTurns < 1) {
            System.err.println("--max-turns must be an integer >= 1.");
            return 1;
        }
        String hubAddress = resolveHub(hub, System.getenv());
        if (hubAddress == null) {
            System.err.println("No hub: pass --hub host:port or set SPECTRO_HUB.");
            return 1;
        }
        HubAddress address;
        try {
            address = parseHub(hubAddress);
        } catch (IllegalArgumentException invalid) {
            System.err.println(invalid.getMessage());
            return 1;
        }

        ObjectMapper mapper = new ObjectMapper();
        SpectroConfig.ensureSeeded(System.getenv()); // first boot: materialize the env base once
        SpectroConfig config = SpectroConfig.load(effectiveOverrides());
        LogSetup.apply(config.logLevel());

        // The store is minted HERE (like run): the auto workspace is keyed by
        // the session id, and the workspace's own .spectro pair joins the
        // config chain once the workspace is resolved.
        SessionStore store = new SessionStore();
        Path workspace = WorkspaceResolver.resolve(config.workspace(), store.id());
        Path projectDir = Path.of(System.getProperty("user.dir"));
        try {
            config = SpectroConfig.loadForWorkspace(effectiveOverrides(), projectDir, workspace);
        } catch (IllegalArgumentException invalidWorkspaceScope) {
            System.err.println("workspace settings ignored: " + invalidWorkspaceScope.getMessage());
        }

        String nodeId = id != null && !id.isBlank() ? id : "node-" + ProcessHandle.current().pid();
        long epoch = freshEpoch();

        try {
            // Provider construction lives INSIDE the try: a missing key must
            // print its one-line reason, never a stack trace (run's contract).
            LlmProvider providerOverride = verbose
                    ? new TracingProvider(ProviderFactory.providerFromConfig(config),
                            config.provider() + " · " + config.model())
                    : null;
            return execute(mapper, config, providerOverride,
                    new NodeSpec(address.host(), address.port(), nodeId, epoch, context,
                            role, prompt, workspace, "auto".equals(permissions), maxTurns),
                    store, System.err::println, linger, "ask".equals(permissions));
        } catch (IllegalStateException missingKey) {
            System.err.println(missingKey.getMessage());
            return 1;
        }
    }

    /**
     * The node's incarnation stamp: wall-clock millis at process start. Real
     * restarts are always more than a millisecond apart, so the stamp is
     * monotonic per node id in practice; the child-JVM proof runs through
     * THIS method, so the real source is what the tests pin.
     */
    static long freshEpoch() {
        return System.currentTimeMillis();
    }
}
