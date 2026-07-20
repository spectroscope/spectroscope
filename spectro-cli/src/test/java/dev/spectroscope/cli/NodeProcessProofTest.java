package dev.spectroscope.cli;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.orchestrator.BusEnvelope;
import dev.spectroscope.orchestrator.NodeCard;
import dev.spectroscope.orchestrator.ProcessBusHub;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

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
}
