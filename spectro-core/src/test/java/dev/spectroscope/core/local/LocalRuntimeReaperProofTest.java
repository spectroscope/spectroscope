package dev.spectroscope.core.local;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * The honest half of "the handle destroys it on shutdown" (card 76): a REAL
 * child JVM runs a {@link LocalRuntime} whose launcher spawned a real OS
 * process (a {@code sleep}, standing in for {@code llama-server}). SIGTERM to
 * the JVM — how a spectro-server actually dies — must reap the grandchild.
 * Verified live 2026-07-25 that without a reaper it orphans; this test pins
 * the fix the process-proof way: show the PIDs, not a promise.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
@EnabledOnOs({OS.MAC, OS.LINUX})
class LocalRuntimeReaperProofTest {

    @Test
    void sigtermToTheJvmReapsTheLaunchedSubprocess() throws Exception {
        Process child = new ProcessBuilder(
                System.getProperty("java.home") + "/bin/java",
                "-Duser.home=" + System.getProperty("user.home"),
                "-cp", System.getProperty("java.class.path"),
                LocalReaperProofChild.class.getName())
                .redirectErrorStream(true)
                .start();
        ProcessHandle sleeper = null;
        try {
            long sleeperPid = -1;
            boolean ready = false;
            try (BufferedReader out = new BufferedReader(
                    new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while (!ready && (line = out.readLine()) != null) {
                    if (line.startsWith("sleeper-pid:")) {
                        sleeperPid = Long.parseLong(line.substring("sleeper-pid:".length()));
                    }
                    ready = "ready".equals(line);
                }
                assertTrue(ready, "the child JVM brings its runtime up");
                sleeper = ProcessHandle.of(sleeperPid).orElseThrow();
                assertTrue(sleeper.isAlive(), "the launched subprocess is alive under the child JVM");

                child.destroy(); // SIGTERM — exactly how the live orphan was produced
                assertTrue(child.waitFor(15, TimeUnit.SECONDS), "the child JVM exits on SIGTERM");
                try {
                    sleeper.onExit().get(10, TimeUnit.SECONDS);
                } catch (TimeoutException orphaned) {
                    fail("the launched subprocess survived JVM shutdown — orphaned, pid " + sleeperPid);
                }
            }
        } finally {
            if (sleeper != null && sleeper.isAlive()) {
                sleeper.destroyForcibly();
            }
            child.destroyForcibly();
        }
    }
}
