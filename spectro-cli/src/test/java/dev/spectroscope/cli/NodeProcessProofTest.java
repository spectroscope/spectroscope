package dev.spectroscope.cli;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.orchestrator.BusEnvelope;
import dev.spectroscope.orchestrator.NodeCard;
import dev.spectroscope.orchestrator.ProcessBusHub;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The honest half of "a fleet spans real processes": a REAL child JVM runs
 * the node command's execute path against the parent's hub — distinct PIDs,
 * the node's card in the roster, the whole run stream in per-sender order,
 * and a wall-clock epoch. Show the PIDs, not a promise.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class NodeProcessProofTest {

    private static final String CTX = "fleet-proof";

    @Test
    void aChildJvmNodeRunsAgainstTheParentsHub() throws Exception {
        long testStart = System.currentTimeMillis();
        // Card 235: the child runs a REAL SessionStore, so where its session file
        // lands is part of the proof. The redirected home is this JVM's user.home
        // (the root subprojects block points it at build/test-home); the child gets
        // it as an explicit -Duser.home below, because a child JVM inherits no
        // system properties. Before the fix this child wrote into the operator's
        // real ~/.spectro/sessions on every suite run — 180+ files of debris.
        Path redirectedSessions = Path.of(System.getProperty("user.home"), ".spectro", "sessions");
        long sessionsBefore = countFiles(redirectedSessions);
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            List<BusEnvelope> seen = Collections.synchronizedList(new ArrayList<>());
            List<NodeCard> rosterAtFirstFrame = Collections.synchronizedList(new ArrayList<>());
            CountDownLatch runEnded = new CountDownLatch(1);
            hub.subscribe(BusEnvelope.topicFor(CTX), env -> {
                if (seen.isEmpty()) {
                    rosterAtFirstFrame.addAll(hub.roster());
                }
                seen.add(env);
                if (env.payload() instanceof RunEvent.RunEnd) {
                    runEnded.countDown();
                }
            });

            Process child = new ProcessBuilder(
                    System.getProperty("java.home") + "/bin/java",
                    "-Duser.home=" + System.getProperty("user.home"),
                    "-cp", System.getProperty("java.class.path"),
                    NodeProofChild.class.getName(),
                    String.valueOf(hub.port()), CTX, "node-child")
                    .inheritIO()
                    .start();

            assertTrue(runEnded.await(45, TimeUnit.SECONDS),
                    "the child node's whole run crossed the process boundary");
            assertTrue(child.waitFor(10, TimeUnit.SECONDS), "the child exits");
            assertEquals(0, child.exitValue(), "a regular end_turn exits 0 in the child too");

            String pidText = seen.stream()
                    .map(BusEnvelope::payload)
                    .filter(RunEvent.TextDelta.class::isInstance)
                    .map(event -> ((RunEvent.TextDelta) event).text())
                    .filter(text -> text.startsWith("pid:"))
                    .findFirst().orElseThrow();
            long childPid = Long.parseLong(pidText.substring("pid:".length()));
            assertEquals(childPid, child.pid(), "the answer carries the child's own PID");
            assertNotEquals(ProcessHandle.current().pid(), childPid,
                    "two distinct PIDs — the fleet boundary is real, not simulated");

            assertEquals(1, rosterAtFirstFrame.size(), "the node announced itself");
            NodeCard card = rosterAtFirstFrame.get(0);
            assertEquals("node-child", card.id());
            assertEquals(BusEnvelope.topicFor(CTX), card.topic());

            long sessionsAfter = countFiles(redirectedSessions);
            assertTrue(sessionsAfter > sessionsBefore,
                    "the child's session must land under the redirected home ("
                            + redirectedSessions + "): " + sessionsBefore + " files before,"
                            + " " + sessionsAfter + " after — a missing -Duser.home on the"
                            + " child means it wrote into the REAL ~/.spectro instead");

            long epoch = seen.get(0).epoch();
            assertTrue(epoch >= testStart && epoch <= System.currentTimeMillis(),
                    "the child stamps the REAL wall-clock source (NodeCommand.freshEpoch),"
                            + " bounded by this test's own clock: " + epoch);
            assertTrue(seen.stream().allMatch(env -> "node-child".equals(env.sender())));
            List<Long> sequences = seen.stream().map(BusEnvelope::sequence).toList();
            assertEquals(java.util.stream.LongStream.range(0, seen.size()).boxed().toList(),
                    sequences,
                    "the stream is whole AND gapless: sequences 0..n-1 in order — sortedness"
                            + " alone would let a dropped frame pass unnoticed");
        }
    }

    /** @return how many entries a directory holds; 0 when it does not exist yet */
    private static long countFiles(Path dir) throws IOException {
        if (!Files.isDirectory(dir)) {
            return 0;
        }
        try (Stream<Path> entries = Files.list(dir)) {
            return entries.count();
        }
    }
}
