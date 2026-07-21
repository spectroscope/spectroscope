package dev.spectroscope.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.orchestrator.BusEnvelope;
import dev.spectroscope.orchestrator.NodeCard;
import dev.spectroscope.orchestrator.ProcessBusHub;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import picocli.CommandLine;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The fleet node command: one headless run whose whole event stream rides
 * the ProcessBus to a hub — identity at the source (sender, agent id and
 * card agree), a fresh epoch per process, JSONL durability first. The run
 * loop is tested in-process against a real hub; the child-JVM half lives in
 * {@link NodeProcessProofTest}.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class NodeCommandTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final SpectroConfig CONFIG = new SpectroConfig(
            "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
            java.util.List.of(), "gemini", true, java.util.List.of(), 2, true,
            java.util.List.of(), null, "info", null, null, null);

    private static final class ScriptedProvider implements LlmProvider {
        final Queue<List<ProviderEvent>> turns = new ArrayDeque<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            List<ProviderEvent> turn = turns.poll();
            if (turn == null) {
                throw new IllegalStateException("no scripted turn left");
            }
            return turn;
        }
    }

    private static ScriptedProvider oneAnswer(String text) {
        ScriptedProvider provider = new ScriptedProvider();
        provider.turns.add(List.of(
                new LlmProvider.PTextDelta(text),
                new LlmProvider.PUsage(10, 4),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        return provider;
    }

    @Test
    void theNodeFlagsParseThroughTheCli() {
        SpectroCli cli = new SpectroCli();
        CommandLine.ParseResult parsed = new CommandLine(cli).parseArgs(
                "node", "-p", "scan the logs", "--hub", "127.0.0.1:7331",
                "--id", "node-1", "--context", "fleet-1", "--role", "reviewer");

        NodeCommand node = (NodeCommand) parsed.subcommand().commandSpec().userObject();
        assertEquals("scan the logs", node.prompt);
        assertEquals("127.0.0.1:7331", node.hub);
        assertEquals("node-1", node.id);
        assertEquals("fleet-1", node.context);
        assertEquals("reviewer", node.role);
        assertEquals("readonly", node.permissions, "capability before convenience — like run");
    }

    @Test
    void theHubResolvesFlagOverEnvAndTheAddressParsesStrictly() {
        assertEquals("flag:1", NodeCommand.resolveHub("flag:1", Map.of("SPECTRO_HUB", "env:2")));
        assertEquals("env:2", NodeCommand.resolveHub(null, Map.of("SPECTRO_HUB", "env:2")));
        assertNull(NodeCommand.resolveHub(null, Map.of()), "no flag, no env — the caller errors out");

        NodeCommand.HubAddress address = NodeCommand.parseHub("127.0.0.1:7331");
        assertEquals("127.0.0.1", address.host());
        assertEquals(7331, address.port());
        assertThrows(IllegalArgumentException.class, () -> NodeCommand.parseHub("no-port-here"));
        assertThrows(IllegalArgumentException.class, () -> NodeCommand.parseHub("host:not-a-number"));
        assertThrows(IllegalArgumentException.class, () -> NodeCommand.parseHub("host:99999"));
        // IPv6 literals must be rejected loudly, not misparsed into garbage
        // splits (":" as a host, "[::1]" as an unresolvable name).
        assertThrows(IllegalArgumentException.class, () -> NodeCommand.parseHub("::1"));
        assertThrows(IllegalArgumentException.class, () -> NodeCommand.parseHub("[::1]:7000"));
    }

    @Test
    void aNodeRunPublishesItsWholeStreamOverTheBus(@TempDir Path cwd) throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            List<BusEnvelope> seen = Collections.synchronizedList(new ArrayList<>());
            CountDownLatch runStartAtHub = new CountDownLatch(1);
            CountDownLatch runEnd = new CountDownLatch(1);
            hub.subscribe(BusEnvelope.topicFor("fleet-t"), env -> {
                seen.add(env);
                if (env.payload() instanceof RunEvent.RunStart) {
                    runStartAtHub.countDown();
                }
                if (env.payload() instanceof RunEvent.RunEnd) {
                    runEnd.countDown();
                }
            });

            // The provider PARKS until the test releases it: while parked,
            // the node is provably mid-run — the roster read below cannot
            // race the node's departure.
            CountDownLatch releaseProvider = new CountDownLatch(1);
            ScriptedProvider provider = oneAnswer("All clean.");
            LlmProvider parking = request -> {
                try {
                    releaseProvider.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                return provider.stream(request);
            };

            SessionStore store = new SessionStore();
            java.util.concurrent.atomic.AtomicInteger exit =
                    new java.util.concurrent.atomic.AtomicInteger(-1);
            Thread run = Thread.ofVirtual().start(() ->
                    exit.set(NodeCommand.execute(JSON, CONFIG, parking,
                            new NodeCommand.NodeSpec("127.0.0.1", hub.port(), "node-t", 42L,
                                    "fleet-t", "reviewer", "scan", cwd, false, null),
                            store, line -> { })));

            assertTrue(runStartAtHub.await(10, TimeUnit.SECONDS),
                    "run_start reached the hub while the provider holds the run open");
            List<String> tools = StandardTools.all().stream().map(Tool::name).toList();
            assertEquals(List.of(new NodeCard("node-t", "reviewer", tools, "fleet-t.events")),
                    hub.roster(),
                    "mid-run, the roster names the node's ACTUAL registry");

            releaseProvider.countDown();
            run.join(10_000);
            assertEquals(0, exit.get(), "a regular end_turn exits 0, like run");
            assertTrue(runEnd.await(10, TimeUnit.SECONDS), "the run's end reached the hub");

            BusEnvelope first = seen.get(0);
            assertEquals("node-t", first.sender());
            assertEquals(42L, first.epoch(), "the spec's epoch stamps every envelope");
            RunEvent.RunStart start = (RunEvent.RunStart) first.payload();
            assertEquals("node-t", start.agentId(),
                    "identity at the source: the events themselves carry the node id");
            assertTrue(seen.stream().allMatch(env -> "node-t".equals(env.sender())),
                    "one node, one sender — every envelope agrees");

            Path sessionFile = Path.of(System.getProperty("user.home"), ".spectro", "sessions",
                    store.id() + ".jsonl");
            assertTrue(Files.exists(sessionFile),
                    "durability first — the node is a normal session locally");
        }
    }

    @Test
    void aControlStopCancelsARunningNode(@TempDir Path cwd) throws Exception {
        // Block 2 reverse ctl end to end: a running node, the hub sends
        // control(id,"stop"), the node's bus dispatches it to a cancel that ends
        // the turn "aborted". The provider parks waiting for that cancel; if it
        // never comes it falls through to a normal answer after a bounded window,
        // so the pre-wiring RED fails fast (exit 0) instead of hanging.
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            List<BusEnvelope> seen = Collections.synchronizedList(new ArrayList<>());
            CountDownLatch runStartAtHub = new CountDownLatch(1);
            CountDownLatch runEndAtHub = new CountDownLatch(1);
            hub.subscribe(BusEnvelope.topicFor("fleet-stop"), env -> {
                seen.add(env);
                if (env.payload() instanceof RunEvent.RunStart) {
                    runStartAtHub.countDown();
                }
                if (env.payload() instanceof RunEvent.RunEnd) {
                    runEndAtHub.countDown();
                }
            });

            LlmProvider parking = request -> {
                long deadline = System.currentTimeMillis() + 3_000;
                while (!request.signal().isCancelled() && System.currentTimeMillis() < deadline) {
                    try {
                        Thread.sleep(10);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
                if (request.signal().isCancelled()) {
                    return List.of(); // stopped mid-flight → the loop ends aborted
                }
                return List.of( // never stopped → a normal answer (RED fails fast)
                        new LlmProvider.PTextDelta("ran to completion"),
                        new LlmProvider.PUsage(3, 1),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
            };

            SessionStore store = new SessionStore();
            java.util.concurrent.atomic.AtomicInteger exit =
                    new java.util.concurrent.atomic.AtomicInteger(-99);
            Thread run = Thread.ofVirtual().start(() ->
                    exit.set(NodeCommand.execute(JSON, CONFIG, parking,
                            new NodeCommand.NodeSpec("127.0.0.1", hub.port(), "node-s", 5L,
                                    "fleet-stop", "worker", "scan", cwd, false, null),
                            store, line -> { })));

            assertTrue(runStartAtHub.await(10, TimeUnit.SECONDS), "the node is provably mid-run");
            hub.control("node-s", "stop"); // the reverse ctl: end the running node

            assertTrue(runEndAtHub.await(10, TimeUnit.SECONDS), "the stopped run's end reached the hub");
            run.join(10_000);
            assertEquals(1, exit.get(), "an externally-stopped run is not a regular end_turn");

            RunEvent.RunEnd end = seen.stream().map(BusEnvelope::payload)
                    .filter(RunEvent.RunEnd.class::isInstance).map(RunEvent.RunEnd.class::cast)
                    .reduce((first, second) -> second).orElseThrow();
            assertEquals("aborted", end.stopReason(), "the terminal frame is an aborted run");
        }
    }

    @Test
    void aLingeringNodeStaysConnectedAfterTheRunAndExitsOnStop(@TempDir Path cwd) throws Exception {
        // Opt-in --linger: after a NORMAL run the node stays connected (roster-
        // visible, controllable) instead of exiting, until a ctl{stop} (or, in
        // production, SIGTERM). Default-off keeps every frozen test single-shot.
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            CountDownLatch runEndAtHub = new CountDownLatch(1);
            CountDownLatch joined = new CountDownLatch(1);
            hub.onRosterChange(joined::countDown);
            hub.subscribe(BusEnvelope.topicFor("fleet-linger"), env -> {
                if (env.payload() instanceof RunEvent.RunEnd) {
                    runEndAtHub.countDown();
                }
            });

            SessionStore store = new SessionStore();
            java.util.concurrent.atomic.AtomicInteger exit =
                    new java.util.concurrent.atomic.AtomicInteger(-99);
            Thread run = Thread.ofVirtual().start(() ->
                    exit.set(NodeCommand.execute(JSON, CONFIG, oneAnswer("all done"),
                            new NodeCommand.NodeSpec("127.0.0.1", hub.port(), "node-l", 3L,
                                    "fleet-linger", "worker", "scan", cwd, false, null),
                            store, line -> { }, /* linger */ true)));

            assertTrue(joined.await(10, TimeUnit.SECONDS), "the node registered on the hub");
            assertTrue(runEndAtHub.await(10, TimeUnit.SECONDS), "the run completed");
            run.join(500);
            assertTrue(run.isAlive(), "a lingering node does NOT exit on its own after the run");

            hub.control("node-l", "stop"); // the reverse ctl ends the idle lingering node
            run.join(10_000);
            assertFalse(run.isAlive(), "ctl{stop} ends the lingering node");
            assertEquals(0, exit.get(), "a cleanly-stopped node whose run ended ok exits 0");
        }
    }

    @Test
    void aLingeringNodeStoppedMidRunAbortsAndDoesNotHangInTheLingerWait(@TempDir Path cwd) throws Exception {
        // The edge the linger gate must survive: --linger AND a stop that lands
        // DURING the run. The run aborts, and the node must NOT then fall into
        // the idle linger wait (the stop already fired) — it exits.
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            CountDownLatch runStartAtHub = new CountDownLatch(1);
            CountDownLatch runEndAtHub = new CountDownLatch(1);
            hub.subscribe(BusEnvelope.topicFor("fleet-lm"), env -> {
                if (env.payload() instanceof RunEvent.RunStart) {
                    runStartAtHub.countDown();
                }
                if (env.payload() instanceof RunEvent.RunEnd) {
                    runEndAtHub.countDown();
                }
            });
            LlmProvider parking = request -> {
                while (!request.signal().isCancelled()) {
                    try {
                        Thread.sleep(10);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
                return List.of();
            };

            java.util.concurrent.atomic.AtomicInteger exit =
                    new java.util.concurrent.atomic.AtomicInteger(-99);
            Thread run = Thread.ofVirtual().start(() ->
                    exit.set(NodeCommand.execute(JSON, CONFIG, parking,
                            new NodeCommand.NodeSpec("127.0.0.1", hub.port(), "node-lm", 4L,
                                    "fleet-lm", "worker", "scan", cwd, false, null),
                            new SessionStore(), line -> { }, /* linger */ true)));

            assertTrue(runStartAtHub.await(10, TimeUnit.SECONDS), "the node is mid-run");
            hub.control("node-lm", "stop"); // stop lands DURING the run

            run.join(10_000);
            assertFalse(run.isAlive(), "a linger node stopped mid-run exits, it does not hang lingering");
            assertEquals(1, exit.get(), "a mid-run stop is an aborted run, not a clean end");
            assertTrue(runEndAtHub.await(5, TimeUnit.SECONDS), "its aborted end reached the hub");
        }
    }

    @Test
    void aDeadHubNeverKillsOrBlocksTheRun(@TempDir Path cwd) {
        // The review's self-deadlock finding: with the hub down, the outbox
        // (1024) plus the node's queue (1024) fill — before the fix, event
        // 2049 parked the run loop forever. Port 1 is the deterministic dead
        // address (tcpmux, root-only bind: nothing listens, connects refuse).
        // 2200 deltas exceed both buffers; the run must still end regularly,
        // because the session JSONL — not the bus — is the durability anchor.
        ScriptedProvider provider = new ScriptedProvider();
        List<LlmProvider.ProviderEvent> turn = new ArrayList<>();
        for (int i = 0; i < 2200; i++) {
            turn.add(new LlmProvider.PTextDelta("d" + i));
        }
        turn.add(new LlmProvider.PUsage(10, 4));
        turn.add(new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        provider.turns.add(turn);

        SessionStore store = new SessionStore();
        int exit = NodeCommand.execute(JSON, CONFIG, provider,
                new NodeCommand.NodeSpec("127.0.0.1", 1, "node-d", 7L,
                        "fleet-d", "worker", "scan", cwd, false, null),
                store, line -> { });

        assertEquals(0, exit, "a dead bus never kills the run — JSONL is the anchor");
        Path sessionFile = Path.of(System.getProperty("user.home"), ".spectro", "sessions",
                store.id() + ".jsonl");
        assertTrue(Files.exists(sessionFile), "the session survived the dead hub whole");
    }

    @Test
    void aRestartedNodeDeliversUnderItsFreshEpoch(@TempDir Path cwd) throws Exception {
        // The block-A guarantee, exercised end to end through the node path:
        // same sender id, two incarnations — the second run's restarted
        // sequence DELIVERS instead of being deduped into the void.
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            List<BusEnvelope> seen = Collections.synchronizedList(new ArrayList<>());
            CountDownLatch bothRunsEnded = new CountDownLatch(2);
            hub.subscribe(BusEnvelope.topicFor("fleet-r"), env -> {
                seen.add(env);
                if (env.payload() instanceof RunEvent.RunEnd) {
                    bothRunsEnded.countDown();
                }
            });

            for (long epoch = 1; epoch <= 2; epoch++) {
                int exit = NodeCommand.execute(JSON, CONFIG, oneAnswer("run " + epoch),
                        new NodeCommand.NodeSpec("127.0.0.1", hub.port(), "node-r", epoch,
                                "fleet-r", "worker", "scan", cwd, false, null),
                        new SessionStore(), line -> { });
                assertEquals(0, exit);
            }

            assertTrue(bothRunsEnded.await(10, TimeUnit.SECONDS),
                    "both incarnations' runs reached the hub whole");
            List<String> ids = seen.stream().map(BusEnvelope::id).toList();
            assertTrue(ids.contains("node-r#1#0") && ids.contains("node-r#2#0"),
                    "each incarnation starts its own stream at sequence 0 — and both deliver");
        }
    }
}
