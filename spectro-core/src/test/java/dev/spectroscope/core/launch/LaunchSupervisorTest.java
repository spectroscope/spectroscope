package dev.spectroscope.core.launch;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * What starting and stopping actually do (card 202, criteria 2, 3, 4 and 5).
 *
 * <p>The port every test here uses is taken from the OS at test time, never
 * written down: a fixed number would collide with whatever the operator has
 * running, and this suite runs on his machine.
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS)
class LaunchSupervisorTest {

    /** A free port, taken and released — the OS will not hand it out twice in a row. */
    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    // ---- starting ------------------------------------------------------------

    /** A real server, a real port, and "up" means the port answers. */
    @Test
    @EnabledOnOs({OS.MAC, OS.LINUX})
    void aRealCommandComesUpAndTheAddressAnswers(@TempDir Path project) throws Exception {
        int port = freePort();
        Files.writeString(project.resolve("index.html"), "<h1>under test</h1>");
        LaunchEntry entry = new LaunchEntry("web", port, "python3",
                List.of("-m", "http.server", String.valueOf(port)), null, List.of());
        try (LaunchSupervisor supervisor = LaunchSupervisor.real()) {
            LaunchSupervisor.Outcome outcome =
                    supervisor.start(entry, project, Duration.ofSeconds(30));
            assertTrue(outcome.ok(), "the server came up: " + outcome.problem());
            assertNotNull(outcome.running());
            assertEquals("http://localhost:" + port + "/", outcome.running().address());
            assertFalse(outcome.running().attached(), "we started it, so we own it");
            assertTrue(outcome.running().pid() > 0);
            assertTrue(LaunchSupervisor.TCP_CONNECT.answers("127.0.0.1", port),
                    "the port really answers, not just our record of it");
        }
    }

    /** Criterion 5: a port that never comes up is a failure that says so. */
    @Test
    @EnabledOnOs({OS.MAC, OS.LINUX})
    void aCommandThatNeverAnswersFailsWithItsOwnOutput(@TempDir Path project) throws Exception {
        int port = freePort();
        LaunchEntry entry = new LaunchEntry("broken", port, "/bin/sh",
                List.of("-c", "echo 'Error: Cannot find module ./server' >&2; exit 1"),
                null, List.of());
        try (LaunchSupervisor supervisor = LaunchSupervisor.real()) {
            LaunchSupervisor.Outcome outcome =
                    supervisor.start(entry, project, Duration.ofSeconds(10));
            assertFalse(outcome.ok());
            assertNull(outcome.running());
            assertTrue(outcome.problem().contains("exited with code 1"),
                    "the problem says the process died: " + outcome.problem());
            assertTrue(outcome.tail().contains("Cannot find module"),
                    "the output it produced comes back with the failure: " + outcome.tail());
            assertTrue(supervisor.running().isEmpty(),
                    "a start that failed leaves nothing behind");
        }
    }

    /** Criterion 2: a url with no command attaches, and attaching starts nothing. */
    @Test
    void aUrlOnlyEntryAttachesWhenTheAddressAnswers() {
        LaunchEntry entry = new LaunchEntry("already-up", 4321, null, List.of(),
                "http://localhost:4321/health", List.of());
        LaunchSupervisor supervisor = new LaunchSupervisor((host, port) -> port == 4321);
        LaunchSupervisor.Outcome outcome =
                supervisor.start(entry, Path.of("."), Duration.ofSeconds(1));
        assertTrue(outcome.ok());
        assertTrue(outcome.running().attached(), "nothing was spawned for it");
        assertEquals(-1, outcome.running().pid(), "there is no pid to have");
        assertEquals("http://localhost:4321/health", outcome.running().address());
        supervisor.close();
    }

