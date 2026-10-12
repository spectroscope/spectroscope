package dev.spectroscope.core.peer;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 502 criteria 3 and 9: the socket, its auth, and the sender's checks and errors. */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class PeerTransportTest {

    @TempDir
    Path home;

    private final List<AutoCloseable> closing = new ArrayList<>();
    private final List<Process> processes = new ArrayList<>();
    private final List<JsonNode> received = new CopyOnWriteArrayList<>();
    private final List<Long> verifiedPids = new CopyOnWriteArrayList<>();

    private ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender;
    private ch.qos.logback.classic.Level wasLevel;

    @org.junit.jupiter.api.BeforeEach
    void captureLogs() {
        ch.qos.logback.classic.Logger logger = (ch.qos.logback.classic.Logger)
                org.slf4j.LoggerFactory.getLogger(PeerEndpoint.class);
        wasLevel = logger.getLevel();
        logger.setLevel(ch.qos.logback.classic.Level.INFO);
        appender = new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        logger.addAppender(appender);
    }

    @AfterEach
    void close() throws Exception {
        for (AutoCloseable c : closing) {
            c.close();
        }
        processes.forEach(Process::destroyForcibly);
        ch.qos.logback.classic.Logger logger = (ch.qos.logback.classic.Logger)
                org.slf4j.LoggerFactory.getLogger(PeerEndpoint.class);
        logger.detachAppender(appender);
        logger.setLevel(wasLevel);
    }

    private List<String> logLines() {
        synchronized (appender) { // AppenderBase.doAppend holds this lock while it adds
            return appender.list.stream().map(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage).toList();
        }
    }

    /**
     * Waits until the endpoint counted this many refused connections and logged
     * each one; the count is raised just before its log line is written.
     */
    private void awaitDropped(PeerEndpoint endpoint, long count) throws InterruptedException {
        long until = System.currentTimeMillis() + 5_000;
        while ((endpoint.droppedUnauthenticated() < count
                || logLines().stream().filter(l -> l.startsWith("Dropped")).count() < count)
                && System.currentTimeMillis() < until) {
            Thread.sleep(10);
        }
    }

    private LiveRegistry registry() {
        return new LiveRegistry(home.resolve(".spectro/live"));
    }

    private PeerEndpoint endpoint(LiveRegistry registry) throws IOException {
        PeerEndpoint endpoint = new PeerEndpoint(registry, ProcessIdentity.current(), (frame, pid) -> {
            received.add(frame);
            verifiedPids.add(pid);
        });
        endpoint.start();
        closing.add(endpoint);
        return endpoint;
    }

    private static LiveRecord record(ProcessIdentity who, Path socket) {
        return new LiveRecord(who.pid(), who.procStart(), System.currentTimeMillis(), "server", "0.15.1",
                PeerLimits.PROTOCOL, List.of(), socket.toString(), true, List.of());
    }

    private static JsonNode hello(String text) {
        return PeerFrames.message(PeerEnvelope.builder().msgId(PeerFrames.newMsgId()).toSession("s2")
                .from("uds:/x").fromSession("s1").fromName("a").fromMode("prompting").text(text).build());
    }

    private static void awaitSize(List<?> list, int size) throws InterruptedException {
        long until = System.currentTimeMillis() + 5_000;
        while (list.size() < size && System.currentTimeMillis() < until) {
            Thread.sleep(10);
        }
    }

    @Test
    void theSocketIsPrivateAndTheTokenSitsBesideTheRecordInAPrivateFile() throws IOException {
        LiveRegistry registry = registry();
        PeerEndpoint endpoint = endpoint(registry);
        long pid = ProcessHandle.current().pid();
        assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(endpoint.socket())));
        Path key = registry.keyPathFor(pid);
        assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(key)));
        assertEquals(endpoint.token(), Files.readString(key).strip());
        assertEquals("rwx------", PosixFilePermissions.toString(
                Files.getPosixFilePermissions(endpoint.socket().getParent())));
    }

    @Test
    void aSenderWithTheTokenDeliversAndTheReceiverKnowsItsStatedPid() throws Exception {
        LiveRegistry registry = registry();
        PeerEndpoint endpoint = endpoint(registry);
        PeerClient client = new PeerClient(registry, ProcessIdentity.current());
        PeerClient.Result result = client.send(record(ProcessIdentity.current(), endpoint.socket()), "peer",
                hello("hi"));
        assertTrue(result.sent(), String.valueOf(result.text()));
        awaitSize(received, 1);
        assertEquals("hi", received.getFirst().get("text").asText());
        assertEquals(ProcessHandle.current().pid(), verifiedPids.getFirst());
        assertEquals(0, endpoint.droppedUnauthenticated(), "an authenticated sender is not counted");
        assertTrue(logLines().stream().noneMatch(l -> l.startsWith("Dropped")), logLines().toString());
    }

    @Test
    void aConnectionThatDoesNotAuthenticateIsClosedAndCounted() throws Exception {
        LiveRegistry registry = registry();
        PeerEndpoint endpoint = endpoint(registry);
        try (SocketChannel raw = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            raw.connect(UnixDomainSocketAddress.of(endpoint.socket()));
            raw.write(ByteBuffer.wrap((PeerFrames.line(hello("sneaky")) + "\n").getBytes(StandardCharsets.UTF_8)));
            assertTrue(readsToEnd(raw), "the endpoint closed the connection");
        }
        awaitDropped(endpoint, 1);
        assertEquals(1, endpoint.droppedUnauthenticated());
        assertTrue(received.isEmpty());
        assertTrue(logLines().contains(
                "Dropped a connection that did not authenticate (the first frame was not auth); 1 in all"),
                logLines().toString());
        assertTrue(logLines().stream().noneMatch(l -> l.contains("sneaky")), "no body in a log line");
    }

    @Test
    void aWrongTokenIsClosedWithoutAFrame() throws Exception {
        LiveRegistry registry = registry();
        PeerEndpoint endpoint = endpoint(registry);
        ProcessIdentity me = ProcessIdentity.current();
        try (SocketChannel raw = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            raw.connect(UnixDomainSocketAddress.of(endpoint.socket()));
            String lines = PeerFrames.line(PeerFrames.auth("not-the-token", me.pid(), me.procStart())) + "\n"
                    + PeerFrames.line(hello("sneaky")) + "\n";
            raw.write(ByteBuffer.wrap(lines.getBytes(StandardCharsets.UTF_8)));
            assertTrue(readsToEnd(raw));
        }
        assertTrue(received.isEmpty());
        awaitDropped(endpoint, 1);
        assertEquals(1, endpoint.droppedUnauthenticated(), "a wrong token is counted");
        assertTrue(logLines().contains("Dropped a connection that did not authenticate (wrong token); 1 in all"),
                logLines().toString());
    }

    @Test
    void anAuthThatNamesAnotherProcessIsClosed() throws Exception {
        LiveRegistry registry = registry();
        PeerEndpoint endpoint = endpoint(registry);
        Process other = new ProcessBuilder("sleep", "60").start();
        processes.add(other);
        try (SocketChannel raw = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            raw.connect(UnixDomainSocketAddress.of(endpoint.socket()));
            String lines = PeerFrames.line(PeerFrames.auth(endpoint.token(), other.pid(), "2001-01-01T00:00:00Z"))
                    + "\n" + PeerFrames.line(hello("claims a pid")) + "\n";
            raw.write(ByteBuffer.wrap(lines.getBytes(StandardCharsets.UTF_8)));
            assertTrue(readsToEnd(raw));
        }
        assertTrue(received.isEmpty());
        awaitDropped(endpoint, 1);
        assertEquals(1, endpoint.droppedUnauthenticated(), "a pid that does not check out is counted");
        assertTrue(logLines().contains("Dropped a connection that did not authenticate"
                + " (the stated pid is not a live process with that start); 1 in all"), logLines().toString());
    }

    @Test
    void aConnectionThatStaysSilentIsClosedAtTheAuthDeadlineAndCounted() throws Exception {
        LiveRegistry registry = registry();
        PeerEndpoint endpoint = new PeerEndpoint(registry, ProcessIdentity.current(), (frame, pid) -> {
            received.add(frame);
            verifiedPids.add(pid);
        }, 300);
        endpoint.start();
        closing.add(endpoint);
        try (SocketChannel raw = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            raw.connect(UnixDomainSocketAddress.of(endpoint.socket()));
            long started = System.nanoTime();
            assertTrue(readsToEnd(raw), "the endpoint closed a connection that never authenticated");
            long ms = (System.nanoTime() - started) / 1_000_000;
            assertTrue(ms < 3_000, "closed after " + ms + " ms");
        }
        awaitDropped(endpoint, 1);
        assertEquals(1, endpoint.droppedUnauthenticated());
        assertTrue(logLines().contains(
                "Dropped a connection that did not authenticate (no auth within 300 ms); 1 in all"),
                logLines().toString());
    }

    @Test
    void aSenderThatAuthenticatesInTimeIsNotCutByTheDeadline() throws Exception {
        LiveRegistry registry = registry();
        PeerEndpoint endpoint = new PeerEndpoint(registry, ProcessIdentity.current(), (frame, pid) -> {
            received.add(frame);
            verifiedPids.add(pid);
        }, 300);
        endpoint.start();
        closing.add(endpoint);
        ProcessIdentity me = ProcessIdentity.current();
        try (SocketChannel raw = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            raw.connect(UnixDomainSocketAddress.of(endpoint.socket()));
            raw.write(ByteBuffer.wrap((PeerFrames.line(PeerFrames.auth(endpoint.token(), me.pid(), me.procStart()))
                    + "\n").getBytes(StandardCharsets.UTF_8)));
            Thread.sleep(600);
            raw.write(ByteBuffer.wrap((PeerFrames.line(hello("after the deadline")) + "\n")
                    .getBytes(StandardCharsets.UTF_8)));
            awaitSize(received, 1);
        }
        assertEquals(1, received.size(), "an authenticated connection outlives the auth deadline");
        assertEquals(0, endpoint.droppedUnauthenticated());
    }

    @Test
    void aLineOverTheCapClosesTheConnection() throws Exception {
        LiveRegistry registry = registry();
        PeerEndpoint endpoint = endpoint(registry);
        ProcessIdentity me = ProcessIdentity.current();
        try (SocketChannel raw = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            raw.connect(UnixDomainSocketAddress.of(endpoint.socket()));
            String lines = PeerFrames.line(PeerFrames.auth(endpoint.token(), me.pid(), me.procStart())) + "\n"
                    + "x".repeat(PeerLimits.LINE_CAP_CHARS + 1) + "\n"
                    + PeerFrames.line(hello("after the long line")) + "\n";
            var out = Channels.newOutputStream(raw);
            try {
                out.write(lines.getBytes(StandardCharsets.UTF_8));
            } catch (IOException closedUnderUs) {
                // The endpoint may close before the whole write lands; that is the point.
            }
            assertTrue(readsToEnd(raw));
        }
        Thread.sleep(200);
        assertTrue(received.isEmpty(), "nothing after the long line was read");
    }

    @Test
    void theSenderRefusesAnEndpointThatAnswersForAnotherPid() throws Exception {
        LiveRegistry registry = registry();
        PeerEndpoint endpoint = endpoint(registry);
        Process other = new ProcessBuilder("sleep", "60").start();
        processes.add(other);
        LiveRecord lying = record(ProcessIdentity.of(other.pid()).orElseThrow(), endpoint.socket());
        PeerClient.Result result = new PeerClient(registry, ProcessIdentity.current()).send(lying, "peer",
                hello("must not arrive"));
        assertEquals(PeerClient.Error.WRONG_ENDPOINT, result.error());
        Thread.sleep(200);
        assertTrue(received.isEmpty(), "nothing was written");
    }

    @Test
    void theSenderRefusesAnEndpointWhosePidDiffersEvenWithTheRightStart() throws Exception {
        LiveRegistry registry = registry();
        PeerEndpoint endpoint = endpoint(registry);
        Process other = new ProcessBuilder("sleep", "60").start();
        processes.add(other);
        LiveRecord lying = record(new ProcessIdentity(other.pid(), ProcessIdentity.current().procStart()),
                endpoint.socket());
        assertEquals(PeerClient.Error.WRONG_ENDPOINT, new PeerClient(registry, ProcessIdentity.current())
                .send(lying, "peer", hello("must not arrive")).error());
    }

    @Test
    void theSenderRefusesAnEndpointWhoseStartDiffersEvenWithTheRightPid() throws Exception {
        LiveRegistry registry = registry();
        PeerEndpoint endpoint = endpoint(registry);
        LiveRecord reused = record(new ProcessIdentity(ProcessHandle.current().pid(), "2001-01-01T00:00:00Z"),
                endpoint.socket());
        assertEquals(PeerClient.Error.WRONG_ENDPOINT, new PeerClient(registry, ProcessIdentity.current())
                .send(reused, "peer", hello("must not arrive")).error());
        Thread.sleep(200);
        assertTrue(received.isEmpty());
    }

    @Test
    void aMissingSocketIsGone() {
        LiveRegistry registry = registry();
        PeerClient.Result result = new PeerClient(registry, ProcessIdentity.current())
                .send(record(ProcessIdentity.current(), registry.socketPathFor(1)), "ForgeDemo-7f", hello("x"));
        assertEquals(PeerClient.Error.GONE, result.error());
        assertTrue(result.text().contains("call list_agents to see who is reachable now"), result.text());
        assertTrue(result.text().contains("ForgeDemo-7f"));
    }

    @Test
    void anEndpointThatNeverAnswersIsBusy() throws Exception {
        LiveRegistry registry = registry();
        Path socket = registry.socketPathFor(2);
        LiveRegistry.ensurePrivateDir(socket.getParent());
        ServerSocketChannel silent = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        silent.bind(UnixDomainSocketAddress.of(socket));
        closing.add(silent);
        registry.ensureDir();
        Files.writeString(registry.keyPathFor(ProcessHandle.current().pid()), "a-token");
        PeerClient.Result result = new PeerClient(registry, ProcessIdentity.current(), 300)
                .send(record(ProcessIdentity.current(), socket), "ForgeDemo-7f", hello("x"));
        assertEquals(PeerClient.Error.BUSY, result.error());
        assertTrue(result.text().contains("retry the same name shortly"), result.text());
    }

    @Test
    void aMessageOverTheLineCapIsTooLargeAndNeverConnects() {
        LiveRegistry registry = registry();
        PeerClient.Result result = new PeerClient(registry, ProcessIdentity.current())
                .send(record(ProcessIdentity.current(), registry.socketPathFor(3)), "ForgeDemo-7f",
                        hello("x".repeat(PeerLimits.LINE_CAP_CHARS)));
        assertEquals(PeerClient.Error.TOO_LARGE, result.error());
        assertTrue(result.text().contains("put bulk content in a file the recipient can read"), result.text());
    }

    @Test
    void anUnknownNameHasItsOwnText() {
        String text = PeerClient.unknownName("nobody");
        assertTrue(text.contains("no agent named 'nobody' is reachable"), text);
    }

    /** Reads until the peer closes; true when it did within the time. */
    private static boolean readsToEnd(SocketChannel raw) throws IOException {
        raw.configureBlocking(true);
        ByteBuffer buffer = ByteBuffer.allocate(4096);
        long until = System.currentTimeMillis() + 5_000;
        while (System.currentTimeMillis() < until) {
            buffer.clear();
            int n;
            try {
                n = raw.read(buffer);
            } catch (IOException reset) {
                return true;
            }
            if (n < 0) {
                return true;
            }
        }
        return false;
    }

    @Test
    void theHelloNamesTheListeningProcess() throws Exception {
        LiveRegistry registry = registry();
        PeerEndpoint endpoint = endpoint(registry);
        try (SocketChannel raw = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            raw.connect(UnixDomainSocketAddress.of(endpoint.socket()));
            LineReader reader = new LineReader(Channels.newInputStream(raw));
            JsonNode hello = PeerFrames.parse(reader.readLine()).orElseThrow();
            assertEquals("hello", hello.get("type").asText());
            assertEquals(ProcessHandle.current().pid(), hello.get("pid").asLong());
            assertEquals(ProcessIdentity.current().procStart(), hello.get("procStart").asText());
            assertNull(hello.get("token"), "the hello never carries the token");
        }
    }

    @Test
    void anOverlongFirstLineFromAConnectionThatNeverAuthenticatedIsCounted() throws Exception {
        LiveRegistry registry = registry();
        PeerEndpoint endpoint = endpoint(registry);
        try (SocketChannel raw = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            raw.connect(UnixDomainSocketAddress.of(endpoint.socket()));
            var out = Channels.newOutputStream(raw);
            try {
                out.write(("x".repeat(PeerLimits.LINE_CAP_CHARS + 1) + "\n").getBytes(StandardCharsets.UTF_8));
            } catch (IOException closedUnderUs) {
                // The endpoint may close before the whole write lands.
            }
            assertTrue(readsToEnd(raw));
        }
        awaitDropped(endpoint, 1);
        assertEquals(1, endpoint.droppedUnauthenticated(), "an overlong first line is a refused auth");
        assertTrue(logLines().contains(
                "Dropped a connection that did not authenticate (the first line was over the cap); 1 in all"),
                logLines().toString());
    }

    @Test
    void anOverlongLineAfterAuthIsNotCountedAsARefusedAuth() throws Exception {
        LiveRegistry registry = registry();
        PeerEndpoint endpoint = endpoint(registry);
        ProcessIdentity me = ProcessIdentity.current();
        try (SocketChannel raw = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            raw.connect(UnixDomainSocketAddress.of(endpoint.socket()));
            String lines = PeerFrames.line(PeerFrames.auth(endpoint.token(), me.pid(), me.procStart())) + "\n"
                    + "x".repeat(PeerLimits.LINE_CAP_CHARS + 1) + "\n";
            try {
                Channels.newOutputStream(raw).write(lines.getBytes(StandardCharsets.UTF_8));
            } catch (IOException closedUnderUs) {
                // The endpoint may close before the whole write lands.
            }
            assertTrue(readsToEnd(raw));
        }
        Thread.sleep(200);
        assertEquals(0, endpoint.droppedUnauthenticated());
    }

    @Test
    void aFloodOfSilentConnectionsDoesNotLockOutASender() throws Exception {
        LiveRegistry registry = registry();
        PeerEndpoint endpoint = endpoint(registry);
        List<SocketChannel> flood = new ArrayList<>();
        int connected = 0;
        try {
            for (int i = 0; i < 300; i++) {
                SocketChannel raw = SocketChannel.open(StandardProtocolFamily.UNIX);
                flood.add(raw);
                try {
                    raw.connect(UnixDomainSocketAddress.of(endpoint.socket()));
                    connected++;
                } catch (IOException backlogFull) {
                    // A burst can fill the listen backlog; the attacker's loss, not the sender's.
                }
            }
            PeerClient.Result result = new PeerClient(registry, ProcessIdentity.current())
                    .send(record(ProcessIdentity.current(), endpoint.socket()), "peer", hello("through the flood"));
            assertTrue(result.sent(), String.valueOf(result.text()));
            awaitSize(received, 1);
            assertEquals("through the flood", received.getFirst().get("text").asText());
            assertTrue(endpoint.waitingToAuthenticate() <= PeerLimits.UNAUTHENTICATED_CAP,
                    endpoint.waitingToAuthenticate() + " connections wait to authenticate");
            assertTrue(connected > PeerLimits.UNAUTHENTICATED_CAP, connected + " flood connections");
            awaitDropped(endpoint, connected - PeerLimits.UNAUTHENTICATED_CAP);
            assertTrue(logLines().stream().anyMatch(l -> l.startsWith(
                    "Dropped a connection that did not authenticate (displaced by a newer connection)")),
                    logLines().toString());
        } finally {
            for (SocketChannel raw : flood) {
                raw.close();
            }
        }
    }

    @Test
    void theAcceptLoopGoesOnAfterATransientFailure() throws Exception {
        LiveRegistry registry = registry();
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        PeerEndpoint endpoint = new PeerEndpoint(registry, ProcessIdentity.current(), (frame, pid) -> {
            received.add(frame);
            verifiedPids.add(pid);
        }, PeerLimits.AUTH_TIMEOUT_MS, server -> {
            if (calls.incrementAndGet() == 1) {
                throw new IOException("too many open files");
            }
            return server.accept();
        });
        endpoint.start();
        closing.add(endpoint);
        PeerClient.Result result = new PeerClient(registry, ProcessIdentity.current(), 2_000)
                .send(record(ProcessIdentity.current(), endpoint.socket()), "peer", hello("after the failure"));
        assertTrue(result.sent(), String.valueOf(result.text()));
        awaitSize(received, 1);
        assertTrue(calls.get() >= 2, "accepted again after the failure");
    }

    @Test
    void theAcceptLoopEndsWhenTheEndpointCloses() throws Exception {
        LiveRegistry registry = registry();
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        PeerEndpoint endpoint = new PeerEndpoint(registry, ProcessIdentity.current(), (frame, pid) -> { },
                PeerLimits.AUTH_TIMEOUT_MS, server -> {
                    calls.incrementAndGet();
                    return server.accept();
                });
        endpoint.start();
        Thread.sleep(100);
        endpoint.close();
        Thread.sleep(300);
        int after = calls.get();
        Thread.sleep(300);
        assertEquals(after, calls.get(), "no accept after close");
        assertTrue(after <= 2, after + " accepts");
        assertTrue(logLines().stream().noneMatch(l -> l.startsWith("a peer accept failed")),
                "closing is not logged as a failed accept: " + logLines());
    }

    @Test
    void aRefusedConnectToAProcessThatStillRunsIsBusyNotGone() throws Exception {
        LiveRegistry registry = registry();
        Path socket = registry.socketPathFor(4);
        LiveRegistry.ensurePrivateDir(socket.getParent());
        ServerSocketChannel gone = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        gone.bind(UnixDomainSocketAddress.of(socket));
        gone.close(); // the file stays and every connect is refused
        assertTrue(Files.exists(socket));
        PeerClient.Result result = new PeerClient(registry, ProcessIdentity.current(), 400)
                .send(record(ProcessIdentity.current(), socket), "ForgeDemo-7f", hello("x"));
        assertEquals(PeerClient.Error.BUSY, result.error(), String.valueOf(result.text()));
    }

    @Test
    void aRefusedConnectToAProcessThatEndedIsGone() throws Exception {
        LiveRegistry registry = registry();
        Path socket = registry.socketPathFor(5);
        LiveRegistry.ensurePrivateDir(socket.getParent());
        ServerSocketChannel gone = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        gone.bind(UnixDomainSocketAddress.of(socket));
        gone.close();
        LiveRecord ended = record(new ProcessIdentity(ProcessHandle.current().pid(), "2001-01-01T00:00:00Z"),
                socket);
        long started = System.nanoTime();
        PeerClient.Result result = new PeerClient(registry, ProcessIdentity.current(), 3_000)
                .send(ended, "ForgeDemo-7f", hello("x"));
        assertEquals(PeerClient.Error.GONE, result.error(), String.valueOf(result.text()));
        assertTrue((System.nanoTime() - started) / 1_000_000 < 1_000, "answered without waiting out the timeout");
    }
}
