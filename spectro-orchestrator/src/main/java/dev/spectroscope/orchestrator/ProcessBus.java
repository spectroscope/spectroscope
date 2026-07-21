package dev.spectroscope.orchestrator;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

/**
 * The process-boundary transport, client side: one TCP connection to a
 * {@link ProcessBusHub}, newline-framed wire ops, and three day-one
 * guarantees no distributed fleet should launch without —
 * auto-reconnect with capped backoff, at-least-once via a bounded outbox
 * that reflushes on reconnect (a full outbox blocks the publisher: the
 * EventStream discipline, never a silent drop), and a per-sender cursor
 * that resumes replay and makes wire redelivery invisible to consumers.
 *
 * <p>Evicted history arrives as a {@link BusGap} through {@link #onGap} —
 * loss is survivable, hiding it is not. Consumers run on the connection's
 * reader thread: hand heavy work off (the panel's queue sink is the model),
 * and do not publish from a consumer while the outbox is saturated.</p>
 */
public final class ProcessBus implements BusTransport {

    private static final Logger log = LoggerFactory.getLogger(ProcessBus.class);

    /** A bounded connect keeps the reconnect cadence prompt: an unreachable host
     *  must not stretch one manager cycle to the multi-minute OS connect default
     *  (a parked gate's deny re-fires once per cycle — see {@link #runManager}). */
    private static final int CONNECT_TIMEOUT_MS = 2_000;

    private final String host;
    private final int port;
    private final String clientId;
    /** This node's self-description, re-announced on every (re)connect; null for plain clients. */
    private final NodeCard card;
    private final ObjectMapper mapper = new ObjectMapper();

    /** One lock guards core state, the subscriber map and the socket pair. */
    private final Object lock = new Object();
    private final ClientCore core;
    private final Map<String, List<Consumer<BusEnvelope>>> subscribers = new LinkedHashMap<>();
    private final Set<Consumer<BusEnvelope>> warned =
            Collections.newSetFromMap(new IdentityHashMap<>());
    private Socket socket;
    private BufferedWriter out;

    private volatile Consumer<BusGap> onGap =
            gap -> log.warn("bus history evicted before this client caught up: {}", gap);
    /** The reverse-control seam: a verb the hub addressed to THIS node. A plain
     *  client (no controller) ignores it. Runs on the reader thread, so the
     *  handler MUST be non-blocking (cancel a signal, count a latch — no I/O). */
    private volatile Consumer<String> onControl = action -> { };
    /** The reverse-GATE seam: the hub's answer to a permission request this node
     *  parked — the callId it addresses and the verdict (block 4). Parallel to
     *  {@link #onControl}; a plain client (no parking broker) ignores it. Runs
     *  on the reader thread, so the handler MUST be non-blocking: complete the
     *  parked future and return — never join, never I/O, or every later frame
     *  stalls behind it. */
    private volatile BiConsumer<String, Boolean> onGate = (callId, allow) -> { };
    /** Fired when an ESTABLISHED connection drops (block 4): a fleet node's
     *  parked permission gate can only be answered by a live hub, so a node
     *  wires this to release those gates when the hub can no longer reach it —
     *  else an ask-mode run wedges forever behind an answer that cannot come.
     *  A plain client (no parking broker) ignores it. Never fires during the
     *  pure initial connect-retry: nothing was ever up to drop. */
    private volatile Runnable onDisconnect = () -> { };
    private volatile boolean closed = false;
    private final Thread manager;

    /**
     * Connects (and keeps reconnecting) to a hub. Construction never blocks
     * on the network: publishes before the first connect wait in the outbox.
     *
     * @param host     the hub's host
     * @param port     the hub's port
     * @param clientId this client's name in hub logs and hellos
     */
    public ProcessBus(String host, int port, String clientId) {
        this(host, port, clientId, 1024);
    }

    /** @param outboxCapacity unacked frames held before publishers block */
    public ProcessBus(String host, int port, String clientId, int outboxCapacity) {
        this(host, port, clientId, outboxCapacity, null);
    }

    /**
     * The node form: a {@link NodeCard} announced on every (re)connect —
     * registration rides the handshake, and the hub's roster lists this
     * client for exactly as long as its connection lives.
     *
     * @param card the node's self-description, or null for a plain client
     */
    public ProcessBus(String host, int port, String clientId, int outboxCapacity, NodeCard card) {
        this.host = host;
        this.port = port;
        this.clientId = clientId;
        this.card = card;
        this.core = new ClientCore(outboxCapacity);
        this.manager = Thread.ofVirtual()
                .name("spectro-bus-client-" + clientId)
                .start(this::runManager);
    }

