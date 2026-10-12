package dev.spectroscope.core.messaging;

import dev.spectroscope.core.peer.PeerNames;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The names one run has sent to, and the agent each one reached (card 503
 * criterion 1). A later send under the same bare name that would reach
 * another agent is refused; {@code name [ref]} names the new one on purpose
 * and moves the pin.
 */
public final class AddressPins {

    private final Map<String, String> pinned = new ConcurrentHashMap<>();

    /**
     * Remembers what a name reached.
     *
     * @param to  the name as the model wrote it, a ref included or not
     * @param row the agent it reached
     */
    public void pin(String to, AgentRow row) {
        pinned.put(key(to), identity(row));
    }

    /**
     * @param name a bare name
     * @param row  the agent it reaches now
     * @return a non null marker when the name reached another agent earlier in the run
     */
    String rebound(String name, AgentRow row) {
        String before = pinned.get(key(name));
        return before == null || before.equals(identity(row)) ? null : before;
    }

    /** Forgets every pin; a new run starts with none. */
    public void clear() {
        pinned.clear();
    }

    private static String key(String to) {
        String bare = to == null ? "" : to.strip().replaceAll("\\s*\\[[0-9a-f]{6,12}\\]$", "");
        return PeerNames.key(bare);
    }

    private static String identity(AgentRow row) {
        return row.kind().inRun() ? "agent:" + row.id() : "session:" + row.id();
    }
}