    /** Criterion 5: an attach address that answers nothing is refused by that address. */
    @Test
    void anAttachEntryWhoseAddressAnswersNothingFails() {
        LaunchEntry entry = new LaunchEntry("ghost", 4321, null, List.of(),
                "http://localhost:4321/", List.of());
        LaunchSupervisor supervisor = new LaunchSupervisor((host, port) -> false);
        LaunchSupervisor.Outcome outcome =
                supervisor.start(entry, Path.of("."), Duration.ofMillis(200));
        assertFalse(outcome.ok());
        assertEquals("nothing answered there", outcome.problem());
        supervisor.close();
    }

    // ---- stopping ------------------------------------------------------------

    /**
     * The defect this whole class exists for: {@code npm run dev} is a shell that
     * spawns the dev server, and killing the shell alone leaves the server holding
     * the port. Driven here with a shell that spawns a sleeper, and both PIDs are
     * asked whether they are alive rather than being assumed dead.
     *
     * <p><b>The cleanup is a {@code finally} and not the try-with-resources, and
     * that is the point of the shape.</b> {@code stop("tree")} takes the entry
     * out of the supervisor, so from that line onwards {@code close()} has
     * nothing left to reap and the two PIDs are this test's own problem. When the
     * grandchild assertion below failed — which is exactly what a break-once
     * round makes it do — the shell and the dev server outlived the JVM and kept
     * the port for good. A review found two such orphans on the operator's
     * machine, both of them {@code python3 -m http.server} in a {@code @TempDir},
     * one of them from this very test. A test that proves reaping must not leak
     * when it fails.
     */
    @Test
    @EnabledOnOs({OS.MAC, OS.LINUX})
    void stoppingTakesTheWholeTreeNotJustTheShell(@TempDir Path project) throws Exception {
        int port = freePort();
        // The shell starts a server in the background and then waits: the port is
        // held by a GRANDCHILD, exactly like npm run dev holds it through Vite.
        LaunchEntry entry = new LaunchEntry("tree", port, "/bin/sh",
                List.of("-c", "python3 -m http.server " + port + " & echo grandchild:$!; wait"),
                null, List.of());
        long shell = -1;
        long grandchild = -1;
        try (LaunchSupervisor supervisor = LaunchSupervisor.real()) {
            LaunchSupervisor.Outcome outcome =
                    supervisor.start(entry, project, Duration.ofSeconds(30));
            assertTrue(outcome.ok(), "the tree came up: " + outcome.problem());
            shell = outcome.running().pid();
            grandchild = grandchildPid(supervisor);
            assertTrue(ProcessHandle.of(grandchild).map(ProcessHandle::isAlive).orElse(false),
                    "the grandchild holding the port is alive, pid " + grandchild);

            assertTrue(supervisor.stop("tree").stopped());

            assertTrue(waitForDeath(shell), "the shell died, pid " + shell);
            assertTrue(waitForDeath(grandchild),
                    "the grandchild died with it — otherwise it holds " + port
                            + " forever, pid " + grandchild);
            assertFalse(LaunchSupervisor.TCP_CONNECT.answers("127.0.0.1", port),
                    "and the port is free again");
        } finally {
            killWhateverSurvived(shell, grandchild);
        }
    }

    /** Criterion 4, the other half: close() ends everything the session started. */
    @Test
    @EnabledOnOs({OS.MAC, OS.LINUX})
    void closingTheSupervisorEndsEverythingItStarted(@TempDir Path project) throws Exception {
        int port = freePort();
        LaunchEntry entry = new LaunchEntry("web", port, "python3",
                List.of("-m", "http.server", String.valueOf(port)), null, List.of());
        LaunchSupervisor supervisor = LaunchSupervisor.real();
        LaunchSupervisor.Outcome outcome = supervisor.start(entry, project, Duration.ofSeconds(30));
        assertTrue(outcome.ok(), "the server came up: " + outcome.problem());
        long pid = outcome.running().pid();
        try {
            supervisor.close();

            assertTrue(waitForDeath(pid),
                    "the session closing takes the server with it, pid " + pid);
            assertTrue(supervisor.running().isEmpty());
        } finally {
            // close() already emptied the supervisor, so a failed assertion above
            // leaves this pid with nobody to reap it. Same lesson as the tree test.
            killWhateverSurvived(pid);
        }
    }

