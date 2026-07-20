package dev.spectroscope.server;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The per-session workspace pins — the one piece of state the socket side
 * (set_workspace) and the stateless REST side (/api/files, /api/file) must
 * SHARE, or the Files tab and the agent's sandbox diverge on a picked folder.
 * In-memory only: a pin lives as long as the server process; after a restart
 * a resumed session falls back to the config/auto rules (the picked folder
 * keeps its files, the pin is just no longer known).
 */
final class SessionWorkspaces {

    /** sessionId → the absolute folder the user picked for that session. */
    private static final Map<String, String> PINS = new ConcurrentHashMap<>();

    private SessionWorkspaces() {
    }

    /**
     * Pins a session to a picked folder (latest wins).
     *
     * @param sessionId the session to pin
     * @param path the absolute directory the native picker returned
     */
    static void pin(String sessionId, String path) {
        PINS.put(sessionId, path);
    }

    /**
     * Looks up a session's pin.
     *
     * @param sessionId the session to look up
     * @return the pinned folder, or {@code null} when the session never picked one
     */
    static String pinned(String sessionId) {
        return sessionId == null ? null : PINS.get(sessionId);
    }
}
