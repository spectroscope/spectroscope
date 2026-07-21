package dev.spectroscope.server;

import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.orchestrator.BusEnvelope;
import dev.spectroscope.orchestrator.HubAddress;
import dev.spectroscope.orchestrator.OrchestratorPanel;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The whole panel→hub leg at the server altitude: a {@code Spectro.panel()} code
 * fleet, pointed at a {@link FleetAggregator}'s hub via SPECTRO_HUB, appears as a
 * fleet — roster nodes per lane (+ the conductor) under one topic, a fleet event
 * per lane sender — and folds to disconnected when the run ends.
 */
@Timeout(value = 40, unit = TimeUnit.SECONDS)
class FleetPanelAggregatorTest {

    private static final class ScriptedProvider implements LlmProvider {
        @Override public Iterable<ProviderEvent> stream(ProviderRequest request) {
            return List.of(new PTextDelta("ok"), new PStop(PStop.StopReason.END_TURN));
        }
        @Override public String providerName() { return "scripted"; }
    }

    private static void drain(EventStream stream) {
        for (RunEvent ignored : stream) {
            // consume the merged spine stream to completion
        }
    }

    private static void awaitTrue(java.util.function.BooleanSupplier cond, String what) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 15_000;
        while (!cond.getAsBoolean() && System.currentTimeMillis() < deadline) {
            Thread.sleep(20);
        }
        assertTrue(cond.getAsBoolean(), what);
    }

    @Test
    void aCodePanelAppearsAsAFleetEndToEnd(@TempDir Path tmp) throws Exception {
        try (FleetAggregator aggregator = new FleetAggregator("0")) {
            Set<String> rosterIds = ConcurrentHashMap.newKeySet();
            Set<String> eventSenders = ConcurrentHashMap.newKeySet();
            Set<String> topics = ConcurrentHashMap.newKeySet();
            aggregator.addListener(new FleetAggregator.Listener() {
                @Override
                public void onRoster(List<FleetAggregator.NodeState> roster) {
                    for (FleetAggregator.NodeState state : roster) {
                        rosterIds.add(state.card().id());
                        topics.add(state.card().topic());
                    }
                }

                @Override
                public void onFleetEvent(BusEnvelope envelope) {
                    eventSenders.add(envelope.sender());
                }
            });

            OrchestratorPanel panel = new OrchestratorPanel(new HubAddress("127.0.0.1", aggregator.port()));
            panel.model(new ScriptedProvider()).workspace(tmp);
            panel.agent("bugs").task("find bugs");
            panel.agent("perf").task("check perf");
            drain(panel.run());

            // The roster lists every lane + the conductor, under exactly one topic.
            awaitTrue(() -> rosterIds.containsAll(List.of("bugs", "perf", "panel")),
                    "the panel's lanes + conductor joined the roster");
            awaitTrue(() -> topics.size() == 1, "one topic for the whole code fleet");

            // A fleet event arrived for each lane sender (the live feed lit up).
            awaitTrue(() -> eventSenders.containsAll(List.of("bugs", "perf")),
                    "the aggregator saw each lane's fleet events");

            // The run ended → every node folds to disconnected, still on the roster.
            awaitTrue(() -> aggregator.snapshot().size() >= 3
                            && aggregator.snapshot().stream().noneMatch(FleetAggregator.NodeState::connected),
                    "the finished fleet folds to disconnected, not vanished");
            assertEquals(1, aggregator.snapshot().stream().map(s -> s.card().topic()).distinct().count());
            assertFalse(aggregator.snapshot().isEmpty(), "the roster kept the departed fleet");
        }
    }
}
