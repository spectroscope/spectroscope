package dev.spectroscope.core.launch;

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
 * The honest half of "everything this session started dies with it" (card 202).
 *
 * <p>A unit test can call {@code close()} and watch a pid go. It cannot show
 * what happens when nobody calls anything — and that is the case an orphaned dev
 * server comes from: the server process is SIGTERMed by whoever supervises it,
 * or the operator closes the app, and no {@code onClose} ever runs on the way
 * out. So a REAL child JVM starts a REAL tree and gets SIGTERMed, exactly the
 * way {@code LocalRuntimeReaperProofTest} does it for the local model runtime,
 * and both pids are asked whether they are gone.
 *
 * <p>The tree is a shell with a grandchild under it on purpose: that is the
 * shape {@code npm run dev} has, and killing only the shell leaves the dev
 * server holding the port with a new parent. Both halves of the promise are
 * therefore under this one test.
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS)
@EnabledOnOs({OS.MAC, OS.LINUX})
class LaunchSupervisorReaperProofTest {

    @Test
    void sigtermToTheJvmReapsTheLaunchedTreeIncludingItsGrandchild() throws Exception {
        Process child = new ProcessBuilder(
                System.getProperty("java.home") + "/bin/java",
                "-cp", System.getProperty("java.class.path"),
                LaunchReaperProofChild.class.getName())
                .redirectErrorStream(true)
                .start();
        ProcessHandle shell = null;
        ProcessHandle grandchild = null;
        try {
            long shellPid = -1;
            long grandchildPid = -1;
            boolean ready = false;
            try (BufferedReader out = new BufferedReader(
                    new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while (!ready && (line = out.readLine()) != null) {
                    if (line.startsWith("shell-pid:")) {
                        shellPid = Long.parseLong(line.substring("shell-pid:".length()));
                    } else if (line.startsWith("grandchild-pid:")) {
                        grandchildPid =
                                Long.parseLong(line.substring("grandchild-pid:".length()));
                    }
                    ready = "ready".equals(line);
                }
                assertTrue(ready, "the child JVM brings its launch tree up");
                shell = ProcessHandle.of(shellPid).orElseThrow();
                grandchild = ProcessHandle.of(grandchildPid).orElseThrow();
                assertTrue(shell.isAlive(), "the launched shell is alive, pid " + shellPid);
                assertTrue(grandchild.isAlive(),
                        "the grandchild holding the port is alive, pid " + grandchildPid);

                child.destroy(); // SIGTERM — exactly how a spectro-server dies
                assertTrue(child.waitFor(20, TimeUnit.SECONDS), "the child JVM exits on SIGTERM");
                try {
                    shell.onExit().get(15, TimeUnit.SECONDS);
                } catch (TimeoutException orphaned) {
                    fail("the launched shell survived JVM shutdown — orphaned, pid " + shellPid);
                }
                try {
                    grandchild.onExit().get(15, TimeUnit.SECONDS);
                } catch (TimeoutException orphaned) {
                    fail("the dev server under the shell survived JVM shutdown — it still holds "
                            + "its port, pid " + grandchildPid);
                }
            }
        } finally {
            if (grandchild != null && grandchild.isAlive()) {
                grandchild.destroyForcibly();
            }
            if (shell != null && shell.isAlive()) {
                shell.destroyForcibly();
            }
            child.destroyForcibly();
        }
    }
}
