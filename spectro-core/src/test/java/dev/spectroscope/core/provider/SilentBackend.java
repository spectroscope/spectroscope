package dev.spectroscope.core.provider;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * A loopback backend that never answers, for the stop tests of card 557.
 *
 * <p>{@link Mode#ACCEPTING}: every connection is accepted and read, and not one
 * byte is written back. Over {@code http} the client sends its request and
 * waits for response headers that never come. Over {@code https} the client
 * sends its TLS ClientHello and waits for a ServerHello that never comes, so
 * the connection is never established: the local stand-in for a host that
 * does not answer, without depending on how a network drops packets.</p>
 *
 * <p>{@link Mode#NEVER_ACCEPTING}: the socket listens and {@code accept()} is
 * never called while the test runs. The kernel completes the TCP handshake
 * and queues the connection; the request sits in the socket buffer. A
 * selector tells the test that a connection is queued without taking it
 * ({@link #awaitQueued}). {@link #drainQueued} accepts the queue afterwards
 * and reports, per connection, whether the client has closed it.</p>
 *
 * <p>{@link Mode#FULL_QUEUE}: the socket listens with a queue of one and is
 * filled with connections it never accepts, until the kernel stops answering
 * new ones. A further dial then gets no answer to its SYN at all, which is
 * what a host behind a dead VPN does, and its connect waits until a timeout
 * ends it. {@link #dropsNewConnections} says whether this kernel did that.</p>
 */
final class SilentBackend implements AutoCloseable {

    enum Mode { ACCEPTING, NEVER_ACCEPTING, FULL_QUEUE }

    /** One accepted connection: when it came, what it sent, when the client closed it. */
    static final class Peer {
        final Socket socket;
        final long acceptedAtNanos = System.nanoTime();
        final StringBuffer head = new StringBuffer();
        final CountDownLatch firstBytes = new CountDownLatch(1);
        volatile long closedAtNanos = -1;

        Peer(Socket socket) {
            this.socket = socket;
        }

        /** @return what arrived so far, read as ISO-8859-1 */
        String head() {
            return head.toString();
        }
    }

    /** What {@link #drainQueued} found in the accept queue. */
    record Queue(int connections, int closedByClient) {}

    private final ServerSocket server;          // ACCEPTING
    private final ServerSocketChannel listening; // NEVER_ACCEPTING
    private final Selector selector;             // NEVER_ACCEPTING: sees a queued connection
    private final List<SocketChannel> fillers = new ArrayList<>(); // FULL_QUEUE
    private boolean dropsNewConnections;         // FULL_QUEUE
    private final Mode mode;
    private final List<Peer> peers = new CopyOnWriteArrayList<>();
    private final LinkedBlockingQueue<Peer> arrivals = new LinkedBlockingQueue<>();
    private volatile boolean closed;

    SilentBackend(Mode mode) throws IOException {
        this.mode = mode;
        if (mode == Mode.ACCEPTING) {
            this.server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
            this.listening = null;
            this.selector = null;
            Thread acceptor = new Thread(this::acceptLoop, "silent-backend-accept");
            acceptor.setDaemon(true);
            acceptor.start();
        } else if (mode == Mode.NEVER_ACCEPTING) {
            this.server = null;
            this.listening = ServerSocketChannel.open();
            listening.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 50);
            listening.configureBlocking(false);
            this.selector = Selector.open();
            listening.register(selector, SelectionKey.OP_ACCEPT);
        } else {
            this.server = null;
            this.selector = null;
            this.listening = ServerSocketChannel.open();
            listening.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 1);
            fill();
        }
    }

    /** Dials the listening socket until a dial stays unanswered, or gives up after sixteen. */
    private void fill() throws IOException {
        InetSocketAddress address = (InetSocketAddress) listening.getLocalAddress();
        for (int i = 0; i < 16 && !dropsNewConnections; i++) {
            SocketChannel filler = SocketChannel.open();
            filler.configureBlocking(false);
            fillers.add(filler);
            boolean connected = filler.connect(address);
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(300);
            while (!connected && System.nanoTime() < deadline) {
                connected = filler.finishConnect();
                if (!connected) {
                    try {
                        Thread.sleep(10);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            }
            dropsNewConnections = !connected;
        }
    }

    /** @return true when this kernel left a dial to the full queue unanswered ({@link Mode#FULL_QUEUE}) */
    boolean dropsNewConnections() {
        return dropsNewConnections;
    }

    /**
     * @param scheme {@code http} or {@code https}
     * @return the base URL a provider dials
     */
    String url(String scheme) throws IOException {
        int port = server != null ? server.getLocalPort()
                : ((InetSocketAddress) listening.getLocalAddress()).getPort();
        return scheme + "://127.0.0.1:" + port;
    }

    /**
     * Waits until a connection sits in the accept queue, without accepting it
     * ({@link Mode#NEVER_ACCEPTING} only).
     *
     * @param timeout how long to wait
     * @return true once a connection is queued
     * @throws IOException when the selector fails
     */
    boolean awaitQueued(Duration timeout) throws IOException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            long left = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
            if (selector.select(Math.max(1, left)) > 0) {
                return true;
            }
        }
        return false;
    }

    private void acceptLoop() {
        while (!closed) {
            Socket socket;
            try {
                socket = server.accept();
            } catch (IOException stopped) {
                return;
            }
            Peer peer = new Peer(socket);
            peers.add(peer);
            arrivals.add(peer);
            Thread reader = new Thread(() -> read(peer), "silent-backend-read");
            reader.setDaemon(true);
            reader.start();
        }
    }

    private static void read(Peer peer) {
        byte[] buffer = new byte[4096];
        try {
            InputStream in = peer.socket.getInputStream();
            int n;
            while ((n = in.read(buffer)) >= 0) {
                if (peer.head.length() < 16_384) {
                    peer.head.append(new String(buffer, 0, n, StandardCharsets.ISO_8859_1));
                }
                peer.firstBytes.countDown();
            }
        } catch (IOException reset) {
            // a reset is the client closing too
        }
        peer.closedAtNanos = System.nanoTime();
    }

    /**
     * Waits for the next accepted connection ({@link Mode#ACCEPTING} only).
     *
     * @param timeout how long to wait
     * @return the connection, or null when none came in time
     * @throws InterruptedException when the test thread is interrupted
     */
    Peer awaitConnection(Duration timeout) throws InterruptedException {
        return arrivals.poll(timeout.toMillis(), TimeUnit.MILLISECONDS);
    }

    /** @return how many connections were accepted so far ({@link Mode#ACCEPTING}) */
    int connections() {
        return peers.size();
    }

    /**
     * Waits until the client has closed every accepted connection.
     *
     * @param timeout how long to wait
     * @return how many are still open when the wait ends
     * @throws InterruptedException when the test thread is interrupted
     */
    long openAfter(Duration timeout) throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            if (stillOpen() == 0) {
                return 0;
            }
            Thread.sleep(5);
        }
        return stillOpen();
    }

    private long stillOpen() {
        return peers.stream().filter(p -> p.closedAtNanos < 0).count();
    }

    /**
     * Accepts what the kernel queued ({@link Mode#NEVER_ACCEPTING}) and reads
     * each connection to its end. A read that ends (EOF or reset) within the
     * wait means the client has closed it; a read that times out means the
     * client still holds it open.
     *
     * @param perConnection how long each connection gets to show its end
     * @return how many connections were queued, and how many of them the client closed
     * @throws IOException when the listening socket fails
     */
    Queue drainQueued(Duration perConnection) throws IOException {
        if (mode != Mode.NEVER_ACCEPTING) {
            throw new IllegalStateException("only a never-accepting backend has a queue to drain");
        }
        selector.close(); // deregisters the channel, so its sockets can block
        List<Socket> queued = new ArrayList<>();
        SocketChannel next;
        while ((next = listening.accept()) != null) {
            next.configureBlocking(true);
            queued.add(next.socket());
        }
        int closedByClient = 0;
        byte[] buffer = new byte[4096];
        for (Socket socket : queued) {
            try (socket) {
                socket.setSoTimeout((int) perConnection.toMillis());
                InputStream in = socket.getInputStream();
                while (in.read(buffer) >= 0) {
                    // the request the client wrote before it went away
                }
                closedByClient++;
            } catch (SocketTimeoutException stillHeld) {
                // the client has not closed it
            } catch (IOException reset) {
                closedByClient++;
            }
        }
        return new Queue(queued.size(), closedByClient);
    }

    @Override
    public void close() throws IOException {
        closed = true;
        if (server != null) {
            server.close();
        } else {
            if (selector != null) {
                selector.close();
            }
            for (SocketChannel filler : fillers) {
                filler.close();
            }
            listening.close();
        }
        for (Peer peer : peers) {
            try {
                peer.socket.close();
            } catch (IOException ignored) {
                // already gone
            }
        }
    }
}
