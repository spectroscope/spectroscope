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
