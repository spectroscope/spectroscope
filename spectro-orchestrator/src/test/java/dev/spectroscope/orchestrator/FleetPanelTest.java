package dev.spectroscope.orchestrator;

import dev.spectroscope.Spectro;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The fleet smoke, key-free: scripted providers instead of an LLM. What the
 * Spectrum tab folds — run_start/spawn/task/status/result per lane, one
 * closing panel run_end — is exactly what these asserts pin.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class FleetPanelTest {

    /** One turn: a thought, an answer, end of turn. No tools, no keys. */
    private static final class ScriptedProvider implements LlmProvider {
        private final String answer;

        private ScriptedProvider(String answer) {
            this.answer = answer;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            return List.of(
                    new PThinkingDelta("planning " + answer),
                    new PTextDelta(answer),
                    new PStop(PStop.StopReason.END_TURN));
        }

        @Override
        public String providerName() {
            return "scripted";
        }
    }

    /** A lane whose backend explodes — the panel must record, not crash. */
    private static final class BrokenProvider implements LlmProvider {
        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            throw new IllegalStateException("backend gone");
        }
    }

    private static List<RunEvent> drain(EventStream stream) {
        List<RunEvent> events = new ArrayList<>();
        for (RunEvent event : stream) {
            events.add(event);
        }
        return events;
    }

    @Test
    void aFleetMergesIntoOneSpectrum(@TempDir Path tmp) {
        var panel = Spectro.panel() // the frozen facade entry — ServiceLoader smoke included
                .model(new ScriptedProvider("done"))
                .workspace(tmp);
        panel.agent("bugs").task("find bugs in the diff");
        panel.agent("perf").task("check the hot queries");

        List<RunEvent> events = drain(panel.run());

        // The panel frames the fleet: its run_start first, its run_end last.
        RunEvent.RunStart first = assertInstanceOf(RunEvent.RunStart.class, events.get(0));
        assertEquals("panel", first.agentId());
        RunEvent.RunEnd last = assertInstanceOf(RunEvent.RunEnd.class, events.get(events.size() - 1));
        assertEquals(first.runId(), last.runId());
        assertEquals("end_turn", last.stopReason());

        // Every lane: announced (spawn + task), identified (run_start with
        // parentId panel), worked, and closed with a completed result.
        for (String lane : List.of("bugs", "perf")) {
            assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.AgentSpawn s
                    && s.agentId().equals(lane) && s.parentId().equals("panel")), lane + " spawned");
            assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.AgentMessage m
                    && m.role().equals("task") && m.to().equals(lane) && m.state().equals("submitted")), lane + " task");
            assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.AgentMessage m
                    && m.role().equals("status") && m.from().equals(lane) && m.state().equals("working")), lane + " status");
            assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.RunStart r
                    && lane.equals(r.agentId()) && "panel".equals(r.parentId())), lane + " run_start");
            assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.AgentMessage m
                    && m.role().equals("result") && m.from().equals(lane) && m.state().equals("completed")), lane + " result");
        }

        // Per-lane order survives the merge: run_start before the text delta
        // before run_end, for each lane on its own.
        for (String lane : List.of("bugs", "perf")) {
            List<RunEvent> laneEvents = events.stream()
                    .filter(e -> e instanceof RunEvent.RunStart r && lane.equals(r.agentId())
                            || e instanceof RunEvent.TextDelta t && lane.equals(t.agentId())
                            || e instanceof RunEvent.RunEnd)
                    .toList();
            int start = indexOfType(laneEvents, RunEvent.RunStart.class);
            int text = indexOfType(laneEvents, RunEvent.TextDelta.class);
            assertTrue(start >= 0 && text > start, lane + " ordered");
        }
    }

    @Test
    void aBrokenLaneFailsLoudlyAndAloneWhileThePanelCloses(@TempDir Path tmp) {
        var panel = Spectro.panel().model(new ScriptedProvider("fine")).workspace(tmp);
        panel.agent("steady").task("do the fine thing");
        panel.agent("doomed").model(new BrokenProvider()).task("hit the wall");

        List<RunEvent> events = drain(panel.run());

        assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.AgentMessage m
                && m.role().equals("result") && m.from().equals("steady") && m.state().equals("completed")));
        assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.AgentMessage m
                && m.role().equals("result") && m.from().equals("doomed") && m.state().equals("failed")));
        // The stream still ends in the panel's own run_end — one lane's death
        // never kills the spectrum.
        assertInstanceOf(RunEvent.RunEnd.class, events.get(events.size() - 1));
    }

    @Test
    void envelopesCorrelateByTaskAndChainPerSender(@TempDir Path tmp) {
        RecordingBus bus = new RecordingBus();
        OrchestratorPanel panel = new OrchestratorPanel(bus);
        panel.model(new ScriptedProvider("ok")).workspace(tmp);
        panel.agent("bugs").task("find bugs");
        panel.agent("perf").task("check perf");

        drain(panel.run());

        // Correlation: each lane's own envelopes share ONE taskId, and the
        // panel's announcement of that lane rides the SAME taskId (self-
        // addressing — nobody needed from/to on the envelope).
        String bugsTask = bus.frames.stream()
                .filter(f -> f.sender().equals("bugs")).findFirst().orElseThrow().taskId();
        assertTrue(bus.frames.stream().filter(f -> f.sender().equals("bugs"))
                .allMatch(f -> f.taskId().equals(bugsTask)));
        assertTrue(bus.frames.stream().anyMatch(f -> f.sender().equals("panel")
                && f.taskId().equals(bugsTask)
                && f.payload() instanceof RunEvent.AgentSpawn s && s.agentId().equals("bugs")));
        String perfTask = bus.frames.stream()
                .filter(f -> f.sender().equals("perf")).findFirst().orElseThrow().taskId();
        assertNotEquals(bugsTask, perfTask);

        // Per sender: monotonic sequence and an unbroken causal chain back to
        // the root marker (the bus-proof's 03-causal-chain property).
        for (String sender : List.of("panel", "bugs", "perf")) {
            List<BusEnvelope> own = bus.frames.stream().filter(f -> f.sender().equals(sender)).toList();
            for (int i = 0; i < own.size(); i++) {
                assertEquals(i, own.get(i).sequence(), sender + " sequence");
                assertEquals(i == 0 ? BusEnvelope.CHAIN_ROOT : own.get(i - 1).id(),
                        own.get(i).parentId(), sender + " chain");
            }
        }

        // Same context, same topic, for every frame of the fleet.
        assertEquals(1, bus.frames.stream().map(BusEnvelope::contextId).distinct().count());
        assertEquals(1, bus.frames.stream().map(BusEnvelope::topic).distinct().count());
    }

    @Test
    void aCallerSuppliedTransportOutlivesTheRun(@TempDir Path tmp) {
        // The seam contract: the panel closes only a bus it created itself.
        // A shared aggregator (or the future process transport) must survive
        // one panel's run untouched.
        CloseTrackingBus bus = new CloseTrackingBus();
        OrchestratorPanel panel = new OrchestratorPanel(bus);
        panel.model(new ScriptedProvider("ok")).workspace(tmp);
        panel.agent("solo").task("say ok");

        drain(panel.run());

        assertFalse(bus.closed, "caller-supplied transport must not be closed by the panel");
        assertTrue(bus.frames.size() > 0, "the run still rode the supplied transport");
    }

    private static int indexOfType(List<RunEvent> events, Class<? extends RunEvent> type) {
        for (int i = 0; i < events.size(); i++) {
            if (type.isInstance(events.get(i))) {
                return i;
            }
        }
        return -1;
    }

    /** A recording transport that also notices an unwanted close(). */
    private static final class CloseTrackingBus implements BusTransport {
        private final InMemoryBus delegate = new InMemoryBus();
        final List<BusEnvelope> frames = new java.util.concurrent.CopyOnWriteArrayList<>();
        volatile boolean closed = false;

        @Override
        public void publish(BusEnvelope frame) {
            frames.add(frame);
            delegate.publish(frame);
        }

        @Override
        public AutoCloseable subscribe(String topic, java.util.function.Consumer<BusEnvelope> onFrame) {
            return delegate.subscribe(topic, onFrame);
        }

        @Override
        public void close() {
            closed = true;
        }
    }

    /** An InMemoryBus that also keeps every published frame for asserts. */
    private static final class RecordingBus implements BusTransport {
        private final InMemoryBus delegate = new InMemoryBus();
        final List<BusEnvelope> frames = new java.util.concurrent.CopyOnWriteArrayList<>();

        @Override
        public void publish(BusEnvelope frame) {
            frames.add(frame);
            delegate.publish(frame);
        }

        @Override
        public AutoCloseable subscribe(String topic, java.util.function.Consumer<BusEnvelope> onFrame) {
            return delegate.subscribe(topic, onFrame);
        }
    }
}
