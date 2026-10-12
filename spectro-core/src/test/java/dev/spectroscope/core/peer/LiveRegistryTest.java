package dev.spectroscope.core.peer;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.ServerSocketChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 502 criteria 1 and 2: one record per process, and a reader that counts
 * a record only when the process is alive, its start instant matches and its
 * socket accepts. Each check is bitten on its own with a forged record that
 * fails exactly that check.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class LiveRegistryTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path home;

    private final List<Process> processes = new ArrayList<>();
    private final List<ServerSocketChannel> listeners = new ArrayList<>();

    @AfterEach
    void cleanUp() throws IOException {
        for (Process p : processes) {
            p.destroyForcibly();
        }
        for (ServerSocketChannel l : listeners) {
            l.close();
        }
    }

    private Process sleeper() throws IOException {
        Process p = new ProcessBuilder("sleep", "60").start();
        processes.add(p);
        return p;
    }

    private Path listen(LiveRegistry registry, long pid) throws IOException {
        Path socket = registry.socketPathFor(pid);
        Files.createDirectories(socket.getParent());
        Files.deleteIfExists(socket);
        ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(socket));
        listeners.add(server);
        return socket;
    }

    private static LiveRecord record(ProcessIdentity who, Path socket) {
        return new LiveRecord(who.pid(), who.procStart(), System.currentTimeMillis(), "server", "0.15.1",
                PeerLimits.PROTOCOL, List.of(), socket.toString(), true, List.of());
    }

    private LiveRegistry registry() {
        return new LiveRegistry(home.resolve(".spectro/live"));
    }

    @Test
    void aRecordIsWrittenAsPidJsonInAPrivateDirectoryAndDeletedAtExit() throws IOException {
        LiveRegistry registry = registry();
        ProcessIdentity me = ProcessIdentity.current();
        registry.write(record(me, registry.socketPathFor(me.pid())));
        Path file = registry.dir().resolve(me.pid() + ".json");
        assertTrue(Files.isRegularFile(file));
        assertEquals("rwx------", PosixFilePermissions.toString(Files.getPosixFilePermissions(registry.dir())));
        LiveRecord read = JSON.readValue(file.toFile(), LiveRecord.class);
        assertEquals(me.pid(), read.pid());
        assertEquals(me.procStart(), read.procStart());
        for (String field : List.of("pid", "procStart", "startedAt", "face", "version", "protocol", "features",
                "socket", "sessions")) {
            assertTrue(JSON.readTree(file.toFile()).has(field), field);
        }
        registry.delete(me.pid());
        assertFalse(Files.exists(file));
    }

    @Test
    void aLiveProcessWithItsStartInstantAndAListeningSocketCounts() throws IOException {
        LiveRegistry registry = registry();
        Process p = sleeper();
        ProcessIdentity who = ProcessIdentity.of(p.pid()).orElseThrow();
        registry.write(record(who, listen(registry, p.pid())));

        LiveRegistry.Listing listing = registry.list();

        assertEquals(List.of(p.pid()), listing.live().stream().map(LiveRecord::pid).toList());
        assertEquals(List.of(), listing.unlinked());
    }

    @Test
    void aRecordOfADeadProcessIsUnlinked() throws Exception {
        LiveRegistry registry = registry();
        Process p = sleeper();
        ProcessIdentity who = ProcessIdentity.of(p.pid()).orElseThrow();
        registry.write(record(who, listen(registry, p.pid())));
        p.destroyForcibly().waitFor();

        LiveRegistry.Listing listing = registry.list();

        assertEquals(List.of(), listing.live());
        assertEquals(List.of(p.pid() + ".json"), listing.unlinked());
        assertFalse(Files.exists(registry.dir().resolve(p.pid() + ".json")));
    }

    @Test
    void aRecordWhoseStartInstantDiffersIsUnlinked() throws IOException {
        LiveRegistry registry = registry();
        Process p = sleeper();
        ProcessIdentity who = ProcessIdentity.of(p.pid()).orElseThrow();
        ProcessIdentity reused = new ProcessIdentity(who.pid(), "2001-01-01T00:00:00Z");
        registry.write(record(reused, listen(registry, p.pid())));

        LiveRegistry.Listing listing = registry.list();

        assertEquals(List.of(), listing.live());
        assertEquals(List.of(p.pid() + ".json"), listing.unlinked());
    }

    @Test
    void aRecordWhoseSocketDoesNotAcceptIsUnlinked() throws IOException {
        LiveRegistry registry = registry();
        Process p = sleeper();
        ProcessIdentity who = ProcessIdentity.of(p.pid()).orElseThrow();
        registry.write(record(who, registry.socketPathFor(p.pid())));

        LiveRegistry.Listing listing = registry.list();

        assertEquals(List.of(), listing.live());
        assertEquals(List.of(p.pid() + ".json"), listing.unlinked());
    }

    @Test
    void aFileOverTheSizeCapIsSkippedAndKept() throws IOException {
        LiveRegistry registry = registry();
        Process p = sleeper();
        Path file = registry.dir().resolve(p.pid() + ".json");
        Files.createDirectories(registry.dir());
        Files.writeString(file, "{\"pad\":\"" + "x".repeat(PeerLimits.RECORD_MAX_BYTES) + "\"}");

        LiveRegistry.Listing listing = registry.list();

        assertEquals(List.of(), listing.live());
        assertEquals(List.of(p.pid() + ".json"), listing.skipped());
        assertTrue(Files.exists(file), "skipped, not deleted");
    }

    @Test
    void aFileWhoseStemIsNotADecimalPidIsDeleted() throws IOException {
        LiveRegistry registry = registry();
        Files.createDirectories(registry.dir());
        Path odd = registry.dir().resolve("4711x.json");
        Files.writeString(odd, "{}");

        LiveRegistry.Listing listing = registry.list();

        assertFalse(Files.exists(odd));
        assertEquals(List.of("4711x.json"), listing.unlinked());
    }

    @Test
    void aRecordWhosePidIsNotItsStemIsDeleted() throws IOException {
        LiveRegistry registry = registry();
        Process p = sleeper();
        ProcessIdentity who = ProcessIdentity.of(p.pid()).orElseThrow();
        Files.createDirectories(registry.dir());
        Path lying = registry.dir().resolve((p.pid() + 1) + ".json");
        Files.writeString(lying, JSON.writeValueAsString(record(who, listen(registry, p.pid()))));

        LiveRegistry.Listing listing = registry.list();

        assertEquals(List.of(), listing.live());
        assertFalse(Files.exists(lying));
    }

    @Test
    void theSocketProbesOfOneListingRunInParallel() throws IOException {
        // Twenty records. Each probe says yes only once all twenty probes are in
        // flight at the same moment, so a listing that probes one record after
        // another finds none live. The proof is the count, not the wall clock:
        // a loaded machine slows the listing without making it serial.
        java.util.concurrent.CountDownLatch allInFlight = new java.util.concurrent.CountDownLatch(20);
        java.util.concurrent.atomic.AtomicInteger inFlight = new java.util.concurrent.atomic.AtomicInteger();
        java.util.concurrent.atomic.AtomicInteger mostInFlight = new java.util.concurrent.atomic.AtomicInteger();
        LiveRegistry.Liveness together = new LiveRegistry.Liveness() {
            @Override
            public java.util.Optional<String> startOf(long pid) {
                return ProcessIdentity.of(pid).map(ProcessIdentity::procStart);
            }

            @Override
            public boolean connects(String socket, int timeoutMs) {
                mostInFlight.accumulateAndGet(inFlight.incrementAndGet(), Math::max);
                allInFlight.countDown();
                try {
                    return allInFlight.await(timeoutMs * 2L, java.util.concurrent.TimeUnit.MILLISECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return false;
                } finally {
                    inFlight.decrementAndGet();
                }
            }
        };
        LiveRegistry registry = new LiveRegistry(home.resolve(".spectro/live"), together);
        for (int i = 0; i < 20; i++) {
            Process p = sleeper();
            registry.write(record(ProcessIdentity.of(p.pid()).orElseThrow(), registry.socketPathFor(p.pid())));
        }
        long started = System.nanoTime();
        LiveRegistry.Listing listing = registry.list();
        long ms = (System.nanoTime() - started) / 1_000_000;

        assertEquals(20, mostInFlight.get(), "every probe of the listing was in flight at once");
        assertEquals(20, listing.live().size(), "and each one answered");
        String out = System.getProperty("peer.timing.out");
        if (out != null) {
            Files.writeString(Path.of(out), "records=20 probe_ms=" + PeerLimits.PROBE_TIMEOUT_MS
                    + " listing_ms=" + ms + " most_in_flight=" + mostInFlight.get()
                    + " method=System.nanoTime around LiveRegistry.list, each injected probe held until all"
                    + " twenty were in flight, real sleep processes as pids\n",
                    java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
        }
    }

    /** Real process checks, and a socket probe that answers as told. */
    private static LiveRegistry.Liveness probeAnswers(boolean accepts, int delayMs) {
        return new LiveRegistry.Liveness() {
            @Override
            public java.util.Optional<String> startOf(long pid) {
                return ProcessIdentity.of(pid).map(ProcessIdentity::procStart);
            }

            @Override
            public boolean connects(String socket, int timeoutMs) {
                try {
                    Thread.sleep(delayMs);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return accepts;
            }
        };
    }

    /** A live process with its record, its key and its listening socket. */
    private ProcessIdentity liveWithKeyAndSocket(LiveRegistry registry) throws IOException {
        Process p = sleeper();
        ProcessIdentity who = ProcessIdentity.of(p.pid()).orElseThrow();
        registry.write(record(who, listen(registry, p.pid())));
        Files.writeString(registry.keyPathFor(p.pid()), "a-token");
        return who;
    }

    @Test
    void aLiveProcessWhoseProbeFailsLosesOnlyItsRecord() throws IOException {
        Path dir = home.resolve(".spectro/live");
        LiveRegistry registry = new LiveRegistry(dir, probeAnswers(false, 0));
        ProcessIdentity who = liveWithKeyAndSocket(registry);

        LiveRegistry.Listing listing = registry.list();

        assertEquals(List.of(), listing.live());
        assertEquals(List.of(who.pid() + ".json"), listing.unlinked());
        assertTrue(Files.exists(registry.keyPathFor(who.pid())), "the live process keeps its key");
        assertTrue(Files.exists(registry.socketPathFor(who.pid())), "the live process keeps its socket");
    }

    @Test
    void aLiveProcessWhoseProbeIsLateLosesOnlyItsRecord() throws IOException {
        Path dir = home.resolve(".spectro/live");
        LiveRegistry registry = new LiveRegistry(dir, probeAnswers(true, 700));
        ProcessIdentity who = liveWithKeyAndSocket(registry);

        LiveRegistry.Listing listing = registry.list();

        assertEquals(List.of(), listing.live());
        assertEquals(List.of(who.pid() + ".json"), listing.unlinked());
        assertTrue(Files.exists(registry.keyPathFor(who.pid())), "the live process keeps its key");
        assertTrue(Files.exists(registry.socketPathFor(who.pid())), "the live process keeps its socket");
    }

    @Test
    void aDeadProcessLosesItsKeyAndItsSocketWithItsRecord() throws Exception {
        LiveRegistry registry = registry();
        Process p = sleeper();
        ProcessIdentity who = ProcessIdentity.of(p.pid()).orElseThrow();
        registry.write(record(who, listen(registry, p.pid())));
        Files.writeString(registry.keyPathFor(p.pid()), "a-token");
        p.destroyForcibly().waitFor();

        registry.list();

        assertFalse(Files.exists(registry.keyPathFor(p.pid())), "the key of a dead process goes");
        assertFalse(Files.exists(registry.socketPathFor(p.pid())), "the socket of a dead process goes");
    }

    @Test
    void aReusedPidLosesTheKeyAndTheSocketOfTheRecord() throws IOException {
        LiveRegistry registry = registry();
        Process p = sleeper();
        ProcessIdentity reused = new ProcessIdentity(p.pid(), "2001-01-01T00:00:00Z");
        registry.write(record(reused, listen(registry, p.pid())));
        Files.writeString(registry.keyPathFor(p.pid()), "a-token");

        registry.list();

        assertFalse(Files.exists(registry.keyPathFor(p.pid())), "a start that differs is a dead record");
        assertFalse(Files.exists(registry.socketPathFor(p.pid())));
    }

    @Test
    void aRecordWhoseSocketIsNotThePathOfItsPidDoesNotCount() throws IOException {
        LiveRegistry registry = registry();
        Process p = sleeper();
        ProcessIdentity who = ProcessIdentity.of(p.pid()).orElseThrow();
        Path elsewhere = home.resolve("listener.sock");
        ServerSocketChannel other = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        other.bind(UnixDomainSocketAddress.of(elsewhere));
        listeners.add(other);
        registry.write(record(who, elsewhere));
        Files.writeString(registry.keyPathFor(p.pid()), "a-token");

        LiveRegistry.Listing listing = registry.list();

        assertEquals(List.of(), listing.live(), "a socket at another path is not this process's inbox");
        assertEquals(List.of(p.pid() + ".json"), listing.unlinked());
        assertTrue(Files.exists(registry.keyPathFor(p.pid())), "the live process keeps its key");
    }

    @Test
    void aLongHomeFallsBackToAShortSocketDirectory() {
        Path deep = home.resolve("a".repeat(60)).resolve("b".repeat(40)).resolve(".spectro/live");
        LiveRegistry registry = new LiveRegistry(deep);
        Path socket = registry.socketPathFor(4711);
        assertTrue(socket.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length
                <= LiveRegistry.SOCKET_PATH_MAX, socket.toString());
        assertEquals("4711.sock", socket.getFileName().toString());
        assertTrue(registry.socketPathFor(4711).equals(socket), "stable for one registry");
    }
}