    /**
     * Replaces the default gap handler (a warning log).
     *
     * @param handler receives every evicted stretch the hub announces
     * @return this bus, for fluent construction
     */
    public ProcessBus onGap(Consumer<BusGap> handler) {
        this.onGap = handler;
        return this;
    }

    /**
     * Registers the reverse-control handler: a verb the hub addressed to this
     * node (block 2, e.g. "stop"). Fires on the connection's reader thread and
     * is guarded like {@link #onGap} — a throwing handler is logged, never
     * fatal. Keep it non-blocking (cancel a run, count a latch); heavy work
     * here would stall every frame behind it.
     *
     * @param handler receives each control verb the hub sends to this node
     * @return this bus, for fluent construction
     */
    public ProcessBus onControl(Consumer<String> handler) {
        this.onControl = handler;
        return this;
    }

    /**
     * Registers the reverse-GATE handler: the hub's answer to a permission
     * request this node parked (block 4). Fires on the connection's reader
     * thread and is guarded like {@link #onControl} — a throwing handler is
     * logged, never fatal. The handler MUST be non-blocking: complete the
     * parked future with the verdict and return. Never join or do I/O here, or
     * the answer stalls every frame queued behind it.
     *
     * @param handler receives (callId, allow) for each gate answer the hub sends
     * @return this bus, for fluent construction
     */
    public ProcessBus onGate(BiConsumer<String, Boolean> handler) {
        this.onGate = handler;
        return this;
    }

    /**
     * Registers the disconnect handler: fired once per manager cycle in which an
     * ESTABLISHED connection is down (the hub died, or a reconnect after an
     * established link failed). Never fires during the pure initial connect —
     * nothing was ever up. Runs on the connection-manager thread and is guarded
     * like {@link #onGate}; keep it non-blocking (a fleet node denies its parked
     * gates here so the run never wedges behind an answer the hub can't deliver).
     *
     * @param handler receives a signal that an established connection dropped
     * @return this bus, for fluent construction
     */
    public ProcessBus onDisconnect(Runnable handler) {
        this.onDisconnect = handler;
        return this;
    }

    @Override
    public void publish(BusEnvelope frame) {
        synchronized (lock) {
            while (!closed) {
                try {
                    core.record(frame);
                    break;
                } catch (IllegalStateException full) {
                    // Backpressure, not loss: the publisher waits for acks.
                    try {
                        lock.wait(250);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException("interrupted while the outbox was full", interrupted);
                    }
                }
            }
            if (closed) {
                throw new IllegalStateException("bus closed");
            }
            sendLine(Wire.pub(frame, mapper)); // best effort — the outbox covers a dead wire
        }
    }

    @Override
    public AutoCloseable subscribe(String topic, Consumer<BusEnvelope> onFrame) {
        synchronized (lock) {
            subscribers.computeIfAbsent(topic, t -> new ArrayList<>()).add(onFrame);
            sendLine(Wire.sub(topic, core.cursor(topic)));
            return () -> {
                synchronized (lock) {
                    List<Consumer<BusEnvelope>> list = subscribers.get(topic);
                    if (list != null) {
                        list.remove(onFrame);
                        if (list.isEmpty()) {
                            // Drop the key: reconnects must not re-subscribe
                            // topics nobody consumes anymore.
                            subscribers.remove(topic);
                        }
                    }
                    warned.remove(onFrame); // do not pin a dead consumer forever
                }
            };
        }
    }

    /** How long {@link #close()} waits for the hub to ack the outbox tail. */
    private static final long DRAIN_GRACE_MS = 5_000;

