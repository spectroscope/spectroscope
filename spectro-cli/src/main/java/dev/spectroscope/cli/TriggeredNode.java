package dev.spectroscope.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.SpectroConfig;
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

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/**
 * The triggered node loop (card 72): wait → run → wait. Lives NEXT to the
 * frozen single-shot path in {@link NodeCommand#execute} — that path's shape
 * is run-once-then-idle and must never grow per-fire state; this one inverts
 * it. The node's bus life stays exactly the single-shot's: ONE ProcessBus,
 * ONE publisher, ONE epoch, so sequences stay monotone per (sender, epoch)
 * across fires and hub dedup/replay/acks need zero changes. ONE session
 * store, so every fire appends to the same JSONL — repeated run_start/run_end
 * pairs in one session are the existing chat-session shape.
 *
 * <p>No initial run: the prompt is written against an event, and running it
 * with no event executes half a sentence. The node boots straight to
 * waiting and says so.</p>
 */
final class TriggeredNode {

    private TriggeredNode() {
    }

    /**
     * Builds the real sources for the given spec. Fails as a unit: a source
     * that cannot open (port taken, watcher denied) closes the ones already
     * opened — a node must never come up half-triggered.
     *
     * @param triggers the parsed trigger flags
     * @param log      stderr sink for source refusals and skips
     * @return the opened sources, not yet started
     */
    static List<TriggerSource> sources(TriggerSpec triggers, Consumer<String> log) {
        List<TriggerSource> sources = new ArrayList<>();
        try {
            if (triggers.watchRoot() != null) {
                sources.add(new FsWatchTrigger(triggers.watchRoot(),
                        new WatchServiceDirWatch(triggers.watchRoot()),
                        System::currentTimeMillis, log));
            }
            if (triggers.listenPort() != null) {
                sources.add(new HttpTrigger(triggers.listenPort(), triggers.token(), log));
            }
        } catch (IOException failedToOpen) {
            sources.forEach(TriggerSource::close);
            throw new IllegalStateException(
                    "trigger source failed to open: " + failedToOpen.getMessage(), failedToOpen);
        }
        if (triggers.everyMs() != null) {
            sources.add(new TimerTrigger(triggers.everyMs(), triggers.everyLabel(), log));
        }
        return sources;
    }

    /**
     * Runs the standing node until a hub {@code ctl{stop}} (or SIGTERM) ends
     * it. Each fire runs the operator's prompt with the event as fenced
     * context, on a FRESH runId, a FRESH cancel signal and (in ask mode) a
     * FRESH gate broker — a stop mid-run aborts that fire AND the loop.
     *
     * @param mapper           the module's shared ObjectMapper
     * @param config           the effective configuration
     * @param providerOverride a pre-built provider, or null to build from config
     * @param spec             the node's identity, hub, prompt and policy
     * @param triggers         the parsed trigger flags (card note, token, labels)
     * @param sources          the trigger sources to start — injectable for tests
     * @param store            the ONE session store all fires append to
     * @param log              stderr sink
     * @param askMode          true parks each gate for an operator over the hub
     * @return 0 on a clean stop — per-fire failures are reported per fire and
     *         never end the standing automation
     */
    static int execute(ObjectMapper mapper, SpectroConfig config, LlmProvider providerOverride,
                       NodeCommand.NodeSpec spec, TriggerSpec triggers,
                       List<TriggerSource> sources, SessionStore store, Consumer<String> log,
                       boolean askMode) {
        String topic = BusEnvelope.topicFor(spec.contextId());
        List<String> capabilities = StandardTools.all().stream().map(Tool::name).toList();
        NodeCard card = new NodeCard(spec.nodeId(), spec.role(), capabilities, topic,
                triggers.describe());

        FireSlot slot = new FireSlot();
        AtomicBoolean stopping = new AtomicBoolean();
        // The LIVE fire's signal and broker: the bus reader thread must reach
        // exactly the run that is active when its ctl arrives — a per-fire
        // signal (unlike the single-shot's per-process one) or the second
        // fire would inherit the first one's cancelled state.
        AtomicReference<CancelSignal> liveCancel = new AtomicReference<>();
        AtomicReference<GateBroker> liveBroker = new AtomicReference<>();

        try (ProcessBus bus = new ProcessBus(spec.hubHost(), spec.hubPort(), spec.nodeId(),
                NodeCommand.OUTBOX, card);
             AsyncBusPort port = new AsyncBusPort(
                     new BusPublisher(bus, spec.nodeId(), spec.contextId(), spec.epoch()),
                     NodeCommand.OUTBOX)) {
            bus.onControl(action -> {
                if ("stop".equals(action)) {
                    log.accept("control: stop received — ending the triggered node");
                    stopping.set(true);
                    slot.stop();
                    CancelSignal current = liveCancel.get();
                    if (current != null) {
                        current.cancel();
                    }
                }
            });
            bus.onGate((callId, allow) -> {
                GateBroker broker = liveBroker.get();
                if (broker != null) {
                    broker.answer(callId, allow);
                }
            });
            bus.onDisconnect(() -> {
                GateBroker broker = liveBroker.get();
                if (broker != null) {
                    broker.denyAllPending();
                }
            });

            try {
                if (triggers.token() != null) {
                    // Once, stderr only — the token must never ride the bus,
                    // the card, or any event.
                    log.accept("trigger token (send as \"Authorization: Bearer <token>\"): "
                            + triggers.token());
                }
                for (TriggerSource source : sources) {
                    source.start(slot::offer);
                }
                log.accept("node waiting on " + triggers.describe() + " — fires run the prompt");

                int fireNo = 0;
                while (true) {
                    Fire fire;
                    try {
                        fire = slot.take();
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                    if (fire == null) {
                        break; // stopped while waiting
                    }
                    fireNo++;
                    CancelSignal cancel = new CancelSignal();
                    liveCancel.set(cancel);
                    if (stopping.get()) {
                        break; // a stop raced the take — nothing may run after a stop
                    }
                    GateBroker broker = askMode ? new GateBroker(cancel) : null;
                    liveBroker.set(broker);

                    HeadlessRunner runner = (providerOverride != null
                            ? HeadlessRunners.withProvider(mapper, config, providerOverride)
                            : new HeadlessRunner(mapper, config))
                            .withIdentity(spec.nodeId())
                            .withAuxiliaryPort(port)
                            .withCancelSignal(cancel)
                            .withTrigger(fire.kind() + " #" + fireNo + " " + fire.source());
                    if (broker != null) {
                        runner = runner.withBroker(broker);
                    }
                    HeadlessRunner.Outcome outcome = runner.runOnce(
                            spec.prompt() + "\n\n" + fire.contextBlock(fireNo),
                            spec.workspace(), spec.autoApprove(), spec.maxTurns(),
                            null, log, store, List.of());

                    // Report per fire, NOW — a standing node's answers must be
                    // visible while it keeps waiting, not at its eventual stop.
                    if (outcome.exitOk()) {
                        System.out.println(outcome.finalText().stripTrailing());
                    } else {
                        System.err.println("Trigger fire #" + fireNo + " did not end regularly ("
                                + outcome.stopReason() + "). Session: " + outcome.sessionId());
                    }
                    liveBroker.set(null);
                    liveCancel.set(null);
                    if (broker != null) {
                        broker.denyAllPending(); // idempotent sweep, like the single-shot's
                    }
                    if (stopping.get()) {
                        break;
                    }
                }
            } finally {
                // Sources first, then the bus (via try-with-resources): a source
                // still firing into a closing node only meets the refusing slot.
                sources.forEach(TriggerSource::close);
            }
            return 0;
        }
    }
}