    /** The open owner call, held open: an attached entry is never signalled. */
    @Test
    void stoppingAnAttachedEntryIsRefusedRatherThanGuessed() {
        LaunchEntry entry = new LaunchEntry("already-up", 4321, null, List.of(),
                "http://localhost:4321/", List.of());
        LaunchSupervisor supervisor = new LaunchSupervisor((host, port) -> true);
        assertTrue(supervisor.start(entry, Path.of("."), Duration.ofSeconds(1)).ok());

        LaunchSupervisor.Stopped stopped = supervisor.stop("already-up");
        assertTrue(stopped.known());
        assertTrue(stopped.wasAttached());
        assertFalse(stopped.stopped(), "nothing spectroscope did not start is signalled");
        assertTrue(supervisor.running("already-up").isPresent(),
                "and the attachment is still held, so the owner's decision is still open");
        supervisor.close();
    }

    /** A name nothing is running under is not a silent no-op. */
    @Test
    void stoppingSomethingThatWasNeverStartedSaysSo() {
        LaunchSupervisor supervisor = new LaunchSupervisor((host, port) -> false);
        LaunchSupervisor.Stopped stopped = supervisor.stop("never-heard-of-it");
        assertFalse(stopped.known());
        assertFalse(stopped.stopped());
        supervisor.close();
    }

    // ---- logs ----------------------------------------------------------------

    /** Criterion 3: the output of what we started is readable. */
    @Test
    @EnabledOnOs({OS.MAC, OS.LINUX})
    void theOutputOfAStartedProcessIsReadable(@TempDir Path project) throws Exception {
        int port = freePort();
        LaunchEntry entry = new LaunchEntry("noisy", port, "/bin/sh",
                List.of("-c", "echo 'VITE ready in 231 ms'; exec python3 -m http.server " + port),
                null, List.of());
        try (LaunchSupervisor supervisor = LaunchSupervisor.real()) {
            assertTrue(supervisor.start(entry, project, Duration.ofSeconds(30)).ok());
            String text = "";
            for (int attempt = 0; attempt < 50 && text.isBlank(); attempt++) {
                text = supervisor.logs("noisy", 10).text();
                if (text.isBlank()) {
                    TimeUnit.MILLISECONDS.sleep(100);
                }
            }
            assertTrue(text.contains("VITE ready"), "what it printed comes back: " + text);
        }
    }

    /** Criterion 3, the honest half: an attached entry has no log, not an empty one. */
    @Test
    void anAttachedEntryHasNoLogRatherThanAnEmptyOne() {
        LaunchEntry entry = new LaunchEntry("already-up", 4321, null, List.of(),
                "http://localhost:4321/", List.of());
        LaunchSupervisor supervisor = new LaunchSupervisor((host, port) -> true);
        assertTrue(supervisor.start(entry, Path.of("."), Duration.ofSeconds(1)).ok());
        LaunchSupervisor.LogView view = supervisor.logs("already-up", 10);
        assertTrue(view.known());
        assertTrue(view.attached(), "the caller can tell 'no process' from 'nothing printed'");
        supervisor.close();
    }

    /** A name that is not up has no log view at all. */
    @Test
    void anUnknownNameHasNoLogView() {
        LaunchSupervisor supervisor = new LaunchSupervisor((host, port) -> false);
        assertFalse(supervisor.logs("web", 10).known());
        supervisor.close();
    }

    // ---- a configuration that died -------------------------------------------

