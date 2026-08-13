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

    /** What the whole probe may take: the bound, plus the spawn, plus a bounded teardown. */
    private static final long BUDGET_MS = 6_000;

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
