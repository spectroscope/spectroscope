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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * The process-boundary transport, hub side: a TCP server for
 * {@link ProcessBus} clients that is ALSO a local {@link BusTransport} —
 * the aggregator process subscribes in-process while remote nodes ride the
 * wire, and neither knows the difference.
 *
 * <p>Delivery semantics live in {@link HubCore} (bounded replay ring,
 * per-sender dedup, loud {@link BusGap}s); this shell adds the sockets and
 * ONE ordering rule: every publish-and-fan-out and every subscribe-and-replay
 * runs atomically under the hub lock, so a subscriber's replay can never be
 * overtaken by a racing live frame (which the cursor dedup would then
 * misread as history). NO consumer callback ever runs under that lock —
 * local subscribers drain their own bounded queue on their own thread
 * (review finding: a blocking local consumer must never freeze the fleet),
 * and a too-slow local consumer loses frames LOUDLY (a gap per incarnation,
 * naming only sequences actually lost), never silently. Slow remote subscribers are disconnected instead — they
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
    private final int localQueue;
    private final HubCore core;
    private final Map<String, List<LocalSubscriber>> localSubscribers = new LinkedHashMap<>();
    private final List<Connection> connections = new CopyOnWriteArrayList<>();
    private final ServerSocket server;
    private volatile Consumer<BusGap> onGap =
            gap -> log.warn("bus history lost before a local subscriber saw it: {}", gap);
    /** Fired on carded join/leave; null until someone cares. */
    private volatile Runnable onRosterChange;
    /** Roster signals run here, never on the caller — off the hub lock, in order. */
    private final ExecutorService rosterSignals = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "spectro-bus-roster");
        thread.setDaemon(true);
        return thread;
    });
    private volatile boolean closed = false;

    /** @param port the loopback port to bind, 0 for an ephemeral one */
    public ProcessBusHub(int port) throws IOException {
        this(port, 4096);
    }

    /** @param ringCapacity frames each topic retains for late subscribers */
    public ProcessBusHub(int port, int ringCapacity) throws IOException {
        this(port, ringCapacity, LOCAL_QUEUE);
    }

    /** @param localQueue frames a local subscriber may buffer before it loses loudly */
    public ProcessBusHub(int port, int ringCapacity, int localQueue) throws IOException {
        this.localQueue = localQueue;
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
     * A read-only snapshot of what the ring still holds for one topic, in
     * arrival order — the aggregator's replay source. Reading is not
     * consuming: no cursor moves, no subscription is created, and an unknown
     * topic is an empty world, not an error. The snapshot also carries the
     * gaps the ring has already evicted, so a caller can tell a complete
     * replay from a truncated one instead of guessing.
     *
     * @param topic the topic to snapshot
     * @return the ring's held frames (oldest first) and its evicted gaps
     */
    public RingReplay replay(String topic) {
        synchronized (lock) {
            HubCore.Replay replay = core.subscribe(topic, Map.of());
            return new RingReplay(replay.frames(), replay.gaps());
        }
    }

    /**
     * A read-only ring snapshot: the frames the ring still holds, plus the
     * gaps naming what it has already evicted.
     *
     * @param frames the ring's current frames for the topic, oldest first
     * @param gaps   the evicted stretches (empty when nothing was lost)
     */
    public record RingReplay(List<BusEnvelope> frames, List<BusGap> gaps) {
    }

    /**
     * Registers the roster-change signal: fired after a node's card joined
     * (its hello was processed) and after a carded connection left. The
     * listener is user code — it runs OFF the hub lock on the connection's
     * own thread, is guarded like the gap handler, and receives no payload:
     * pull {@link #roster()} for the current truth.
     *
     * @param listener called on every join and leave of a carded node
     * @return this hub, for fluent construction
     */
    public ProcessBusHub onRosterChange(Runnable listener) {
        this.onRosterChange = listener;
        return this;
    }

    /**
     * The roster listener is user code — guard it, log it, never die of it,
     * and NEVER run it on the caller's thread. A leave is signalled from
     * {@link Connection#shutDown()}, which is reachable from the fan-out path
     * with the hub lock held (a slow subscriber overflowing mid-publish, see
     * {@link Connection#enqueue}). Running the listener inline there would put
     * user code — and, through the aggregator, a second hub-lock acquisition —
     * under the lock, inverting lock order against a concurrent carded join
     * and deadlocking the hub. The single-thread signal executor keeps every
     * fire off the lock and in submission order.
     */
    private void fireRosterChange() {
        if (onRosterChange == null) {
            return;
        }
        try {
            rosterSignals.execute(() -> {
                Runnable listener = onRosterChange;
                if (listener == null) {
                    return;
                }
                try {
                    listener.run();
                } catch (RuntimeException broken) {
                    log.warn("roster listener failed: {}", broken.toString());
                }
            });
        } catch (RejectedExecutionException closing) {
            // the hub is shutting down — a roster signal no longer matters
        }
    }

    /**
     * The cards of every currently connected node, in connection order:
     * registration rides the hello, liveness is the connection — a vanished
     * node's card leaves with its socket. Card-less clients (panel taps,
     * plain subscribers) are not listed.
     *
     * @return the live fleet roster, newest connection last
     */
    public List<NodeCard> roster() {
        List<NodeCard> cards = new ArrayList<>();
        for (Connection connection : connections) {
            NodeCard card = connection.card;
            if (card != null) {
                cards.add(card);
            }
        }
        return List.copyOf(cards);
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

    /**
     * Reverse control (block 2): addresses a control verb to ONE node over its
     * live connection — the wire under "stop a running fleet node". Delivery IS
     * the addressing: the {@code ctl} line carries only the verb and rides the
     * writer queue of the connection whose {@code clientId} matches.
     *
     * <p><b>Best-effort, not at-least-once.</b> Unlike a published frame, a ctl
     * line has no outbox, no cumulative ack and no replay ring: a node that
     * never connected (or already left) is a no-op (a warn line, NEVER a throw —
     * a caller must not fail because a node vanished a millisecond earlier), and
     * a line enqueued to a connection that then drops before its writer flushes
     * is simply lost, not redelivered on reconnect. Reliable stop is therefore
     * the CALLER's job (block 3's server endpoint): re-issue {@code stop} — it is
     * idempotent — until the node leaves {@link #roster()}. A raw {@code spectro
     * node --linger} whose stop is lost is ended by SIGTERM.</p>
     *
     * @param nodeId the target node's id (its hello {@code clientId})
     * @param action the control verb, e.g. "stop"
     */
    public void control(String nodeId, String action) {
        String line = Wire.ctl(action);
        boolean delivered = false;
        synchronized (lock) {
            // Enqueue under the lock — the same ordering discipline every writer
            // enqueue follows. First match wins (an id collision is a documented
            // fleet limit; both would be stale copies of the same node).
            for (Connection connection : connections) {
                if (nodeId.equals(connection.clientId)) {
                    connection.enqueue(line);
                    delivered = true;
                    break;
                }
            }
        }
        if (!delivered) {
            log.warn("control({}, {}) — no connected node with that id", nodeId, action);
        }
    }

    /**
     * Reverse control, GATE answer (block 4): addresses the operator's verdict
     * for a permission request the node parked to ONE node over its live
     * connection. Rides the SAME best-effort channel as {@link #control} — no
     * outbox, no cumulative ack, no replay ring — so a server 202 means SENT,
     * not confirmed. If the node vanished or the line is lost before its writer
     * flushes, the gate stays parked; the node's own run-end and close deny
     * orphaned futures, and {@code stop} is the escape hatch. An unknown or
     * departed node is a no-op warn, never a throw (the endpoint leans on this).
     *
     * @param nodeId the target node's id (its hello {@code clientId})
     * @param callId the parked permission request's call id
     * @param allow  the operator's verdict — true to run the tool, false to deny
     */
    public void controlGate(String nodeId, String callId, boolean allow) {
        String line = Wire.ctl("gate", callId, allow);
        boolean delivered = false;
        synchronized (lock) {
            // Enqueue under the lock — the same ordering discipline as control().
            for (Connection connection : connections) {
                if (nodeId.equals(connection.clientId)) {
                    connection.enqueue(line);
                    delivered = true;
                    break;
                }
            }
        }
        if (!delivered) {
            log.warn("controlGate({}, {}) — no connected node with that id", nodeId, callId);
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
        List<BusGap> replayGaps;
        synchronized (lock) {
            HubCore.Replay replay = core.subscribe(topic, Map.of());
            replayGaps = replay.gaps();
            for (BusEnvelope env : replay.frames()) {
                subscriber.enqueue(env);
            }
            localSubscribers.computeIfAbsent(topic, t -> new ArrayList<>()).add(subscriber);
        }
        // The gap handler is user code — it runs AFTER the lock, like every
        // other callback here, or a blocking handler freezes the fleet.
        replayGaps.forEach(this::announceGap);
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
        rosterSignals.shutdown();
        try {
            // let any in-flight roster signal drain — a caller that closes the
            // hub then reads the roster count sees a settled tally, not a race.
            rosterSignals.awaitTermination(5, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
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
     * queue overflows, frames are dropped LOUDLY — the dropped stretches are
     * tracked per incarnation in a {@link DropLedger} and announced through
     * the gap handler, naming only sequences that were actually lost.
     */
    private final class LocalSubscriber {

        private final Consumer<BusEnvelope> consumer;
        private final ArrayBlockingQueue<BusEnvelope> queue = new ArrayBlockingQueue<>(localQueue);
        /** Contiguous dropped stretches per (topic, sender, epoch); guarded by this. */
        private final DropLedger dropped = new DropLedger();
        private final Thread drain;
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
                dropped.record(env.topic(), env.sender(), env.epoch(), env.sequence());
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
                return dropped.drain();
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
        /** The node's self-description from its hello; null for plain clients. */
        private volatile NodeCard card;

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
                case Wire.Hello(String id, java.util.Optional<NodeCard> helloCard) -> {
                    clientId = id;
                    card = helloCard.orElse(null);
                    if (card != null) {
                        // Reader thread, no hub lock held — the listener
                        // discipline every callback here follows.
                        fireRosterChange();
                    }
                }
                case Wire.Sub(String topic, Map<String, Map<Long, Long>> cursor) -> {
                    synchronized (lock) {
                        HubCore.Replay replay = core.subscribe(topic, cursor);
                        topics.add(topic);
                        for (BusGap gap : replay.gaps()) {
                            enqueue(Wire.gap(gap.topic(), gap.sender(), gap.epoch(),
                                    gap.fromSeq(), gap.toSeq()));
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
                        enqueue(Wire.ack(frame.topic(), frame.sender(), frame.epoch(),
                                core.highWater(frame.topic(), frame.sender(), frame.epoch())));
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
            // remove() answers exactly once per connection — the guard that
            // keeps the roster signal from double-firing out of the several
            // paths (reader death, writer death, hub close) that land here.
            if (connections.remove(this) && card != null) {
                fireRosterChange();
            }
        }
    }
}