    /**
     * A read may not destroy a record. {@code running(name)} used to evict a dead
     * entry and its whole log ring as a side effect of being asked a question,
     * and {@code launch_list} asks it once per configuration — so the listing
     * between a crash and a log request threw the crash away.
     *
     * <p>The process picks its own exit code and dies on a file rather than a
     * timer, so this is the same sequence on a loaded machine as on an idle one.
     */
    @Test
    @EnabledOnOs({OS.MAC, OS.LINUX})
    void askingWhetherADeadConfigurationIsRunningDoesNotDestroyItsLog(@TempDir Path project)
            throws Exception {
        int port = freePort();
        LaunchEntry entry = new LaunchEntry("web", port, "/bin/sh",
                List.of("-c", "echo 'FATAL: Cannot find module ./server'; "
                        + "python3 -m http.server " + port + " & SRV=$!; "
                        + "while [ ! -f die ]; do sleep 0.05; done; kill $SRV; exit 3"),
                null, List.of());
        long pid = -1;
        try (LaunchSupervisor supervisor = LaunchSupervisor.real()) {
            assertTrue(supervisor.start(entry, project, Duration.ofSeconds(30)).ok());
            pid = supervisor.running("web").orElseThrow().pid();
            Files.writeString(project.resolve("die"), "now");
            assertTrue(waitForDeath(pid), "the server died on cue, pid " + pid);

            assertTrue(supervisor.running("web").isEmpty(), "it is not running any more");
            assertEquals(3, supervisor.exited("web").orElseThrow().code(),
                    "and the exit code it chose is readable");

            // The question that used to be the destructive one, asked twice.
            supervisor.running("web");
            supervisor.running();

            LaunchSupervisor.LogView view = supervisor.logs("web", 100);
            assertTrue(view.known(), "the record survived being read: " + view);
            assertEquals(3, view.exitCode().intValue());
            assertTrue(view.text().contains("Cannot find module"),
                    "and so did what it printed: " + view.text());
        } finally {
            killWhateverSurvived(pid);
        }
    }

    /** Stopping is the one verb that discards a dead record, and it says so. */
    @Test
    @EnabledOnOs({OS.MAC, OS.LINUX})
    void stoppingAConfigurationThatAlreadyDiedReportsItsCodeAndDropsIt(@TempDir Path project)
            throws Exception {
        int port = freePort();
        LaunchEntry entry = new LaunchEntry("web", port, "/bin/sh",
                List.of("-c", "python3 -m http.server " + port + " & SRV=$!; "
                        + "while [ ! -f die ]; do sleep 0.05; done; kill $SRV; exit 7"),
                null, List.of());
        long pid = -1;
        try (LaunchSupervisor supervisor = LaunchSupervisor.real()) {
            assertTrue(supervisor.start(entry, project, Duration.ofSeconds(30)).ok());
            pid = supervisor.running("web").orElseThrow().pid();
            Files.writeString(project.resolve("die"), "now");
            assertTrue(waitForDeath(pid));

            LaunchSupervisor.Stopped stopped = supervisor.stop("web");
            assertTrue(stopped.known());
            assertFalse(stopped.stopped(), "nothing was signalled — it was already gone");
            assertEquals(7, stopped.exitCode().intValue());
            assertFalse(supervisor.logs("web", 10).known(),
                    "and the stop is what finally drops the record");
        } finally {
            killWhateverSurvived(pid);
        }
    }

    /** A restart replaces a dead record rather than tripping over it. */
    @Test
    @EnabledOnOs({OS.MAC, OS.LINUX})
    void startingAgainAfterADeathReplacesTheDeadRecord(@TempDir Path project) throws Exception {
        int port = freePort();
        Files.writeString(project.resolve("index.html"), "<h1>under test</h1>");
        LaunchEntry dies = new LaunchEntry("web", port, "/bin/sh",
                List.of("-c", "python3 -m http.server " + port + " & SRV=$!; "
                        + "while [ ! -f die ]; do sleep 0.05; done; kill $SRV; exit 3"),
                null, List.of());
        LaunchEntry lives = new LaunchEntry("web", port, "python3",
                List.of("-m", "http.server", String.valueOf(port)), null, List.of());
        long first = -1;
        try (LaunchSupervisor supervisor = LaunchSupervisor.real()) {
            assertTrue(supervisor.start(dies, project, Duration.ofSeconds(30)).ok());
            first = supervisor.running("web").orElseThrow().pid();
            Files.writeString(project.resolve("die"), "now");
            assertTrue(waitForDeath(first));
            assertTrue(supervisor.exited("web").isPresent());

            assertTrue(supervisor.start(lives, project, Duration.ofSeconds(30)).ok(),
                    "a dead record does not block the same name coming back");
            assertTrue(supervisor.exited("web").isEmpty(), "and it is not still remembered dead");
            assertFalse(first == supervisor.running("web").orElseThrow().pid());
        } finally {
            killWhateverSurvived(first);
        }
    }

