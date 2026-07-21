package dev.spectroscope.orchestrator;

import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.net.ServerSocket;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The panel→hub env-first leg: a Spectro.panel() code fleet mirrors to a real
 * loopback ProcessBusHub as ordinary fleet frames, while its returned stream
 * stays 100% on the local in-memory spine. Key-free scripted providers; the
 * package-private OrchestratorPanel(HubAddress) seam forces the hub path
 * without touching process env.
 */
@Timeout(value = 40, unit = TimeUnit.SECONDS)
class FleetPanelOverHubTest {

    private static final class ScriptedProvider implements LlmProvider {
        private final String answer;
        private ScriptedProvider(String answer) { this.answer = answer; }
        @Override public Iterable<ProviderEvent> stream(ProviderRequest request) {
            return List.of(new PTextDelta(answer), new PStop(PStop.StopReason.END_TURN));
        }
        @Override public String providerName() { return "scripted"; }
    }

    private static List<RunEvent> drain(EventStream stream) {
        List<RunEvent> events = new ArrayList<>();
        for (RunEvent event : stream) {
            events.add(event);
        }
        return events;
    }

    private static void awaitTrue(java.util.function.BooleanSupplier cond, String what) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 15_000;
        while (!cond.getAsBoolean() && System.currentTimeMillis() < deadline) {
            Thread.sleep(20);
        }
        assertTrue(cond.getAsBoolean(), what);
    }

    private static boolean any(List<BusEnvelope> frames, Predicate<BusEnvelope> p) {
        return frames.stream().anyMatch(p);
    }

    @Test
    void aCodePanelMirrorsToTheHubAsAFleet(@TempDir Path tmp) throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            Map<String, NodeCard> cards = new ConcurrentHashMap<>();
            List<BusEnvelope> frames = new CopyOnWriteArrayList<>();
            AtomicReference<String> topic = new AtomicReference<>();
            hub.onRosterChange(() -> {
                for (NodeCard card : hub.roster()) {
                    cards.putIfAbsent(card.id(), card);
                    if (topic.compareAndSet(null, card.topic())) {
                        hub.subscribe(card.topic(), frames::add); // ring-replays early frames
                    }
                }
            });

            OrchestratorPanel panel = new OrchestratorPanel(new HubAddress("127.0.0.1", hub.port()));
            panel.model(new ScriptedProvider("done")).workspace(tmp);
            panel.agent("bugs").task("find bugs");
            panel.agent("perf").task("check perf");

            // T4 — the returned stream is intact over the hub (spine untouched):
            // panel run_start first, run_end last, both lanes completed.
            List<RunEvent> merged = drain(panel.run());
            assertEquals("panel", assertInstanceOf(RunEvent.RunStart.class, merged.get(0)).agentId());
            assertInstanceOf(RunEvent.RunEnd.class, merged.get(merged.size() - 1));
            for (String lane : List.of("bugs", "perf")) {
                assertTrue(merged.stream().anyMatch(e -> e instanceof RunEvent.AgentMessage m
                        && m.role().equals("result") && m.from().equals(lane) && m.state().equals("completed")),
                        lane + " completed on the spine");
            }

            // T1 — one card per lane + the conductor, all on ONE topic.
            awaitTrue(() -> cards.keySet().containsAll(List.of("bugs", "perf", "panel")),
                    "bugs, perf, panel all announced a card");
            for (var entry : cards.entrySet()) {
                assertEquals(entry.getKey(), entry.getValue().id(), "card id == sender");
                assertEquals(topic.get(), entry.getValue().topic(), "one topic for the whole fleet");
            }

            // T2 — frames reach the hub including the topology (RunStart, spawns).
            awaitTrue(() -> any(frames, f -> f.payload() instanceof RunEvent.RunStart r
                    && r.agentId().equals("panel")), "hub saw the panel RunStart");
            for (String lane : List.of("bugs", "perf")) {
                awaitTrue(() -> any(frames, f -> f.sender().equals("panel")
                                && f.payload() instanceof RunEvent.AgentSpawn s && s.agentId().equals(lane)),
                        "hub saw the spawn edge panel→" + lane);
                // T3 — both lanes deliver their own frames (neither dropped as redelivery).
                awaitTrue(() -> any(frames, f -> f.sender().equals(lane)), "hub saw " + lane + "'s own frames");
            }
            // epoch 0 on every mirrored frame (fresh per-run context makes it safe).
            assertTrue(frames.stream().allMatch(f -> f.epoch() == 0L), "epoch 0 across the fleet");
        }
    }

    @Test
    void anUnreachableHubNeitherDelaysNorBreaksTheReturnedStream(@TempDir Path tmp) {
        int deadPort;
        try (ServerSocket probe = new ServerSocket(0)) {
            deadPort = probe.getLocalPort();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        // deadPort is now closed → connection refused. The hub mirror can only
        // drop-count; the returned stream is the local spine and must be whole.
        OrchestratorPanel panel = new OrchestratorPanel(new HubAddress("127.0.0.1", deadPort));
        panel.model(new ScriptedProvider("ok")).workspace(tmp);
        panel.agent("solo").task("say ok");

        long start = System.nanoTime();
        List<RunEvent> merged = drain(panel.run());
        long elapsedMs = (System.nanoTime() - start) / 1_000_000;

        assertInstanceOf(RunEvent.RunStart.class, merged.get(0));
        RunEvent.RunEnd last = assertInstanceOf(RunEvent.RunEnd.class, merged.get(merged.size() - 1));
        assertEquals("end_turn", last.stopReason());
        assertTrue(merged.stream().anyMatch(e -> e instanceof RunEvent.AgentMessage m
                && m.from().equals("solo") && m.role().equals("result") && m.state().equals("completed")),
                "the lane completed despite the dead hub");
        // The invariant: the ProcessBus ack-drain (up to a 5s grace per connection)
        // is OFF the spine's critical path (detached close), so a dead hub must
        // NOT delay the returned stream's completion. Before the fix this drain
        // ran inline and the run took ~10s; a scripted run is otherwise ~ms.
        assertTrue(elapsedMs < 3_000,
                "the returned stream must not be gated by hub teardown — took " + elapsedMs + "ms");
    }

    @Test
    void aNonUrlSafeLaneIdIsRejectedEarlyOnBothPaths(@TempDir Path tmp) {
        // In-memory path (injected bus, no hub).
        OrchestratorPanel inMemory = new OrchestratorPanel(new InMemoryBus());
        inMemory.model(new ScriptedProvider("x")).workspace(tmp);
        inMemory.agent("bad id").task("t");
        assertThrows(IllegalArgumentException.class, inMemory::run, "bad id rejected in-memory");

        // Hub path (a dead port would be fine — the throw happens BEFORE any connect).
        OrchestratorPanel overHub = new OrchestratorPanel(new HubAddress("127.0.0.1", 65535));
        overHub.model(new ScriptedProvider("x")).workspace(tmp);
        overHub.agent("bad/id").task("t");
        assertThrows(IllegalArgumentException.class, overHub::run, "bad id rejected on the hub path too");
    }

    @Test
    void sequentialRunsMintDistinctContexts(@TempDir Path tmp) {
        var a = new OrchestratorPanel(new InMemoryBus());
        a.model(new ScriptedProvider("1")).workspace(tmp.resolve("a"));
        a.agent("solo").task("one");
        RunEvent.RunStart startA = assertInstanceOf(RunEvent.RunStart.class, drain(a.run()).get(0));

        var b = new OrchestratorPanel(new InMemoryBus());
        b.model(new ScriptedProvider("2")).workspace(tmp.resolve("b"));
        b.agent("solo").task("two");
        RunEvent.RunStart startB = assertInstanceOf(RunEvent.RunStart.class, drain(b.run()).get(0));

        assertNotEquals(startA.runId(), startB.runId(), "each run mints a fresh context (epoch-0 precondition)");
    }
}
