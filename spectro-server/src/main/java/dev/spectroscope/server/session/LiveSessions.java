package dev.spectroscope.server.session;

import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Which sessions are LIVE on this server right now — the fact card 212 found
 * missing.
 *
 * <p>Before this class the server ran several sessions at once and told nobody:
 * {@code SpectroSocketHandler} kept its connection map private, so the only
 * session a browser could honestly draw as live was the one IT held a socket
 * to. Two runs meant two tabs, each seeing one run and believing it was the
 * only one. The rail was not lying; it had nothing to read.</p>
 *
 * <p>Scope is the server PROCESS, deliberately. Every face of the product — the
 * desktop shell, a browser tab, a second browser tab — talks to one Spring
 * Boot process per home, so one registry is exactly the set of viewers that can
 * disagree. Two separate server processes started against one home would each
 * report only their own sessions; that is a real limit, not a hidden one, and
 * it is written on card 212 rather than papered over with a lock file that
 * outlives the crash that wrote it.</p>
 *
 * <h2>One socket per session id</h2>
 *
 * <p>{@link #claim} REFUSES a second socket on a session id another socket
 * already holds. It is not a policy preference. Two connections on one id means
 * two {@link dev.spectroscope.core.session.SessionStore} instances appending to
 * one JSONL file, two agents replaying one history and diverging from the first
 * turn, two llm-wire recorders on one sidecar and two workspace pins racing.
 * Making that safe would mean serialising everything a connection owns; the
 * session simply belongs to the socket that has it, and the loser is told so
 * and closed. A closing socket {@link #release}s immediately, so a reload or a
 * dropped connection never locks the operator out of their own session.</p>
 *
 * <h2>Threading</h2>
 *
 * <p>All state changes happen under this object's monitor and the resulting
 * snapshot is pushed to the listeners INSIDE that same block, so no change can
 * slip through a gap between "mutate" and "notify" and no two viewers can be
 * handed snapshots in different orders. The price of that guarantee is a
 * contract on the listener: {@link Listener#onLiveSessions} must never block —
 * it hands the snapshot to a bounded queue and returns, exactly as the fleet
 * tap does.</p>
 */
@Component
public final class LiveSessions {

    /**
     * One live session, as a client reads it. Card 502 added the last five
     * fields, additively: a row of this server carries this process's pid and
     * the face {@code server}; a row of another process comes from the
     * registry under {@code ~/.spectro/live}.
     *
     * @param id         the session id (the JSONL file's base name)
     * @param running    true while a run is in flight on the holding socket
     * @param since      when the socket claimed this session, epoch millis
     * @param folder     the session's folder, or null before it has one
     * @param name       the name peers address it by, or null
     * @param statusLine what the harness knows the session is doing, or null
     * @param face       {@code server}, {@code repl}, {@code headless}, {@code cron} or {@code node}
     * @param pid        the process that hosts it
     */
    public record LiveSession(String id, boolean running, long since, String folder, String name,
                              String statusLine, String face, Long pid) {

        /** The card 212 row: this process, the face {@code server}, nothing else known.
         *  @param id the session id @param running the run flag @param since the claim time */
        public LiveSession(String id, boolean running, long since) {
            this(id, running, since, null, null, null, "server", ProcessHandle.current().pid());
        }
    }

    /**
     * Card 502: what the live set reads from the process's peer node.
     */
    public interface PeerBridge {
        /** @param sessionId a session of this process @return its name */
        String nameOf(String sessionId);

        /** @return the live records of every OTHER process, from the last listing */
        List<dev.spectroscope.core.peer.LiveRecord> others();

        /**
         * The operator's Deliver or Decline on a held message.
         *
         * @param sessionId the session holding it
         * @param msgId     the message
         * @param deliver   true to deliver
         */
        void decide(String sessionId, String msgId, boolean deliver);

        /** @return card 503: the process's peer node the messaging tools send through, or null */
        default dev.spectroscope.core.peer.PeerNode node() {
            return null;
        }
    }

    /** Card 502: a viewer of the sessions of other processes. Must not block. */
    public interface RosterListener {
        /** @param rows one row per session of another live process */
        void onPeerRoster(List<LiveSession> rows);
    }

    /** A viewer that wants every change. Implementations must not block. */
    public interface Listener {
        /**
         * The complete set of live sessions, latest-wins.
         *
         * @param live every live session, ordered oldest claim first
         */
        void onLiveSessions(List<LiveSession> live);
    }

    /** What one socket holds. */
    private record Held(String socketId, boolean running, long since) {}

    /** sessionId -> holder. Insertion-ordered so the snapshot is stable. */
    private final Map<String, Held> held = new LinkedHashMap<>();

    /** The connected viewers. Copy-on-write: pushes iterate, registration is rare. */
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();

    /** Card 502: socketId -> the session port that socket drives. */
    private final Map<String, dev.spectroscope.core.peer.PeerSession> ports = new java.util.concurrent.ConcurrentHashMap<>();
    /** Card 502: the peer node's view, or null when messaging is not wired. */
    private volatile PeerBridge bridge;
    /** Card 502: who wants the other processes' sessions. */
    private final List<RosterListener> rosterListeners = new CopyOnWriteArrayList<>();
    /** Card 504: the loops of this process's sessions, held beside the live set. */
    private final SessionLoops loops = SessionLoops.shared();

    /** @return card 504: the loops of this process's sessions */
    public SessionLoops loops() {
        return loops;
    }

    /** Card 502: the last roster, handed to a new roster listener at once. */
    private volatile List<LiveSession> roster = List.of();

    /**
     * Claims a session id for a socket.
     *
     * @param socketId  the WebSocket session id asking
     * @param sessionId the spectroscope session id it wants to drive
     * @return true when the socket now holds the session (including when it
     *         already did); false when another socket holds it — the caller
     *         must then refuse the connection rather than share the file
     */
    public boolean claim(String socketId, String sessionId) {
        synchronized (this) {
            Held owner = held.get(sessionId);
            if (owner != null) {
                // Idempotent for the holder: a resume claims at connect and the
                // store mints again on the first prompt, both with the same id.
                return owner.socketId().equals(socketId);
            }
            held.put(sessionId, new Held(socketId, false, System.currentTimeMillis()));
            publish();
            return true;
        }
    }

    /**
     * Moves one session's run flag. Ignored unless the reporting socket is the
     * holder — a stray report from a second viewer must never make a quiet
     * session look busy in every other window.
     *
     * @param socketId  the socket reporting
     * @param sessionId the session whose flag moves
     * @param running   true while a run is in flight
     */
    public void running(String socketId, String sessionId, boolean running) {
        synchronized (this) {
            Held owner = held.get(sessionId);
            if (owner == null || !owner.socketId().equals(socketId) || owner.running() == running) {
                return;
            }
            held.put(sessionId, new Held(owner.socketId(), running, owner.since()));
            publish();
        }
    }

    /**
     * Drops everything a socket held. Called when the socket closes, so the id
     * is free again for the next connection.
     *
     * @param socketId the socket that went away
     */
    public void release(String socketId) {
        ports.remove(socketId);
        synchronized (this) {
            boolean removed = false;
            for (Iterator<Map.Entry<String, Held>> it = held.entrySet().iterator(); it.hasNext();) {
                if (it.next().getValue().socketId().equals(socketId)) {
                    it.remove();
                    removed = true;
                }
            }
            if (removed) {
                publish();
            }
        }
    }

    /**
     * The live set, as the endpoint and the socket frame both serve it.
     *
     * @return one row per live session, oldest claim first
     */
    public List<LiveSession> snapshot() {
        synchronized (this) {
            return snapshotHere();
        }
    }

    /**
     * Who holds a session — for tests and for a readable refusal.
     *
     * @param sessionId the session to look up
     * @return the holding socket's id, or null when nobody holds it
     */
    public String holder(String sessionId) {
        synchronized (this) {
            Held owner = held.get(sessionId);
            return owner == null ? null : owner.socketId();
        }
    }

    /**
     * Registers a viewer AND hands it the current world in the same breath, so
     * a page that connects mid-run learns what is live without waiting for the
     * next change.
     *
     * @param listener the viewer; it must not block
     */
    public void addListener(Listener listener) {
        synchronized (this) {
            listeners.add(listener);
            listener.onLiveSessions(snapshotHere());
        }
    }

    /**
     * Unregisters a viewer — a closing connection, before it releases.
     *
     * @param listener the viewer to drop; unknown listeners are ignored
     */
    public void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    /**
     * Card 502: the session port a socket drives, so the record and the rows
     * can read its folder and status line and a message can reach it.
     *
     * @param socketId the socket
     * @param port     the port; null removes it
     */
    public void port(String socketId, dev.spectroscope.core.peer.PeerSession port) {
        if (port == null) {
            ports.remove(socketId);
        } else {
            ports.put(socketId, port);
        }
    }

    /**
     * Card 502: the ports of the sessions held right now.
     *
     * @return one port per held session whose socket registered one
     */
    public List<dev.spectroscope.core.peer.PeerSession> ports() {
        synchronized (this) {
            List<dev.spectroscope.core.peer.PeerSession> out = new ArrayList<>();
            for (Map.Entry<String, Held> entry : held.entrySet()) {
                dev.spectroscope.core.peer.PeerSession port = ports.get(entry.getValue().socketId());
                if (port != null && entry.getKey().equals(port.id())) {
                    out.add(port);
                }
            }
            return List.copyOf(out);
        }
    }

    /**
     * Card 502: the session's status line or folder moved; every viewer and
     * the record learn it. Ignored unless the socket holds the session.
     *
     * @param socketId  the reporting socket
     * @param sessionId the session
     */
    public void touch(String socketId, String sessionId) {
        synchronized (this) {
            Held owner = held.get(sessionId);
            if (owner == null || !owner.socketId().equals(socketId)) {
                return;
            }
            publish();
        }
    }

    /** @param bridge the peer node's view; null unwires it */
    public void bridge(PeerBridge bridge) {
        this.bridge = bridge;
    }

    /** @return the peer node's view, or null */
    public PeerBridge bridge() {
        return bridge;
    }

    /**
     * Card 502: registers a viewer of other processes' sessions and hands it
     * the last roster at once, when there is anyone in it.
     *
     * @param listener the viewer; it must not block
     */
    public void addRosterListener(RosterListener listener) {
        rosterListeners.add(listener);
        List<LiveSession> now = roster;
        if (!now.isEmpty()) {
            listener.onPeerRoster(now);
        }
    }

    /** @param listener the viewer to drop */
    public void removeRosterListener(RosterListener listener) {
        rosterListeners.remove(listener);
    }

    /**
     * Card 502: the sessions of other live processes, pushed to every roster viewer.
     *
     * @param rows one row per foreign session
     */
    public void publishRoster(List<LiveSession> rows) {
        roster = List.copyOf(rows);
        for (RosterListener listener : rosterListeners) {
            listener.onPeerRoster(roster);
        }
    }

    /** @return the last roster of other processes */
    public List<LiveSession> roster() {
        return roster;
    }

    /**
     * Card 587, fix round (M12): how often the open sessions look again
     * whether their folder's code graph came or went, in seconds. A build from
     * the app is announced at its end without waiting; this catches a graph
     * built in a terminal or deleted, at the cost of a few file checks per
     * open session.
     */
    static final long CODE_GRAPH_RECHECK_SECONDS = 5;

    /** One daemon thread for the looks of every registry in the process. */
    private static final ScheduledExecutorService CODE_GRAPH_TICKER = Executors.newSingleThreadScheduledExecutor(
            run -> Thread.ofPlatform().daemon().name("spectro-codegraph-recheck").unstarted(run));

    private final List<Runnable> codeGraphChecks = new CopyOnWriteArrayList<>();
    private ScheduledFuture<?> codeGraphTick;

    /**
     * Card 587, fix round (M12): a session's look at its folder's code graph,
     * run by {@link #checkCodeGraphs}. It must not block for long.
     *
     * @param check the look
     */
    public void addCodeGraphCheck(Runnable check) {
        codeGraphChecks.add(check);
    }

    /** @param check a look added before; the timer stops with the last one */
    public synchronized void removeCodeGraphCheck(Runnable check) {
        codeGraphChecks.remove(check);
        if (codeGraphChecks.isEmpty() && codeGraphTick != null) {
            codeGraphTick.cancel(false);
            codeGraphTick = null;
        }
    }

    /**
     * Card 587, fix round (M12): every {@link #CODE_GRAPH_RECHECK_SECONDS} the
     * sessions look again; started by the first session that connects, stopped
     * when the last one leaves.
     */
    public synchronized void startCodeGraphTicker() {
        if (codeGraphTick == null) {
            codeGraphTick = CODE_GRAPH_TICKER.scheduleWithFixedDelay(this::checkCodeGraphs,
                    CODE_GRAPH_RECHECK_SECONDS, CODE_GRAPH_RECHECK_SECONDS, TimeUnit.SECONDS);
        }
    }

    /** Card 587, fix round (M12): every live session looks at its folder's code graph now. */
    public void checkCodeGraphs() {
        for (Runnable check : codeGraphChecks) {
            try {
                check.run();
            } catch (RuntimeException ignored) {
                // one session's failed look must not keep the others from theirs
            }
        }
    }

    /** Card 580: a connection that wants to hear of a settings write. Must not block. */
    public interface SettingsListener {
        /** A settings file was written through this server's settings API. */
        void onSettingsWritten();
    }

    /** Card 580: who hears of a settings write. */
    private final List<SettingsListener> settingsListeners = new CopyOnWriteArrayList<>();

    /** Card 580: how many settings writes this server has told of. */
    private final java.util.concurrent.atomic.AtomicLong settingsWrites = new java.util.concurrent.atomic.AtomicLong();

    /**
     * Card 580: the count of settings writes so far. A connection compares it
     * with the count taken before its settings were read, so a write that
     * landed before it listened still reaches it.
     *
     * @return the number of writes {@link #settingsWritten()} has told of
     */
    public long settingsWrites() {
        return settingsWrites.get();
    }

    /** @param listener card 580: a connection to tell of every settings write; it must not block */
    public void addSettingsListener(SettingsListener listener) {
        settingsListeners.add(listener);
    }

    /** @param listener card 580: the connection to stop telling; unknown listeners are ignored */
    public void removeSettingsListener(SettingsListener listener) {
        settingsListeners.remove(listener);
    }

    /**
     * Card 580: a settings write landed (the settings view, another window, a
     * direct PUT). Every listening connection hears of it.
     */
    public void settingsWritten() {
        settingsWrites.incrementAndGet();
        for (SettingsListener listener : settingsListeners) {
            listener.onSettingsWritten();
        }
    }

    /**
     * Card 502: the rows of one foreign record.
     *
     * @param record a live record of another process
     * @return one row per session it hosts
     */
    public static List<LiveSession> rowsOf(dev.spectroscope.core.peer.LiveRecord record) {
        List<LiveSession> rows = new ArrayList<>();
        for (dev.spectroscope.core.peer.LiveRecord.Session session : record.sessions()) {
            rows.add(new LiveSession(session.id(), "busy".equals(session.status()),
                    session.since() == null ? record.startedAt() : session.since(), session.cwd(), session.name(),
                    session.statusLine(), record.face(), record.pid()));
        }
        return rows;
    }

    /** Pushes the current snapshot at everyone. Call under the monitor only. */
    private void publish() {
        List<LiveSession> live = snapshotHere();
        for (Listener listener : listeners) {
            listener.onLiveSessions(live);
        }
    }

    /** The snapshot without taking the monitor — callers already hold it. */
    private List<LiveSession> snapshotHere() {
        List<LiveSession> live = new ArrayList<>(held.size());
        long pid = ProcessHandle.current().pid();
        PeerBridge names = bridge;
        for (Map.Entry<String, Held> entry : held.entrySet()) {
            dev.spectroscope.core.peer.PeerSession port = ports.get(entry.getValue().socketId());
            boolean known = port != null && entry.getKey().equals(port.id());
            live.add(new LiveSession(entry.getKey(), entry.getValue().running(), entry.getValue().since(),
                    known ? port.cwd() : null,
                    known && names != null ? names.nameOf(entry.getKey()) : null,
                    known ? port.statusLine() : null, "server", pid));
        }
        return List.copyOf(live);
    }
}