    /**
     * Idempotent. Drains first: a closing node must not strand its tail
     * (close-without-drain is the shortcut this transport refuses) — close
     * waits up to {@value #DRAIN_GRACE_MS} ms for the hub's acks, and frames
     * that still could not be delivered are counted LOUDLY, never silently.
     */
    @Override
    public void close() {
        synchronized (lock) {
            long deadline = System.currentTimeMillis() + DRAIN_GRACE_MS;
            while (!closed && !core.unacked().isEmpty()
                    && System.currentTimeMillis() < deadline) {
                try {
                    lock.wait(100); // acks arrive on the reader thread and notify
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            int stranded = core.unacked().size();
            if (stranded > 0) {
                log.warn("bus client {} closing with {} unacked frame(s) — the hub never confirmed them",
                        clientId, stranded);
            }
            closed = true;
            teardownConnection();
            lock.notifyAll();
        }
        manager.interrupt();
    }

    /** Hard-kills the live socket WITHOUT stopping the machinery — the test
     *  seam for the reconnect path (a real network would do this for free). */
    void dropConnectionForTest() {
        synchronized (lock) {
            teardownConnection();
        }
    }

    /** Writes one line if connected; a dead wire tears the connection down
     *  and leaves recovery to the manager. Caller holds the lock. */
    private void sendLine(String line) {
        if (out == null) {
            return;
        }
        try {
            out.write(line);
            out.write('\n');
            out.flush();
        } catch (IOException dead) {
            teardownConnection();
        }
    }

    /**
     * Best-effort keepalive tightening: bound a silent peer's detection toward
     * the minute range instead of the OS default (often ~2h), where the platform
     * exposes the extended options. A platform without them keeps
     * {@code setKeepAlive}'s default cadence — slower, but still finite, and a
     * truly stuck fleet node is ultimately reaped by SIGTERM regardless.
     *
     * @param socket the freshly connected socket to tune
     */
    private static void tightenKeepAlive(Socket socket) {
        try {
            socket.setOption(jdk.net.ExtendedSocketOptions.TCP_KEEPIDLE, 30);
            socket.setOption(jdk.net.ExtendedSocketOptions.TCP_KEEPINTERVAL, 10);
            socket.setOption(jdk.net.ExtendedSocketOptions.TCP_KEEPCOUNT, 3);
        } catch (IOException | RuntimeException unsupported) {
            // A platform without the extended options: keepalive's default stands.
        }
    }

    /** Caller holds the lock. */
    private void teardownConnection() {
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
                // closing a dying socket cannot fail meaningfully
            }
        }
        socket = null;
        out = null;
    }

