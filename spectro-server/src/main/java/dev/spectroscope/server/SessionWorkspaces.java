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
 *
 * <p>Public since card 186, and it is the socket-to-REST shared-state bridge: ShellCwd in .shell and WorkspaceController in .workspace read it, as do three WorkspaceController tests. Advertising it module-wide is an invitation to new coupling; a narrow interface is a follow-up card.</p>
 */
public final class SessionWorkspaces {

    /** sessionId → the absolute folder the user picked for that session. */
    private static final Map<String, String> PINS = new ConcurrentHashMap<>();

    /**
     * sessionId → the folder that session's agent actually works in, recorded
     * the moment the socket resolves it. Distinct from {@link #PINS}: a pin
     * means "the operator chose this", while a resolution also covers the
     * throwaway per-session temp folder nobody chose. The REST side reads THIS
     * one, so "the pane shows a tree" and "a workspace exists" are the same
     * fact rather than two code paths that each recompute it and can disagree.
     */
    private static final Map<String, String> RESOLVED = new ConcurrentHashMap<>();

    private SessionWorkspaces() {
    }

    /**
     * Records the folder a session's agent works in, called wherever the socket
     * resolves a workspace, so a resolved workspace is always a known one.
     *
     * @param sessionId the session whose workspace was resolved
     * @param path the absolute directory the resolver returned
     */
    public static void resolved(String sessionId, String path) {
        RESOLVED.put(sessionId, path);
    }

    /**
     * The folder a session's agent works in.
     *
     * @param sessionId the session to look up
     * @return the resolved directory, or {@code null} when this session has not
     *         resolved a workspace, including a session id that never existed
     */
    public static String resolvedPath(String sessionId) {
        return sessionId == null ? null : RESOLVED.get(sessionId);
    }

    /**
     * Pins a session to a picked folder (latest wins).
     *
     * @param sessionId the session to pin
     * @param path the absolute directory the native picker returned
     */
    public static void pin(String sessionId, String path) {
        PINS.put(sessionId, path);
    }

    /**
     * Looks up a session's pin.
     *
     * @param sessionId the session to look up
     * @return the pinned folder, or {@code null} when the session never picked one
     */
    public static String pinned(String sessionId) {
        return sessionId == null ? null : PINS.get(sessionId);
    }
}
