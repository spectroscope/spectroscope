package dev.spectroscope.orchestrator;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

/**
 * The process-boundary transport, hub side (card 22, KONZEPT §9 P1): a TCP
 * server for {@link ProcessBus} clients that is ALSO a local
 * {@link BusTransport} — the aggregator process subscribes in-process while
 * remote nodes ride the wire, and neither knows the difference.
 *
 * <p>Delivery semantics live in {@link HubCore} (bounded replay ring,
 * per-sender dedup, loud {@link BusGap}s); this shell adds the sockets and
 * ONE ordering rule: every publish-and-fan-out and every subscribe-and-replay
 * runs atomically under the hub lock, so a subscriber's replay can never be
 * overtaken by a racing live frame (which the cursor dedup would then
 * misread as history). NO consumer callback ever runs under that lock —
 * local subscribers drain their own bounded queue on their own thread
 * (review finding: a blocking local consumer must never freeze the fleet),
 * and a too-slow local consumer loses frames LOUDLY (per-sender gap), never
 * silently. Slow remote subscribers are disconnected instead — they
 * reconnect and heal from the ring. A line the hub cannot parse kills that
 * connection: skipping it would let the next cumulative ack trim a frame
 * nobody accepted.</p>
 */
public final class ProcessBusHub implements BusTransport {

    private static final Logger log = LoggerFactory.getLogger(ProcessBusHub.class);

    /** Wire lines a connection may buffer before it counts as too slow. */
    private static final int CONNECTION_QUEUE = 256;

    /** Frames a local subscriber may buffer before it starts losing loudly. */
    private static final int LOCAL_QUEUE = 1024;

    private final ObjectMapper mapper = new ObjectMapper();
    /** One lock serializes core access and fan-out enqueue order. */
    private final Object lock = new Object();
    private final HubCore core;
    private final Map<String, List<LocalSubscriber>> localSubscribers = new LinkedHashMap<>();
    private final List<Connection> connections = new CopyOnWriteArrayList<>();
    private final ServerSocket server;
    private volatile Consumer<BusGap> onGap =
            gap -> log.warn("bus history lost before a local subscriber saw it: {}", gap);
    private volatile boolean closed = false;

    /** @param port the loopback port to bind, 0 for an ephemeral one */
    public ProcessBusHub(int port) throws IOException {
        this(port, 4096);
    }

