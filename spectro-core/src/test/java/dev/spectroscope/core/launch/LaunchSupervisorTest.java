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
        try (LaunchSupervisor supervisor = LaunchSupervisor.real()) {
            LaunchSupervisor.Outcome outcome =
                    supervisor.start(entry, project, Duration.ofSeconds(30));
            assertTrue(outcome.ok(), "the tree came up: " + outcome.problem());
            long shell = outcome.running().pid();
            long grandchild = grandchildPid(supervisor);
            assertTrue(ProcessHandle.of(grandchild).map(ProcessHandle::isAlive).orElse(false),
                    "the grandchild holding the port is alive, pid " + grandchild);

            assertTrue(supervisor.stop("tree").stopped());

            assertTrue(waitForDeath(shell), "the shell died, pid " + shell);
            assertTrue(waitForDeath(grandchild),
                    "the grandchild died with it — otherwise it holds " + port
                            + " forever, pid " + grandchild);
            assertFalse(LaunchSupervisor.TCP_CONNECT.answers("127.0.0.1", port),
                    "and the port is free again");
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

        supervisor.close();

        assertTrue(waitForDeath(pid), "the session closing takes the server with it, pid " + pid);
        assertTrue(supervisor.running().isEmpty());
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