    // ---- one lock per name ---------------------------------------------------

    /**
     * A start holds a monitor for as long as it waits for a port — up to the 180
     * seconds {@code LaunchTools} allows. While that monitor was {@code this},
     * every launch verb on every OTHER configuration queued behind it: an
     * {@code npm run dev} that was never going to answer made {@code launch_stop}
     * on an unrelated server wait out the whole budget.
     *
     * <p>The margin is deliberately enormous — the blocked version waits twelve
     * seconds, the assertion allows four — so this measures a lock and not a
     * loaded machine.
     */
    @Test
    @EnabledOnOs({OS.MAC, OS.LINUX})
    void aSlowStartDoesNotHoldUpTheOtherConfigurations(@TempDir Path project) throws Exception {
        int quiet = freePort();
        int other = freePort();
        LaunchEntry neverAnswers = new LaunchEntry("slow", quiet, "/bin/sh",
                List.of("-c", "sleep 30"), null, List.of());
        LaunchEntry realServer = new LaunchEntry("other", other, "python3",
                List.of("-m", "http.server", String.valueOf(other)), null, List.of());
        try (LaunchSupervisor supervisor = LaunchSupervisor.real()) {
            assertTrue(supervisor.start(realServer, project, Duration.ofSeconds(30)).ok());

            Thread slow = new Thread(() ->
                    supervisor.start(neverAnswers, project, Duration.ofSeconds(12)), "slow-start");
            slow.setDaemon(true);
            slow.start();
            for (int attempt = 0; attempt < 100 && supervisor.running("slow").isEmpty(); attempt++) {
                TimeUnit.MILLISECONDS.sleep(50);
            }
            assertTrue(supervisor.running("slow").isPresent(),
                    "the slow start is spawned and inside its port wait");

            long began = System.nanoTime();
            assertTrue(supervisor.stop("other").stopped());
            long tookMillis = (System.nanoTime() - began) / 1_000_000;

            assertTrue(tookMillis < 4_000,
                    "stopping \"other\" waited " + tookMillis + " ms behind a start of \"slow\" "
                            + "— one monitor for every name is the defect");
            slow.interrupt();
        }
    }

    // ---- helpers -------------------------------------------------------------

    /** The grandchild pid the shell echoed, read out of the captured output. */
    private static long grandchildPid(LaunchSupervisor supervisor) throws InterruptedException {
        for (int attempt = 0; attempt < 100; attempt++) {
            for (String line : supervisor.logs("tree", 0).text().split("\n")) {
                if (line.startsWith("grandchild:")) {
                    return Long.parseLong(line.substring("grandchild:".length()).strip());
                }
            }
            TimeUnit.MILLISECONDS.sleep(100);
        }
        throw new AssertionError("the shell never announced its grandchild");
    }

    /**
     * The safety net for any test that takes a process out of the supervisor
     * before it is finished asserting things about it. A failed assertion must
     * not hand the operator's machine a dev server nobody owns.
     */
    private static void killWhateverSurvived(long... pids) {
        for (long pid : pids) {
            if (pid > 0) {
                ProcessHandle.of(pid).filter(ProcessHandle::isAlive)
                        .ifPresent(ProcessHandle::destroyForcibly);
            }
        }
    }

    /** Whether a pid is gone within ten seconds. */
    private static boolean waitForDeath(long pid) throws InterruptedException {
        for (int attempt = 0; attempt < 100; attempt++) {
            if (ProcessHandle.of(pid).map(handle -> !handle.isAlive()).orElse(true)) {
                return true;
            }
            TimeUnit.MILLISECONDS.sleep(100);
        }
        return false;
    }
}