    /** @param ringCapacity frames each topic retains for late subscribers */
    public ProcessBusHub(int port, int ringCapacity) throws IOException {
        this.core = new HubCore(ringCapacity);
        this.server = new ServerSocket();
        try {
            server.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), port));
        } catch (IOException bindFailed) {
            try {
                server.close(); // the unbound socket already owns an FD
            } catch (IOException ignored) {
                // nothing left to release
            }
            throw bindFailed;
        }
        Thread.ofVirtual().name("spectro-bus-hub-accept").start(this::acceptLoop);
    }

    /** @return the actually bound port (matters for port 0) */
    public int port() {
        return server.getLocalPort();
    }

    /**
     * Replaces the default gap handler for LOCAL subscribers (remote ones
     * hear gaps over the wire). The handler is guarded: its failure is
     * logged, never fatal.
     *
     * @param handler receives every evicted or dropped stretch
     * @return this hub, for fluent construction
     */
    public ProcessBusHub onGap(Consumer<BusGap> handler) {
        this.onGap = handler;
        return this;
    }

    /**
     * Forgets one topic — ring, high-waters, everything. The aggregator
     * calls this after a fleet session ended; without retirement a
     * long-lived hub pins every run's ring forever.
     */
    public void retire(String topic) {
        synchronized (lock) {
            core.retire(topic);
        }
    }

    /** The local (aggregator-side) publish: no wire, no outbox — the ring
     *  IS the durability this transport offers. */
    @Override
    public void publish(BusEnvelope frame) {
        synchronized (lock) {
            core.publish(frame).ifPresent(this::fanOutLocked);
        }
    }

    /** The local subscribe: replay enqueued under the lock (no live frame
     *  can overtake it), consumed on the subscriber's own drain thread. */
    @Override
    public AutoCloseable subscribe(String topic, Consumer<BusEnvelope> onFrame) {
        LocalSubscriber subscriber = new LocalSubscriber(onFrame);
        synchronized (lock) {
            HubCore.Replay replay = core.subscribe(topic, Map.of());
            replay.gaps().forEach(this::announceGap);
            for (BusEnvelope env : replay.frames()) {
                subscriber.enqueue(env);
            }
            localSubscribers.computeIfAbsent(topic, t -> new ArrayList<>()).add(subscriber);
        }
        return () -> {
            synchronized (lock) {
                List<LocalSubscriber> list = localSubscribers.get(topic);
                if (list != null) {
                    list.remove(subscriber);
                    if (list.isEmpty()) {
                        localSubscribers.remove(topic);
                    }
                }
            }
            subscriber.shutDown();
        };
    }

    /** Idempotent: stops accepting, drops every connection and local drain. */
    @Override
    public void close() {
        closed = true;
        try {
            server.close();
        } catch (IOException ignored) {
            // a closing server socket cannot fail meaningfully
        }
        for (Connection connection : connections) {
            connection.shutDown();
        }
        synchronized (lock) {
            localSubscribers.values().forEach(list -> list.forEach(LocalSubscriber::shutDown));
            localSubscribers.clear();
        }
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                // Registration BEFORE the reader starts: a connection that can
                // already subscribe must already be fanned out to, or a racing
                // live frame vanishes between its replay and its membership.
                Connection connection = new Connection(server.accept());
                connections.add(connection);
                connection.start();
                if (closed) {
                    connection.shutDown(); // close() raced the accept — sweep it
                }
            } catch (IOException stopped) {
                if (!closed) {
                    log.warn("hub accept loop died: {}", stopped.toString());
                }
                return;
            }
        }
    }

    /** Caller holds the lock. Enqueue order equals delivery order — for
     *  remote connections and local drains alike. */
    private void fanOutLocked(BusEnvelope env) {
        String line = null;
        for (Connection connection : connections) {
            if (!connection.topics.contains(env.topic())) {
                continue;
            }
            if (line == null) {
                line = Wire.pub(env, mapper);
            }
            connection.enqueue(line);
        }
        for (LocalSubscriber subscriber :
                localSubscribers.getOrDefault(env.topic(), List.of())) {
            subscriber.enqueue(env);
        }
    }

    /** The gap handler is user code — guard it, log it, never die of it. */
    private void announceGap(BusGap gap) {
        try {
            onGap.accept(gap);
        } catch (RuntimeException broken) {
            log.warn("gap handler failed for {}: {}", gap, broken.toString());
        }
    }

    /**
     * One local (in-process) subscriber: a bounded queue drained on its own
     * virtual thread, so no consumer ever runs under the hub lock. When the
     * queue overflows, frames are dropped LOUDLY — the dropped stretch is
     * coalesced per sender and announced through the gap handler.
     */
    private final class LocalSubscriber {

        private final Consumer<BusEnvelope> consumer;
        private final ArrayBlockingQueue<BusEnvelope> queue = new ArrayBlockingQueue<>(LOCAL_QUEUE);
        /** sender → [firstDropped, lastDropped]; guarded by this. */
        private final Map<String, long[]> dropped = new LinkedHashMap<>();
        private final Thread drain;
        private String droppedTopic;
        private boolean warnedBroken = false;

        private LocalSubscriber(Consumer<BusEnvelope> consumer) {
            this.consumer = consumer;
            this.drain = Thread.ofVirtual().name("spectro-bus-local-drain").start(this::drainLoop);
        }

        /** Caller holds the hub lock; offer keeps it non-blocking. */
        private void enqueue(BusEnvelope env) {
            if (queue.offer(env)) {
                return;
            }
            synchronized (this) {
                droppedTopic = env.topic();
                long[] range = dropped.computeIfAbsent(env.sender(),
                        sender -> new long[] {env.sequence(), env.sequence()});
                range[1] = env.sequence();
            }
        }

        private void drainLoop() {
            try {
                while (true) {
                    BusEnvelope env = queue.take();
                    for (BusGap gap : pendingGaps()) {
                        announceGap(gap);
                    }
                    try {
                        consumer.accept(env);
                    } catch (RuntimeException broken) {
                        if (!warnedBroken) {
                            warnedBroken = true;
                            log.warn("local bus consumer {} failed (suppressing further warnings): {}",
                                    consumer.getClass().getSimpleName(), broken.toString());
                        }
                    }
                }
            } catch (InterruptedException stopped) {
                Thread.currentThread().interrupt();
            }
        }

        private List<BusGap> pendingGaps() {
            synchronized (this) {
                if (dropped.isEmpty()) {
                    return List.of();
                }
                List<BusGap> gaps = new ArrayList<>();
                dropped.forEach((sender, range) ->
                        gaps.add(new BusGap(droppedTopic, sender, range[0], range[1])));
                dropped.clear();
                return gaps;
            }
        }

        private void shutDown() {
            drain.interrupt();
        }
    }

    /** One remote client: a reader thread parses ops, a writer thread drains
     *  the bounded line queue. Overflow means the subscriber is too slow —
     *  it is disconnected and heals from the ring on reconnect. */
    private final class Connection {

        private final Socket socket;
        private final ArrayBlockingQueue<String> outgoing = new ArrayBlockingQueue<>(CONNECTION_QUEUE);
        private final java.util.Set<String> topics = ConcurrentHashMap.newKeySet();
        private Thread writer;
        private volatile String clientId = "?";

        private Connection(Socket socket) {
            this.socket = socket;
        }

        /** Threads start only AFTER the hub lists this connection — the
         *  fan-out must already see whoever is able to subscribe. */
        private void start() {
            this.writer = Thread.ofVirtual().name("spectro-bus-hub-writer").start(this::writeLoop);
            Thread.ofVirtual().name("spectro-bus-hub-reader").start(this::readLoop);
        }

        /** Caller holds the hub lock (the ordering rule lives there). */
        private void enqueue(String line) {
            if (!outgoing.offer(line)) {
                log.warn("subscriber {} too slow — disconnecting; it heals from the ring", clientId);
                shutDown();
            }
        }

        private void readLoop() {
            try (BufferedReader in = new BufferedReader(
                    new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = in.readLine()) != null) {
                    try {
                        handle(Wire.parse(line, mapper));
                    } catch (RuntimeException poison) {
                        // Skipping a bad line would let the next cumulative ack
                        // trim a frame nobody accepted — kill the connection
                        // instead; the client reconnects and the loss stays loud.
                        log.warn("protocol failure from {} — dropping the connection: {}",
                                clientId, poison.toString());
                        return;
                    }
                }
            } catch (IOException wireDead) {
                // the client vanished — reconnecting is its job, not ours
            } finally {
                shutDown();
            }
        }

        private void handle(Wire.Msg msg) {
            switch (msg) {
                case Wire.Hello(String id) -> clientId = id;
                case Wire.Sub(String topic, Map<String, Long> cursor) -> {
                    synchronized (lock) {
                        HubCore.Replay replay = core.subscribe(topic, cursor);
                        topics.add(topic);
                        for (BusGap gap : replay.gaps()) {
                            enqueue(Wire.gap(gap.topic(), gap.sender(), gap.fromSeq(), gap.toSeq()));
                        }
                        for (BusEnvelope env : replay.frames()) {
                            enqueue(Wire.pub(env, mapper));
                        }
                    }
                }
                case Wire.Pub(BusEnvelope frame) -> {
                    synchronized (lock) {
                        var fresh = core.publish(frame);
                        // Ack even a duplicate — redelivery deserves its trim.
                        enqueue(Wire.ack(frame.topic(), frame.sender(),
                                core.highWater(frame.topic(), frame.sender())));
                        fresh.ifPresent(ProcessBusHub.this::fanOutLocked);
                    }
                }
                default -> log.warn("unexpected op from {}: {}", clientId, msg);
            }
        }

        private void writeLoop() {
            try (BufferedWriter out = new BufferedWriter(
                    new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8))) {
                while (true) {
                    String line = outgoing.take();
                    out.write(line);
                    out.write('\n');
                    out.flush();
                }
            } catch (IOException | InterruptedException done) {
                if (done instanceof InterruptedException) {
                    Thread.currentThread().interrupt();
                }
            } finally {
                shutDown();
            }
        }

        private void shutDown() {
            try {
                socket.close();
            } catch (IOException ignored) {
                // closing a dying socket cannot fail meaningfully
            }
            if (writer != null) {
                writer.interrupt();
            }
            connections.remove(this);
        }
    }
}
