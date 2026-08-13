package dev.spectroscope.server.session;

import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

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
     * One live session, as a client reads it.
     *
     * @param id      the session id (the JSONL file's base name)
     * @param running true while a run is in flight on the holding socket
     * @param since   when the socket claimed this session, epoch millis
     */
    public record LiveSession(String id, boolean running, long since) {}

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
        for (Map.Entry<String, Held> entry : held.entrySet()) {
            live.add(new LiveSession(entry.getKey(), entry.getValue().running(),
                    entry.getValue().since()));
        }
        return List.copyOf(live);
    }
}
