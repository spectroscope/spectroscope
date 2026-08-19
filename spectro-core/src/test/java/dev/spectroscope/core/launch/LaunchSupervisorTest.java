package dev.spectroscope.core.launch;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.Optional;
import java.net.ServerSocket;
import java.net.Socket;
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

    /**
     * A port this test KEEPS, and that provably answers nothing while it does.
     *
     * <p>{@link #freePort()} borrows a number and hands it straight back, so
     * from that line on the caller races every other process on this machine
     * for it — and this machine runs spectro servers and a second session's
     * builds beside the suite. That is fine for a test whose command is going
     * to bind the port itself. It is NOT fine for a test whose claim is that
     * nothing answers there: a stranger arriving in that window makes the
     * supervisor see an open port and report a start that already died as up.
     *
     * <p>This closes the window by never opening it. The socket is <b>bound and
     * never listened on</b>, which is the whole trick: bound means nobody else
     * can have the address, and not listening means every connect to it fails.
     * Measured on 2026-08-19, all four ways it could have leaked:
     *
     * <ul>
     *   <li>the probe gets no answer, on every attempt — the SYN is dropped;</li>
     *   <li>another {@code ServerSocket} on the loopback address is refused
     *       with {@code Address already in use};</li>
     *   <li>so is another PROCESS binding {@code 127.0.0.1}, even one asking
     *       for {@code SO_REUSEADDR};</li>
     *   <li>and the bind is aimed at whatever {@code localhost} resolves to
     *       rather than at {@link InetAddress#getLoopbackAddress()}, because
     *       {@code localhost} is the host the entry's address carries and so
     *       the one the probe will dial — asking the resolver the same
     *       question the probe asks keeps the two from being different
     *       addresses on a machine that answers it differently;</li>
     *   <li>and a WILDCARD listener — which is what {@code python3 -m
     *       http.server} is — does bind {@code 0.0.0.0} on that number, but
     *       still cannot answer {@code localhost}: the narrower loopback bind
     *       wins. Driven with a real {@code http.server}, the probe stayed
     *       silent.</li>
     * </ul>
     *
     * <p>So this is a reservation and not a wish, and the assertion below says
     * so out loud rather than trusting this paragraph.
     *
     * @return the bound socket, to be closed by the caller
     */
    private static Socket reservedAndSilent() throws IOException {
        Socket socket = new Socket();
        socket.bind(new InetSocketAddress(InetAddress.getByName("localhost"), 0));
        return socket;
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

    /**
     * Criterion 5: a port that never comes up is a failure that says so.
     *
     * <p><b>The port is held for the length of the test, and that is the point
     * of the shape.</b> This is the one test here that asserts something about
     * a port NOT answering, and it used to take its number from
     * {@link #freePort()} — which releases it. The supervisor decides a start
     * came up by seeing the port open, so between that release and the first
     * probe, anything on this machine that bound the number turned a start that
     * had already died into a start reported as up. Measured on 2026-08-19: it
     * failed exactly there inside a full {@code --rerun-tasks} run, on
     * {@code assertFalse(outcome.ok())}, and passed 3/3 when the class ran
     * alone. A borrowed number is not a fact about a port.
     *
     * <p>{@link #reservedAndSilent()} owns the number instead, so the claim
     * below is about this test's own port and nobody else's timing.
     *
     * <p>The margin on the clock is deliberately enormous, for the same reason
     * the one in {@code aSlowStartDoesNotHoldUpTheOtherConfigurations} is: the
     * honest path here is two probes at the 400 ms the reserved port costs each
     * — under a second — the budget it must not run to the end of is thirty
     * seconds, and the assertion allows ten. That measures a branch, not a
     * loaded machine.
     */
    @Test
    @EnabledOnOs({OS.MAC, OS.LINUX})
    void aCommandThatNeverAnswersFailsWithItsOwnOutput(@TempDir Path project) throws Exception {
        try (Socket reservation = reservedAndSilent()) {
            int port = reservation.getLocalPort();
            assertFalse(LaunchSupervisor.TCP_CONNECT.answers("localhost", port),
                    "the reservation really is silent on " + port + " — this test claims a start "
                            + "is refused BY that silence, so it has to be measured, not assumed");
            LaunchEntry entry = new LaunchEntry("broken", port, "/bin/sh",
                    List.of("-c", "echo 'Error: Cannot find module ./server' >&2; exit 1"),
                    null, List.of());
            try (LaunchSupervisor supervisor = LaunchSupervisor.real()) {
                long began = System.nanoTime();
                LaunchSupervisor.Outcome outcome =
                        supervisor.start(entry, project, Duration.ofSeconds(30));
                long tookMillis = (System.nanoTime() - began) / 1_000_000;

                assertFalse(outcome.ok());
                assertNull(outcome.running());
                assertTrue(outcome.problem().contains("exited with code 1"),
                        "the problem says the process died: " + outcome.problem());
                assertTrue(tookMillis < 10_000,
                        "the death is what ENDED the wait, after " + tookMillis + " ms — a dead "
                                + "process must not go on being waited for until the budget runs "
                                + "out. Deleting that branch left every assertion above green "
                                + "and only made the wait 30 seconds long, so the sentence "
                                + "\"exited with code 1\" alone pinned nothing.");
                assertTrue(outcome.tail().contains("Cannot find module"),
                        "the output it produced comes back with the failure: " + outcome.tail());
                assertTrue(supervisor.running().isEmpty(),
                        "a start that failed leaves nothing behind");
            }
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

    /**
     * A STRANGER on the port: bound, listening and accepting, owned by nobody
     * this session started.
     *
     * <p>Deliberately different from {@link #reservedAndSilent()}, which holds a
     * number that answers NOTHING. This one answers, which is the whole point:
     * the supervisor's evidence for "it came up" is a successful TCP connect,
     * and this socket supplies that evidence without a single line of the
     * command having run.
     *
     * @return the listening socket; close it to release the port
     * @throws IOException when the port cannot be taken
     */
    private static ServerSocket strangerOnAPort() throws IOException {
        ServerSocket stranger = new ServerSocket(0, 8, InetAddress.getLoopbackAddress());
        Thread accepter = new Thread(() -> {
            while (!stranger.isClosed()) {
                try (Socket ignored = stranger.accept()) {
                    // Answering IS the behaviour under test. Nothing is read or
                    // written: a connect that succeeds is all the supervisor asks.
                } catch (IOException closed) {
                    return;
                }
            }
        }, "stranger-on-the-port");
        accepter.setDaemon(true);
        accepter.start();
        return stranger;
    }

    /**
     * Card 286, criteria 2, 3 and 4: a stranger on the port cannot pass for the
     * app.
     *
     * <p>The owner's report was a launch that said "web is up on
     * http://localhost:5173/", opened the browser there, let the agent work
     * against that page — and then {@code launch_list} showed nothing running.
     * Both cannot be true, and the supervisor said both.
     *
     * <p>The three assertions are separate claims and are asserted separately.
     * That the start FAILS is one. That its answer carries the command's own
     * EADDRINUSE text is another, and it is the half that makes the failure
     * useful rather than merely correct. And that {@code launch_list} agrees is
     * a third: the defect this card is named for is not a wrong answer, it is
     * two answers from one object in the same instant.
     */
    @Test
    @EnabledOnOs({OS.MAC, OS.LINUX})
    void aStrangerOnThePortCannotPassForTheApp(@TempDir Path project) throws Exception {
        try (ServerSocket stranger = strangerOnAPort()) {
            int port = stranger.getLocalPort();
            assertTrue(LaunchSupervisor.TCP_CONNECT.answers("localhost", port),
                    "the stranger really does answer on " + port + " — this test claims a start "
                            + "is refused DESPITE that answer, so the answer has to be measured");

            LaunchEntry entry = new LaunchEntry("web", port, "/bin/sh",
                    List.of("-c", "echo 'Error: Port " + port + " is already in use' >&2; exit 1"),
                    null, List.of());
            try (LaunchSupervisor supervisor = LaunchSupervisor.real()) {
                LaunchSupervisor.Outcome outcome =
                        supervisor.start(entry, project, Duration.ofSeconds(30));

                assertFalse(outcome.ok(),
                        "a port answering proves nothing about the process we started: "
                                + outcome.running());
                assertNull(outcome.running(),
                        "no address is earned here, and LaunchTools points a browser at whatever "
                                + "this holds");
                assertTrue(outcome.tail().contains("already in use"),
                        "the answer has to carry the command's OWN words, or the operator is told "
                                + "a start failed and not why: " + outcome.tail());
                assertEquals(Optional.empty(), supervisor.running("web"),
                        "start() and launch_list have to agree — two answers from one object in "
                                + "the same instant is the defect this card is named for");
            }
        }
    }

    /**
     * Card 286, criterion 6: the narrowing of rule B, measured rather than
     * asserted in prose.
     *
     * <p>This is the case that made the unnarrowed fix wrong and got it
     * reverted. An entry carrying BOTH a url and a command is the ordinary
     * shape for a proxy already listening while the command serves behind it.
     * Under rule A that start waits out its budget, reports failure, and
     * {@code spawn()} reaps on the way out — killing a dev server that was
     * working.
     *
     * <p>So the assertion is that the pre-spawn sample does NOT apply here: the
     * url answers before the command runs, and the start still succeeds. Take
     * the narrowing out of the supervisor and this goes red while the stranger
     * test above stays green, which is what makes the two claims separable.
     */
    @Test
    @EnabledOnOs({OS.MAC, OS.LINUX})
    void aProxyAlreadyAnsweringOnAStatedUrlIsTheIntendedShape(@TempDir Path project)
            throws Exception {
        try (ServerSocket proxy = strangerOnAPort()) {
            int port = proxy.getLocalPort();
            String url = "http://localhost:" + port + "/";
            assertTrue(LaunchSupervisor.TCP_CONNECT.answers("localhost", port),
                    "the proxy answers before anything is spawned — that is the premise");

            // A command that stays alive and binds nothing: the work happens
            // behind the proxy, which is the whole point of the shape.
            LaunchEntry entry = new LaunchEntry("app", null, "/bin/sh",
                    List.of("-c", "sleep 30"), url, List.of());
            assertFalse(entry.addressIsPortDerived(),
                    "a stated url is not port-derived, and rule B turns on exactly that");

            try (LaunchSupervisor supervisor = LaunchSupervisor.real()) {
                LaunchSupervisor.Outcome outcome =
                        supervisor.start(entry, project, Duration.ofSeconds(10));
                assertTrue(outcome.ok(),
                        "rule A would have failed this start and then reaped a working server: "
                                + outcome.problem());
                assertEquals(url, outcome.running().address());
                assertTrue(supervisor.running("app").isPresent(),
                        "and launch_list agrees, in this direction too");
            }
        }
    }

    /**
     * The distinction rule B rests on, as a unit, so a future edit to
     * {@code address()} cannot quietly move it.
     */
    @Test
    void anEntrySaysWhetherItsAddressWasDerivedOrStated() {
        assertTrue(new LaunchEntry("a", 5173, "x", List.of(), null, List.of())
                .addressIsPortDerived());
        assertFalse(new LaunchEntry("b", 5173, "x", List.of(), "http://localhost:9/", List.of())
                .addressIsPortDerived(),
                "a stated url wins over a port, exactly as address() resolves it");
        assertFalse(new LaunchEntry("c", null, "x", List.of(), null, List.of())
                .addressIsPortDerived(), "no address at all is not port-derived");
        assertFalse(new LaunchEntry("d", 5173, "x", List.of(), "   ", List.of())
                .addressIsPortDerived() == false,
                "a blank url is not a stated one — address() falls through to the port");
    }
}