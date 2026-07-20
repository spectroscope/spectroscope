package dev.spectroscope.orchestrator;

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
 * The honest half of "JSONL across the process boundary" (card 22): a REAL
 * child JVM — distinct PID, own ProcessBus — publishes through the parent's
 * hub into a local (aggregator-side) subscriber. The bus-proof pattern,
 * carried over: show the PIDs, not a promise. This test also pins the
 * drain-on-close guarantee — the child publishes and exits immediately, so
 * without the drain its tail frames would die with the process.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class ProcessBusProcessProofTest {

    private static final String CTX = "ctx-proof";

    @Test
    void aChildJvmPublishesAcrossTheRealProcessBoundary() throws Exception {
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            List<BusEnvelope> seen = Collections.synchronizedList(new ArrayList<>());
            CountDownLatch both = new CountDownLatch(2);
            hub.subscribe(BusEnvelope.topicFor(CTX), env -> {
                seen.add(env);
                both.countDown();
            });

            Process child = new ProcessBuilder(
                    System.getProperty("java.home") + "/bin/java",
                    "-cp", System.getProperty("java.class.path"),
                    ProcessProofChild.class.getName(),
                    String.valueOf(hub.port()), CTX)
                    .inheritIO()
                    .start();

            assertTrue(both.await(30, TimeUnit.SECONDS),
                    "two frames cross the real process boundary");
            assertTrue(child.waitFor(10, TimeUnit.SECONDS), "the child exits");
            assertEquals(0, child.exitValue(), "the child exits cleanly");

            String pidLine = seen.stream()
                    .map(env -> ((dev.spectroscope.core.events.RunEvent.TextDelta) env.payload()).text())
                    .filter(text -> text.startsWith("pid:"))
                    .findFirst().orElseThrow();
            long childPid = Long.parseLong(pidLine.substring("pid:".length()));
            assertEquals(childPid, child.pid(), "the frame carries the child's own PID");
            assertNotEquals(ProcessHandle.current().pid(), childPid,
                    "two distinct PIDs — the boundary is real, not simulated");
            assertEquals(List.of("node-child#0", "node-child#1"),
                    seen.stream().map(BusEnvelope::id).toList(),
                    "per-sender order survives the boundary");
        }
    }
}