    /** The connection manager: connect, replay state, read until the wire
     *  dies, back off, repeat — a fleet that loses its bus must heal itself,
     *  because nobody restarts a background node by hand. */
    private void runManager() {
        long backoff = 50;
        boolean everConnected = false;
        while (!closed) {
            Socket attempt = null;
            try {
                // A bounded connect keeps reconnect cycling prompt; TCP keepalive
                // lets the OS surface a SILENT peer death (a partition or a
                // powered-off host sends no FIN/RST, so an idle readLine would
                // otherwise block for the OS default of hours) as a broken read,
                // which readLoop's IOException path turns into a disconnect.
                attempt = new Socket();
                attempt.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
                attempt.setKeepAlive(true);
                tightenKeepAlive(attempt);
                everConnected = true; // an established TCP link this lifetime
                BufferedReader in = new BufferedReader(
                        new InputStreamReader(attempt.getInputStream(), StandardCharsets.UTF_8));
                synchronized (lock) {
                    socket = attempt;
                    out = new BufferedWriter(
                            new OutputStreamWriter(attempt.getOutputStream(), StandardCharsets.UTF_8));
                    sendLine(Wire.hello(clientId, card));
                    for (String topic : subscribers.keySet()) {
                        sendLine(Wire.sub(topic, core.cursor(topic)));
                    }
                    for (BusEnvelope unacked : core.unacked()) {
                        sendLine(Wire.pub(unacked, mapper)); // the hub dedups redelivery
                    }
                }
                backoff = 50;
                readLoop(in);
            } catch (IOException wireDead) {
                // expected between hub lifetimes — the backoff below paces retries
            } finally {
                synchronized (lock) {
                    if (socket == attempt) {
                        teardownConnection();
                    }
                }
                if (attempt != null) {
                    try {
                        attempt.close();
                    } catch (IOException ignored) {
                        // already dead
                    }
                }
            }
            if (closed) {
                return;
            }
            // A connection that was ONCE established is now down (the hub died,
            // or a reconnect after an established link failed). Announce it so an
            // ask-mode node can release gates the departed hub can no longer
            // answer — firing every down cycle also frees a gate that parked in
            // the tiny window right after the drop. Never fires before the first
            // successful connect (everConnected == false), per the review.
            if (everConnected) {
                announceDisconnect();
            }
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            }
            backoff = Math.min(backoff * 2, 1_000);
        }
    }

    private void readLoop(BufferedReader in) throws IOException {
        String line;
        while ((line = in.readLine()) != null) {
            try {
                switch (Wire.parse(line, mapper)) {
                    case Wire.Pub(BusEnvelope frame) -> deliver(frame);
                    case Wire.Ack(String topic, String sender, long epoch, long highWater) -> {
                        synchronized (lock) {
                            core.ack(topic, sender, epoch, highWater);
                            lock.notifyAll(); // a blocked publisher may proceed
                        }
                    }
                    case Wire.Gap(String topic, String sender, long epoch,
                                  long fromSeq, long toSeq) -> {
                        synchronized (lock) {
                            // The gap is consumed history: without this advance
                            // the next resume cursor re-earns the same gap.
                            core.noteGap(topic, sender, epoch, toSeq);
                        }
                        announceGap(new BusGap(topic, sender, epoch, fromSeq, toSeq));
                    }
                    case Wire.Ctl(String action, String callId, Boolean allow) -> {
                        // Dispatch on the addressing, not the verb: a gate answer
                        // carries a callId (block 4), a plain control verb (stop)
                        // does not. A pre-gate handler never sees the gate line.
                        if (callId != null) {
                            announceGate(callId, allow);
                        } else {
                            announceControl(action);
                        }
                    }
                    default -> log.warn("unexpected op from hub: {}", line);
                }
            } catch (RuntimeException poison) {
                // A line we cannot parse (a foreign-edition payload included) is
                // connection-fatal: skipping a pub would let the next cumulative
                // ack advance the cursor past a frame nobody delivered. The
                // reconnect replays from the cursor — the loss stays loud, and a
                // truly poisoned frame becomes a visible reconnect loop, never
                // silence. (Consumer and gap-handler failures are guarded
                // separately and do NOT land here.)
                log.warn("protocol failure from hub — dropping the connection: {}", poison.toString());
                return;
            }
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

    /** The control handler is user code — guard it, log it, never die of it. A
     *  poison control verb must not kill the reader loop (that would strand a
     *  node's whole event stream over one bad "stop"). */
    private void announceControl(String action) {
        try {
            onControl.accept(action);
        } catch (RuntimeException broken) {
            log.warn("control handler failed for '{}': {}", action, broken.toString());
        }
    }

    /** The gate handler is user code (a node's parking broker) — guard it, log
     *  it, never die of it. A poison gate answer must not kill the reader loop
     *  (that would strand the node's whole event stream over one bad verdict). */
    private void announceGate(String callId, Boolean allow) {
        try {
            onGate.accept(callId, allow);
        } catch (RuntimeException broken) {
            log.warn("gate handler failed for '{}': {}", callId, broken.toString());
        }
    }

    /** The disconnect handler is user code (a node releasing parked gates) —
     *  guard it, log it, never die of it. It runs on the manager thread between
     *  reconnect attempts, so a throwing handler must not break the heal loop. */
    private void announceDisconnect() {
        try {
            onDisconnect.run();
        } catch (RuntimeException broken) {
            log.warn("disconnect handler failed: {}", broken.toString());
        }
    }

    /** Consumer-side dedup, then fan-out with per-consumer isolation. */
    private void deliver(BusEnvelope frame) {
        List<Consumer<BusEnvelope>> targets;
        synchronized (lock) {
            targets = List.copyOf(subscribers.getOrDefault(frame.topic(), List.of()));
            if (targets.isEmpty()) {
                // Nobody consumes this topic here (all handles closed): the
                // cursor must NOT advance, or a later subscriber would start
                // mid-stream although the ring still holds everything.
                return;
            }
            if (!core.accept(frame)) {
                return; // redelivery — invisible to consumers
            }
        }
        for (Consumer<BusEnvelope> consumer : targets) {
            try {
                consumer.accept(frame);
            } catch (RuntimeException broken) {
                warnOnce(consumer, broken);
            }
        }
    }

    private void warnOnce(Consumer<BusEnvelope> consumer, RuntimeException broken) {
        boolean first;
        synchronized (lock) {
            first = warned.add(consumer);
        }
        if (first) {
            log.warn("bus consumer {} failed (suppressing further warnings): {}",
                    consumer.getClass().getSimpleName(), broken.toString());
        }
    }
}
