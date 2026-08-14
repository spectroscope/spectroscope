package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 221: an MCP server that spawns and never speaks used to take the face with
 * it. The read timed out on schedule, the timeout path poisoned the channel, the
 * poison tore it down, the teardown closed the reader — and
 * {@code BufferedReader.close} parked on the very lock the reader thread was
 * holding inside {@code readLine} on a pipe nobody would ever write to. The
 * handler deadlocked against the read it exists to abandon, so the documented
 * bound was not merely exceeded, it was unreachable.
 *
 * <p>Everything here runs against a <b>real spawned process</b>
 * ({@link MuteMcpServerFixture}) over real pipes. The in-memory {@code Piped}
 * tests next door cannot stage this and never could: {@code PipedReader.read}
 * gives up on its own after a couple of one-second waits and it honours an
 * interrupt, so its lock is always released. A process pipe does neither.
 *
 * <p>Every test carries {@code @Timeout} on {@link Timeout.ThreadMode#SEPARATE_THREAD}
 * deliberately. The default mode sets its deadline by <b>interrupt</b>, and this
 * code path parks on a lock rather than on anything interruptible — under the
 * default mode a hung test becomes an infinite one and the build never ends.
 */
@Timeout(value = 40, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class McpMuteServerRealProcessTest {

    /** Short stand-in for the shipped 20 s read bound, so the suite stays quick. */
    private static final Duration BOUND = Duration.ofSeconds(2);

    /**
     * What the whole probe may take, in the shape the shipped budget has: the read
     * bound plus the teardown tail. Derived rather than typed, so a change to either
     * constant moves the test with it instead of leaving a number nobody re-derives.
     */
    private static final long BUDGET_MS = BOUND.plus(StdioTransport.TEARDOWN_TAIL).toMillis();

    /**
     * The same for a server behind a shell wrapper: two processes to start instead of
     * one, and a teardown that may spend its grace on each of them. Deliberately loose —
     * this budget is a hang-guard, and the wrapper tests are about the pid, not the clock.
     */
    private static final long WRAPPED_BUDGET_MS = BUDGET_MS + 5_000;

    @Test
    void aServerThatSpawnsAndNeverSpeaksIsReportedUnreachableWithinTheBound(@TempDir Path tmp)
            throws Exception {
        Path pidFile = tmp.resolve("mute.pid");
        List<String> command = fixtureCommand(pidFile);
        assumeTrue(command != null, "cannot locate the fixture classpath; skipping");

        McpServerConfig mute = new McpServerConfig(
                "mute", command.getFirst(), command.subList(1, command.size()), null, null, null);

        long startedAt = System.nanoTime();
        McpServerRegistry registry = McpServerRegistry.load(
                List.of(mute), tmp, config -> new StdioTransport(config, tmp, BOUND));
        long elapsedMs = millisSince(startedAt);
        try {
            assertTrue(elapsedMs < BUDGET_MS,
                    "the probe must come back inside the bound; it took " + elapsedMs + " ms");
            assertEquals(1, registry.servers().size(), "the mute server still gets a status row");
            var handle = registry.servers().getFirst();
            assertEquals("mute", handle.name(), "the row names the server");
            assertFalse(handle.reachable(), "a server that never answered is not reachable");
            assertTrue(registry.tools().isEmpty(), "an unreachable server advertises nothing");

            // Criterion 6: a generic failure would satisfy the timing and fail the product.
            assertNotNull(handle.failure(), "an unreachable row must carry its reason");
            assertTrue(handle.failure().contains("no answer"),
                    "the reason must say the server did not answer, got: " + handle.failure());
            assertTrue(handle.failure().contains("initialize"),
                    "the reason must name the exchange that went unanswered, got: " + handle.failure());
            assertTrue(handle.failure().contains(String.valueOf(BOUND.toMillis())),
                    "the reason must carry the bound it waited, got: " + handle.failure());
        } finally {
            registry.close();
        }
    }

    @Test
    void aMuteServerThatTimedOutLeavesNoChildProcessBehind(@TempDir Path tmp) throws Exception {
        Path pidFile = tmp.resolve("mute.pid");
        List<String> command = fixtureCommand(pidFile);
        assumeTrue(command != null, "cannot locate the fixture classpath; skipping");

        McpServerConfig mute = new McpServerConfig(
                "mute", command.getFirst(), command.subList(1, command.size()), null, null, null);

        McpServerRegistry registry = McpServerRegistry.load(
                List.of(mute), tmp, config -> new StdioTransport(config, tmp, BOUND));
        registry.close();

        // Look for the process, do not assert that close() was called on something.
        long pid = pidOf(pidFile);
        Optional<ProcessHandle> child = ProcessHandle.of(pid);
        assertFalse(child.isPresent() && child.get().isAlive(),
                "the spawned server (pid " + pid + ") is still running after the timeout");
    }

    @Test
    void aMuteServerBehindAWrapperLeavesNoGrandchildBehind(@TempDir Path tmp) throws Exception {
        // The direct child is the easy case and almost nobody configures it. npx, uvx,
        // a .sh wrapper, /bin/sh -c: the published MCP servers arrive behind a launcher,
        // and then the server is a GRANDCHILD. Destroying the process spectroscope
        // spawned kills the launcher; the grandchild is reparented to init and lives on.
        // Measured before this guard existed: two runs, two orphans, ppid 1, accumulating.
        //
        // It is an orphan defect and NOT a second hang, which is worth writing down
        // because the opposite is the natural guess: the grandchild does inherit the
        // stdout pipe, so one would expect the parked readLine to stay parked. It does
        // not. Reaping the direct child is enough — measured at 2 ms with the grandchild
        // still alive — because the JDK's process reaper retires the stream on exit.
        // A test asserting the reader leaves here would be green in both directions.
        Path pidFile = tmp.resolve("wrapped.pid");
        List<String> command = wrappedFixtureCommand(pidFile, "mute");
        assumeTrue(command != null, "cannot locate the fixture classpath; skipping");

        McpServerConfig wrapped = new McpServerConfig(
                "wrapped", command.getFirst(), command.subList(1, command.size()), null, null, null);

        long startedAt = System.nanoTime();
        McpServerRegistry registry = McpServerRegistry.load(
                List.of(wrapped), tmp, config -> new StdioTransport(config, tmp, BOUND));
        long elapsedMs = millisSince(startedAt);
        try {
            assertTrue(elapsedMs < WRAPPED_BUDGET_MS,
                    "a wrapped mute server must still come back; it took " + elapsedMs + " ms");
            assertFalse(registry.servers().getFirst().reachable(),
                    "a server that never answered is not reachable, wrapper or not");
        } finally {
            registry.close();
        }

        // The pid in the file is the fixture's own — the grandchild, not the /bin/sh
        // spectroscope spawned. Look for THAT one.
        long grandchild = pidOf(pidFile);
        Optional<ProcessHandle> survivor = ProcessHandle.of(grandchild);
        assertFalse(survivor.isPresent() && survivor.get().isAlive(),
                "the real server (grandchild pid " + grandchild + ") outlived the wrapper"
                        + " spectroscope killed; it is now reparented to init and accumulating");
    }

    @Test
    void aHealthyCloseGivesTheServerEndOfStreamAndAWindowBeforeAnySignal(@TempDir Path tmp)
            throws Exception {
        // The MCP stdio shutdown sequence is: close the client's stdin, wait for the
        // server to leave, THEN SIGTERM, THEN SIGKILL. Card 221's first fix put the
        // destroy at the front of the teardown — right for a server that had gone mute,
        // wrong for every other close: a server that flushes on end-of-stream lost the
        // chance, and one that logs SIGTERM as abnormal recorded every clean disconnect
        // as a kill. Neither shows up in a wall time or an exit code.
        //
        // The measurement is a GAP, not a word. On Unix, Process.destroy() signals and
        // then closes the streams, so a killed child sees end-of-stream too, some
        // milliseconds later — which of its own threads notices first is a coin toss.
        // What is not a coin toss is how long it had: a whole grace period when the
        // sequence is right, and nothing at all when the signal leads.
        Path pidFile = tmp.resolve("polite.pid");
        List<String> command = fixtureCommand(pidFile, "polite");
        assumeTrue(command != null, "cannot locate the fixture classpath; skipping");

        McpServerConfig polite = new McpServerConfig(
                "polite", command.getFirst(), command.subList(1, command.size()), null, null, null);

        McpServerRegistry registry = McpServerRegistry.load(
                List.of(polite), tmp, config -> new StdioTransport(config, tmp, BOUND));
        assertTrue(registry.servers().getFirst().reachable(),
                "the polite fixture answers the handshake; if it did not, this test proves nothing");
        long pid = pidOf(pidFile);

        registry.close();

        Optional<ProcessHandle> child = ProcessHandle.of(pid);
        assertFalse(child.isPresent() && child.get().isAlive(),
                "a healthy close must still end the server (pid " + pid + ")");

        List<String> events = shutdownEvents(Path.of(pidFile + ".exit"));
        Long eof = timestampOf(events, "STDIN-EOF");
        Long signal = timestampOf(events, "SIGNAL");
        assertNotNull(eof, "the server never saw end-of-stream at all before it was ended; it"
                + " recorded " + events);
        long windowMs = signal == null ? Long.MAX_VALUE : (signal - eof) / 1_000_000;
        assertTrue(windowMs >= 200,
                "the server was signalled " + windowMs + " ms after end-of-stream — the polite"
                        + " half of the stdio shutdown sequence is missing, so a server that"
                        + " flushes on EOF never gets to; it recorded " + events);
    }

    @Test
    void theProcessTreeIsCountedBeforeStdinIsClosedAndNotAfter(@TempDir Path tmp) throws Exception {
        // The ordering decision, pinned. Closing stdin first is what the MCP shutdown
        // sequence asks for, but a launcher that exits on end-of-stream — a wrapper
        // around `cat`, npx forwarding stdin, any `sh -c "server & wait"` shape — is gone
        // by the time anything asks it to name its children, and Process.descendants()
        // of a reaped process is empty. The grandchild is then reparented to init and
        // lives on, which is exactly the hole the previous round closed. So the census
        // is taken FIRST, while the launcher can still answer, and only then does stdin
        // close. Read the teardown as: count the tree, say goodbye, wait, kill.
        Path pidFile = tmp.resolve("selfexit.pid");
        List<String> command = wrapperThatLeavesOnStdinEof(pidFile);
        assumeTrue(command != null, "cannot locate the fixture classpath or /bin/sh; skipping");

        McpServerConfig wrapped = new McpServerConfig(
                "selfexit", command.getFirst(), command.subList(1, command.size()), null, null, null);

        long startedAt = System.nanoTime();
        McpServerRegistry registry = McpServerRegistry.load(
                List.of(wrapped), tmp, config -> new StdioTransport(config, tmp, BOUND));
        long elapsedMs = millisSince(startedAt);
        try {
            assertTrue(elapsedMs < WRAPPED_BUDGET_MS,
                    "a wrapper that leaves on EOF must still come back; it took " + elapsedMs + " ms");
        } finally {
            registry.close();
        }

        long grandchild = pidOf(pidFile);
        Optional<ProcessHandle> survivor = ProcessHandle.of(grandchild);
        assertFalse(survivor.isPresent() && survivor.get().isAlive(),
                "the real server (grandchild pid " + grandchild + ") outlived a launcher that"
                        + " left on end-of-stream: the tree was counted after stdin closed, by"
                        + " which time there was nobody left to name it");
    }

    @Test
    void aServerThatStartsAHelperDuringItsGoodbyeLeavesNoOrphanEither(@TempDir Path tmp)
            throws Exception {
        // The polite second is a window in which the server may fork, and that is not an
        // exotic case: it is the reason the second exists. A server told "your stdin has
        // ended" is being invited to do its cleanup, and cleanup that shells out has a
        // child. Counting the tree only before the goodbye names everything that existed
        // then and nothing the goodbye caused, so the kill walks a list up to
        // EXIT_AFTER_EOF_GRACE + DESTROY_ESCALATION_GRACE old and the helper is reparented
        // to init. Measured before the second census existed: one orphan per run, ppid 1,
        // accumulating for as long as the machine is up.
        //
        // So the census is taken TWICE — once while everything is certainly alive, and
        // once as late as the parent allows, after the grace and before the signal. The
        // fixture starts its helper 300 ms after end-of-stream, which is inside the
        // 1 s grace: early enough that a census taken after the grace must see it, late
        // enough that a census taken at the top of the release step cannot.
        Path pidFile = tmp.resolve("forker.pid");
        List<String> command = fixtureCommand(pidFile, "forker");
        assumeTrue(command != null, "cannot locate the fixture classpath; skipping");

        McpServerConfig forker = new McpServerConfig(
                "forker", command.getFirst(), command.subList(1, command.size()), null, null, null);

        McpServerRegistry registry = McpServerRegistry.load(
                List.of(forker), tmp, config -> new StdioTransport(config, tmp, BOUND));
        assertTrue(registry.servers().getFirst().reachable(),
                "the forker fixture answers the handshake; if it did not, this test proves nothing");
        long serverPid = pidOf(pidFile);

        registry.close();

        long helperPid = pidOf(Path.of(pidFile + ".fork"));
        Optional<ProcessHandle> helper = ProcessHandle.of(helperPid);
        boolean helperSurvived = helper.isPresent() && helper.get().isAlive();
        // Read first, then clean up: a red run must not leave the orphan it just proved.
        helper.ifPresent(ProcessHandle::destroyForcibly);

        Optional<ProcessHandle> server = ProcessHandle.of(serverPid);
        assertFalse(server.isPresent() && server.get().isAlive(),
                "the server itself (pid " + serverPid + ") outlived the teardown");
        assertFalse(helperSurvived,
                "the helper (pid " + helperPid + ") the server started while it was saying"
                        + " goodbye outlived the teardown: it was born after the census, so the"
                        + " kill walked a list that could not name it, and it is now reparented"
                        + " to init and accumulating");
    }

    @Test
    void fourMuteServersLeaveFourDeadReaderThreadsAndNotOneLiveOne(@TempDir Path tmp)
            throws Exception {
        List<Thread> readers = new ArrayList<>();
        List<StdioTransport> transports = new ArrayList<>();
        try {
            for (int i = 0; i < 4; i++) {
                Path pidFile = tmp.resolve("mute-" + i + ".pid");
                List<String> command = fixtureCommand(pidFile);
                assumeTrue(command != null, "cannot locate the fixture classpath; skipping");
                McpServerConfig mute = new McpServerConfig("mute-" + i, command.getFirst(),
                        command.subList(1, command.size()), null, null, null);

                StdioTransport transport = new StdioTransport(mute, tmp, BOUND);
                transports.add(transport);
                assertThrows(RuntimeException.class, transport::initialize,
                        "a mute server must surface a timeout, not a value");

                Thread reader = transport.channel().readerThread();
                assertNotNull(reader, "the channel never started a reader thread");
                readers.add(reader);
            }

            assertEquals(4, readers.size(), "four channels, four reader threads");
            List<Thread> stillAlive = readers.stream().filter(Thread::isAlive).toList();
            assertTrue(stillAlive.isEmpty(),
                    stillAlive.size() + " of " + readers.size()
                            + " reader threads outlived their timed-out channel: " + stillAlive);
        } finally {
            transports.forEach(StdioTransport::close);
        }
    }

    @Test
    void aServerWhoseHandshakeFailsWithoutTimingOutIsNotLeftRunningEither(@TempDir Path tmp)
            throws Exception {
        // The other way to orphan a child, and the one the timeout fix does not reach:
        // the server answers, so nothing times out and nothing is poisoned — but the
        // handshake still fails, and the skip path has to close what start() opened.
        Path pidFile = tmp.resolve("gibberish.pid");
        List<String> command = fixtureCommand(pidFile, "gibberish");
        assumeTrue(command != null, "cannot locate the fixture classpath; skipping");

        McpServerConfig babbler = new McpServerConfig(
                "babbler", command.getFirst(), command.subList(1, command.size()), null, null, null);

        McpServerRegistry registry = McpServerRegistry.load(
                List.of(babbler), tmp, config -> new StdioTransport(config, tmp, BOUND));
        try {
            assertFalse(registry.servers().getFirst().reachable(),
                    "a server that answers gibberish is not reachable");
        } finally {
            registry.close();
        }

        long pid = pidOf(pidFile);
        Optional<ProcessHandle> child = ProcessHandle.of(pid);
        assertFalse(child.isPresent() && child.get().isAlive(),
                "the spawned server (pid " + pid + ") outlived a failed handshake");
    }

    @Test
    void theFactoryEveryFaceLoadsThroughIsTheOneCarryingTheFix(@TempDir Path tmp) throws Exception {
        // Criterion 5. The REPL (SpectroCli), doctor (DoctorCommand) and a web session
        // (SessionConnection) all call the two-argument McpServerRegistry.load, which
        // reaches McpTransports.defaultFactory. The probes above shorten the bound with
        // an explicit factory; this is what pins them to the wiring the faces get, so a
        // green probe cannot coexist with a production path that skips the unblock hook.
        Path pidFile = tmp.resolve("factory.pid");
        List<String> command = fixtureCommand(pidFile);
        assumeTrue(command != null, "cannot locate the fixture classpath; skipping");

        McpServerConfig mute = new McpServerConfig(
                "mute", command.getFirst(), command.subList(1, command.size()), null, null, null);

        McpTransport transport = McpTransports.defaultFactory(tmp).apply(mute);
        assertInstanceOf(StdioTransport.class, transport,
                "a stdio entry must reach the transport that owns the child process");
        // Read the pid while the child is still alive: nothing waits for the handshake
        // here, so a close() issued straight away outruns the fixture's first statement.
        long pid = pidOf(pidFile);
        assertTrue(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false),
                "the child must be running before close() is the thing that ends it");

        transport.close();

        Optional<ProcessHandle> child = ProcessHandle.of(pid);
        assertFalse(child.isPresent() && child.get().isAlive(),
                "closing the production transport must take the child (pid " + pid + ") with it");

        // The number the shipped guide prints, pinned to the code that honours it.
        assertEquals(Duration.ofSeconds(20), StdioTransport.DEFAULT_READ_TIMEOUT,
                "chapter 18 of the user guide names this bound in prose");
    }

    @Test
    void aChannelHandedNoLeverGivesUpOnTheStreamRatherThanOnTheCaller(@TempDir Path tmp)
            throws Exception {
        // The belt behind the braces. The three-argument constructor has no way to end
        // the read; the teardown must then notice that the reader never left and walk
        // away from the stream, because reaching for close() is exactly how card 221
        // parked a face forever. A leaked descriptor on a doomed pipe is the cheaper loss.
        Path pidFile = tmp.resolve("lever.pid");
        List<String> command = fixtureCommand(pidFile);
        assumeTrue(command != null, "cannot locate the fixture classpath; skipping");

        Process process = new ProcessBuilder(command)
                .redirectError(ProcessBuilder.Redirect.DISCARD).start();
        try {
            BufferedReader in = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
            BufferedWriter out = new BufferedWriter(
                    new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
            JsonRpcChannel channel = new JsonRpcChannel(in, out, BOUND);

            long startedAt = System.nanoTime();
            assertThrows(RuntimeException.class, () -> channel.request("initialize", null));
            long elapsedMs = millisSince(startedAt);

            assertTrue(elapsedMs < BUDGET_MS,
                    "teardown without a lever must give up, not park; it took " + elapsedMs + " ms");
            assertTrue(channel.isPoisoned(), "the channel is unusable either way");
        } finally {
            process.destroyForcibly();
            process.waitFor(5, TimeUnit.SECONDS);
        }
    }

    @Test
    void aReEstablishThatFailsItsHandshakeLeavesNoChildBehindEither(@TempDir Path tmp)
            throws Exception {
        // McpClient.establish() sits on the re-connect path a tool call takes after the
        // transport died, so it runs once PER CALL. It spawned, handshook, and on a
        // handshake that throws walked away from the transport it had just opened —
        // the same defect the registry's skip path carried, on a hotter path. The
        // gibberish fixture answers one line that is not JSON: initialize fails without
        // a timeout, so nothing is poisoned and nothing destroys the child on the way out.
        List<String> command = fixtureCommand(tmp.resolve("establish.pid"), "gibberish");
        assumeTrue(command != null, "cannot locate the fixture classpath; skipping");

        List<Long> spawned = new ArrayList<>();
        for (int attempt = 0; attempt < 2; attempt++) {
            Path pidFile = tmp.resolve("establish-" + attempt + ".pid");
            List<String> attemptCommand = fixtureCommand(pidFile, "gibberish");
            McpServerConfig babbler = new McpServerConfig("babbler", attemptCommand.getFirst(),
                    attemptCommand.subList(1, attemptCommand.size()), null, null, null);
            McpClient client = new McpClient(babbler,
                    () -> new StdioTransport(babbler, tmp, BOUND), BOUND);
            try {
                // Never started, so call() takes the establish path — exactly what a tool
                // call does when the previous transport was poisoned.
                McpCallResult result = client.call("anything", null);
                assertTrue(result.text().startsWith("ERROR:"),
                        "a server that cannot be established degrades to an ERROR string, got: "
                                + result.text());
            } finally {
                client.close();
            }
            spawned.add(pidOf(pidFile));
        }

        List<Long> alive = spawned.stream()
                .filter(pid -> ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false))
                .toList();
        assertTrue(alive.isEmpty(),
                alive.size() + " of " + spawned.size() + " servers spawned by a FAILED"
                        + " re-establish are still running: " + alive
                        + " — that is one leaked child per tool call on the re-connect path");
    }

    // ---- the harness ---------------------------------------------------------------

    /** Milliseconds since a {@code System.nanoTime()} mark. */
    private static long millisSince(long startedAtNanos) {
        return (System.nanoTime() - startedAtNanos) / 1_000_000;
    }

    /**
     * The pid the fixture wrote before it went quiet, waiting briefly for the file —
     * a fresh JVM needs a moment to reach its first statement.
     *
     * @param pidFile the file named on the fixture's command line
     * @return the child's pid
     */
    private static long pidOf(Path pidFile) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
        while (System.nanoTime() < deadline) {
            if (Files.exists(pidFile)) {
                String text = Files.readString(pidFile, StandardCharsets.UTF_8).trim();
                if (!text.isEmpty()) {
                    return Long.parseLong(text);
                }
            }
            Thread.sleep(25);
        }
        throw new AssertionError("the fixture never announced its pid at " + pidFile);
    }

    /**
     * The command that launches the mute fixture in its own JVM — this JDK's
     * {@code java}, a classpath built from the code sources actually in use, and the
     * fixture's main class. Mirrors {@link McpImageRealProcessTest}.
     *
     * @param pidFile where the fixture announces its own pid
     * @return the command line, or {@code null} when a code source cannot be located
     */
    private static List<String> fixtureCommand(Path pidFile) throws URISyntaxException {
        return fixtureCommand(pidFile, "mute");
    }

    /**
     * The same fixture, but behind a shell wrapper — the shape almost every published
     * MCP server is configured in ({@code npx}, {@code uvx}, a {@code .sh} launcher).
     * The trailing {@code ; true} is load-bearing: a shell handed a single simple
     * command {@code exec}s it and no grandchild exists at all, which would quietly
     * turn this into the direct-child case it is here to distinguish from.
     *
     * @param pidFile where the fixture announces its own pid — the GRANDCHILD's
     * @param mode    {@code mute} or {@code gibberish}
     * @return the {@code /bin/sh -c …} command line, or {@code null} when unavailable
     */
    private static List<String> wrappedFixtureCommand(Path pidFile, String mode)
            throws URISyntaxException {
        List<String> inner = fixtureCommand(pidFile, mode);
        if (inner == null || !Files.isExecutable(Path.of("/bin/sh"))) {
            return null;
        }
        String script = inner.stream()
                .map(McpMuteServerRealProcessTest::shellQuote)
                .reduce((a, b) -> a + " " + b)
                .orElseThrow() + " ; true";
        return List.of("/bin/sh", "-c", script);
    }

    /**
     * A launcher that hands its stdout to the server, forwards nothing, and <b>leaves
     * the moment the client closes stdin</b> — the shape that turns a polite shutdown
     * into an orphan factory unless the tree is counted before the goodbye. {@code cat}
     * is what holds it open and what ends it; the fixture in the background keeps the
     * stdout pipe, so the read is still parked when the timeout fires.
     *
     * @param pidFile where the backgrounded fixture announces its own pid — the GRANDCHILD's
     * @return the {@code /bin/sh -c …} command line, or {@code null} when unavailable
     */
    private static List<String> wrapperThatLeavesOnStdinEof(Path pidFile) throws URISyntaxException {
        List<String> inner = fixtureCommand(pidFile, "mute");
        if (inner == null || !Files.isExecutable(Path.of("/bin/sh"))) {
            return null;
        }
        String script = inner.stream()
                .map(McpMuteServerRealProcessTest::shellQuote)
                .reduce((a, b) -> a + " " + b)
                .orElseThrow() + " & cat > /dev/null ; exit 0";
        return List.of("/bin/sh", "-c", script);
    }

    /**
     * What the polite fixture recorded on its way out, waiting briefly for the file —
     * the child writes it while it is being ended, so the first look can be too early.
     *
     * @param logFile the fixture's {@code .exit} file
     * @return the recorded events, each {@code "<what> <nanoTime>"}, possibly empty when
     *         the child never got the chance to write anything
     */
    private static List<String> shutdownEvents(Path logFile) throws Exception {
        // The caller has already established that the child is gone, so whatever is in
        // the file is final; this only waits for it to appear at all.
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        List<String> events = List.of();
        while (System.nanoTime() < deadline && events.isEmpty()) {
            if (Files.exists(logFile)) {
                events = Files.readAllLines(logFile, StandardCharsets.UTF_8).stream()
                        .filter(line -> !line.isBlank()).toList();
            }
            if (events.isEmpty()) {
                Thread.sleep(25);
            }
        }
        return events;
    }

    /**
     * The nanoTime the fixture stamped on one event, in the fixture's own clock.
     *
     * @param events what {@link #shutdownEvents} collected
     * @param what   {@code STDIN-EOF} or {@code SIGNAL}
     * @return the stamp, or {@code null} when that event never happened
     */
    private static Long timestampOf(List<String> events, String what) {
        return events.stream()
                .filter(line -> line.startsWith(what + " "))
                .map(line -> Long.parseLong(line.substring(what.length() + 1).trim()))
                .findFirst().orElse(null);
    }

    /** POSIX single-quoting, so a temp path with a space cannot rewrite the script. */
    private static String shellQuote(String argument) {
        return "'" + argument.replace("'", "'\\''") + "'";
    }

    /**
     * The launch command with an explicit misbehaviour mode.
     *
     * @param pidFile where the fixture announces its own pid
     * @param mode    {@code mute} or {@code gibberish}
     * @return the command line, or {@code null} when a code source cannot be located
     */
    private static List<String> fixtureCommand(Path pidFile, String mode) throws URISyntaxException {
        Set<String> classpath = new LinkedHashSet<>();
        for (Class<?> anchor : List.of(MuteMcpServerFixture.class, ObjectMapper.class,
                JsonFactory.class, JsonInclude.class)) {
            var source = anchor.getProtectionDomain().getCodeSource();
            if (source == null || source.getLocation() == null) {
                return null;
            }
            classpath.add(Path.of(source.getLocation().toURI()).toString());
        }
        String java = System.getProperty("java.home") + File.separator + "bin" + File.separator + "java";
        if (!Files.isExecutable(Path.of(java))) {
            return null;
        }
        assertNotNull(pidFile, "the fixture needs somewhere to announce its pid");
        return List.of(java, "-cp", String.join(File.pathSeparator, classpath),
                MuteMcpServerFixture.class.getName(), pidFile.toString(), mode);
    }
}
