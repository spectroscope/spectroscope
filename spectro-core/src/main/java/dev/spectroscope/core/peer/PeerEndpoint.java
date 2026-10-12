package dev.spectroscope.core.peer;

import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.OutputStream;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.Channels;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HexFormat;
import java.util.Optional;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * One process's inbox socket (card 502 criterion 3): a Unix domain socket at
 * the path the record names, mode 0600 in a 0700 directory, with a per process
 * token in {@code <pid>.key}, mode 0600.
 *
 * <p>The endpoint writes {@code hello} first, so the sender can check the pid
 * it reached against the registry before it writes anything. The first frame
 * it reads must be {@code auth} with the token and the sender's pid and start
 * instant; the stated pid is checked against the process table. A connection
 * that sends anything else first, offers a wrong token, states a pid that does
 * not check out, sends a first line longer than the cap, or sends nothing
 * within {@link PeerLimits#AUTH_TIMEOUT_MS} is closed, counted and logged with
 * the count. At most {@link PeerLimits#UNAUTHENTICATED_CAP} connections wait
 * to authenticate; a newer one displaces the oldest, which is counted the same
 * way. A line longer than the cap closes the connection. A failed accept is
 * logged and accepting goes on until the endpoint closes. No body is ever
 * logged.</p>
 *
 * <p>Java 21 reads no peer pid off a Unix domain socket ({@code SO_PEERCRED}
 * gives the user and the group only), so the pid the receiver records is the
 * one the sender states in its auth frame, accepted only when a live process
 * of that pid has the stated start instant and the sender held the token. A
 * process that can read the token can state another live pid with its true
 * start; the token file is mode 0600, so that process runs as the same user
 * (card 502, open owner decision on a native pid read).</p>
 */
public final class PeerEndpoint implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(PeerEndpoint.class);

    /** What an authenticated frame is handed to. */
    public interface Handler {
        /**
         * @param frame           the frame
         * @param verifiedPeerPid the sender's pid, checked as the class javadoc says
         */
        void onFrame(JsonNode frame, long verifiedPeerPid);
    }

    /** How the accept loop takes the next connection; a seam for a failing accept. */
    interface Acceptor {
        /**
         * @param server the listening channel
         * @return the next connection
         * @throws IOException when the accept fails
         */
        SocketChannel accept(ServerSocketChannel server) throws IOException;
    }

    private final LiveRegistry registry;
    private final ProcessIdentity self;
    private final Handler handler;
    private final AtomicLong dropped = new AtomicLong();
    private final int authTimeoutMs;
    private final Acceptor acceptor;
    private final Deque<Conn> waiting = new ArrayDeque<>();
    private final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "spectro-peer-auth-deadline");
        thread.setDaemon(true);
        return thread;
    });
    private volatile ServerSocketChannel server;
    private volatile String token;
    private volatile Path socket;

    /**
     * @param registry where the socket and the key live
     * @param self     this process
     * @param handler  where authenticated frames go
     */
    public PeerEndpoint(LiveRegistry registry, ProcessIdentity self, Handler handler) {
        this(registry, self, handler, PeerLimits.AUTH_TIMEOUT_MS);
    }

    /**
     * @param registry      where the socket and the key live
     * @param self          this process
     * @param handler       where authenticated frames go
     * @param authTimeoutMs how long a new connection may take to authenticate
     */
    PeerEndpoint(LiveRegistry registry, ProcessIdentity self, Handler handler, int authTimeoutMs) {
        this(registry, self, handler, authTimeoutMs, ServerSocketChannel::accept);
    }

    /**
     * @param registry      where the socket and the key live
     * @param self          this process
     * @param handler       where authenticated frames go
     * @param authTimeoutMs how long a new connection may take to authenticate
     * @param acceptor      how the accept loop takes the next connection
     */
    PeerEndpoint(LiveRegistry registry, ProcessIdentity self, Handler handler, int authTimeoutMs,
                 Acceptor acceptor) {
        this.registry = registry;
        this.self = self;
        this.handler = handler;
        this.authTimeoutMs = authTimeoutMs;
        this.acceptor = acceptor;
    }

    private enum State {
        WAITING,
        AUTHENTICATED,
        CUT
    }

    /** One accepted connection; it leaves {@code WAITING} exactly once. */
    private final class Conn {
        final SocketChannel channel;
        final AtomicReference<State> state = new AtomicReference<>(State.WAITING);

        Conn(SocketChannel channel) {
            this.channel = channel;
        }

        /** Closes a connection that has not authenticated, and counts it once. */
        void cut(String reason) {
            if (state.compareAndSet(State.WAITING, State.CUT)) {
                forget(this);
                closeQuietly(channel);
                refused(reason);
            }
        }

        /** @return true when the connection was still waiting and now counts as authenticated */
        boolean authenticate() {
            if (state.compareAndSet(State.WAITING, State.AUTHENTICATED)) {
                forget(this);
                return true;
            }
            return false;
        }
    }

    /**
     * Binds the socket, writes the key and starts accepting.
     *
     * @throws IOException when the socket cannot be bound
     */
    public void start() throws IOException {
        registry.ensureDir();
        Path path = registry.socketPathFor(self.pid());
        LiveRegistry.ensurePrivateDir(path.getParent());
        Files.deleteIfExists(path);
        ServerSocketChannel channel = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        channel.bind(UnixDomainSocketAddress.of(path));
        LiveRegistry.setPrivate(path);
        byte[] secret = new byte[32];
        new SecureRandom().nextBytes(secret);
        String minted = HexFormat.of().formatHex(secret);
        Path key = registry.keyPathFor(self.pid());
        Files.deleteIfExists(key);
        try {
            Files.createFile(key, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        } catch (UnsupportedOperationException noPosix) {
            Files.createFile(key);
        }
        Files.writeString(key, minted);
        this.token = minted;
        this.socket = path;
        this.server = channel;
        Thread.ofVirtual().name("spectro-peer-accept").start(this::acceptLoop);
    }

    /** @return the socket path */
    public Path socket() {
        return socket;
    }

    /** @return this process's token */
    public String token() {
        return token;
    }

    /** @return connections open now that have not authenticated yet */
    public int waitingToAuthenticate() {
        synchronized (waiting) {
            return waiting.size();
        }
    }

    /** @return connections closed because they did not authenticate */
    public long droppedUnauthenticated() {
        return dropped.get();
    }

    @Override
    public void close() {
        deadlines.shutdownNow();
        ServerSocketChannel channel = server;
        server = null;
        if (channel != null) {
            try {
                channel.close();
            } catch (IOException ignored) {
                // Closing is all that is left to do.
            }
        }
        try {
            if (socket != null) {
                Files.deleteIfExists(socket);
            }
            Files.deleteIfExists(registry.keyPathFor(self.pid()));
        } catch (IOException ignored) {
            // The registry reader unlinks what is left.
        }
    }

    private void acceptLoop() {
        while (true) {
            ServerSocketChannel channel = server;
            if (channel == null || !channel.isOpen()) {
                return;
            }
            SocketChannel connection;
            try {
                connection = acceptor.accept(channel);
            } catch (IOException failed) {
                if (server == null || !channel.isOpen()) {
                    return;
                }
                log.warn("a peer accept failed ({}); accepting goes on", failed.toString());
                pause();
                continue;
            }
            Conn conn = new Conn(connection);
            Conn displaced = null;
            synchronized (waiting) {
                waiting.addLast(conn);
                if (waiting.size() > PeerLimits.UNAUTHENTICATED_CAP) {
                    displaced = waiting.pollFirst();
                }
            }
            // The accept loop only queues and hands off, so a burst of
            // connections drains the listen backlog as fast as it fills.
            Conn oldest = displaced;
            Thread.ofVirtual().name("spectro-peer-conn").start(() -> {
                if (oldest != null) {
                    oldest.cut("displaced by a newer connection");
                }
                serve(conn);
            });
        }
    }

    private static void pause() {
        try {
            Thread.sleep(50);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private void forget(Conn conn) {
        synchronized (waiting) {
            waiting.remove(conn);
        }
    }

    private void serve(Conn conn) {
        SocketChannel connection = conn.channel;
        ScheduledFuture<?> deadline;
        try {
            deadline = deadlines.schedule(() -> conn.cut("no auth within " + authTimeoutMs + " ms"),
                    authTimeoutMs, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException closing) {
            forget(conn);
            closeQuietly(connection);
            return;
        }
        try (connection) {
            OutputStream out = Channels.newOutputStream(connection);
            out.write((PeerFrames.line(PeerFrames.hello(self.pid(), self.procStart())) + "\n")
                    .getBytes(StandardCharsets.UTF_8));
            out.flush();
            LineReader in = new LineReader(Channels.newInputStream(connection));
            String first;
            try {
                first = in.readLine();
            } catch (LineReader.LineTooLong tooLong) {
                conn.cut("the first line was over the cap");
                return;
            }
            if (first == null) {
                return; // a probe connected and let go, or the connection was cut
            }
            Optional<JsonNode> auth = PeerFrames.parse(first).filter(f -> "auth".equals(f.path("type").asText()));
            if (auth.isEmpty()) {
                conn.cut("the first frame was not auth");
                return;
            }
            String refusal = refusal(auth.get());
            if (refusal != null) {
                conn.cut(refusal);
                return;
            }
            if (!conn.authenticate()) {
                return; // cut at the deadline or displaced while the auth was checked
            }
            deadline.cancel(false);
            long pid = auth.get().path("pid").asLong();
            for (String line = in.readLine(); line != null; line = in.readLine()) {
                Optional<JsonNode> frame = PeerFrames.parse(line);
                if (frame.isEmpty() || "auth".equals(frame.get().path("type").asText())) {
                    continue;
                }
                try {
                    handler.onFrame(frame.get(), pid);
                } catch (RuntimeException failure) {
                    log.warn("peer frame from pid {} failed: {}", pid, failure.toString());
                }
            }
        } catch (LineReader.LineTooLong tooLong) {
            log.info("a peer frame line over {} characters; closing the connection", PeerLimits.LINE_CAP_CHARS);
        } catch (IOException gone) {
            // The sender went away, or the connection was cut; a cut is counted where it happens.
        } finally {
            deadline.cancel(false);
            forget(conn);
        }
    }

    /** Counts one connection that did not authenticate and logs the count, never a body. */
    private void refused(String reason) {
        long total = dropped.incrementAndGet();
        log.info("Dropped a connection that did not authenticate ({}); {} in all", reason, total);
    }

    private static void closeQuietly(SocketChannel connection) {
        try {
            connection.close();
        } catch (IOException ignored) {
            // Closed already.
        }
    }

    /** @return why an auth frame is refused, or null when it checks out */
    private String refusal(JsonNode auth) {
        String offered = auth.path("token").asText("");
        String mine = token;
        if (mine == null || !MessageDigest.isEqual(offered.getBytes(StandardCharsets.UTF_8),
                mine.getBytes(StandardCharsets.UTF_8))) {
            return "wrong token";
        }
        long pid = auth.path("pid").asLong(-1);
        String start = auth.path("procStart").asText("");
        Optional<String> actual = pid <= 0 ? Optional.empty() : registry.liveness().startOf(pid);
        return actual.isPresent() && actual.get().equals(start) ? null
                : "the stated pid is not a live process with that start";
    }
}
