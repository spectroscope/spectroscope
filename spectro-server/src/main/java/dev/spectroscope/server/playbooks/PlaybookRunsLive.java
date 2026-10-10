package dev.spectroscope.server.playbooks;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/** Card 482: the playbook runs in flight in this process, by session and run id. */
public final class PlaybookRunsLive {

    private static final Set<String> LIVE = ConcurrentHashMap.newKeySet();

    private PlaybookRunsLive() {
    }

    /**
     * Notes a run as in flight.
     *
     * @param sessionId the session
     * @param runId     the run that started
     */
    public static void started(String sessionId, String runId) {
        LIVE.add(sessionId + "." + runId);
    }

    /**
     * Forgets a run once it ended.
     *
     * @param sessionId the session
     * @param runId     the run that ended
     */
    public static void ended(String sessionId, String runId) {
        LIVE.remove(sessionId + "." + runId);
    }

    /**
     * Whether a run is in flight in this process.
     *
     * @param sessionId the session
     * @param runId     the run
     * @return true while that run is in flight
     */
    public static boolean live(String sessionId, String runId) {
        return LIVE.contains(sessionId + "." + runId);
    }
}
