package dev.spectroscope.core.session;

/**
 * The context window the operator set for one session, or none (card 390).
 *
 * <p>One holder per session, handed to the agent and to every child it
 * spawns. The loop reads {@link #tokens()} at the top of every turn, before
 * the context estimate and before the compaction check, so a value set while
 * a run is working reaches that run's next turn, and a value set between runs
 * reaches the next run without rebuilding the agent. The same shape
 * {@code SessionGoal} has, for the same reason: the browser builds one agent
 * per connection and keeps it.</p>
 *
 * <p>This class holds the number and nothing else. What a person may type
 * (whole tokens, a floor and a ceiling) is checked by the server before
 * {@link #set} is called; here only a positive value is accepted, because 0 is
 * how "none" is spelled.</p>
 *
 * <p>Volatile and nothing more: written from a socket thread, read from the
 * agent's own virtual thread, one field with no compound state.</p>
 */
public final class SessionWindow {

    private volatile int tokens;

    /** A holder with no window set. */
    public SessionWindow() {
    }

    /** The window in force, re-read by the loop on every turn.
     *  @return the window in tokens, or 0 when none is set */
    public int tokens() {
        return tokens;
    }

    /** Whether a window is set.
     *  @return true while {@link #tokens()} is positive */
    public boolean isSet() {
        return tokens > 0;
    }

    /**
     * Sets (or replaces) the window.
     *
     * @param value the window in tokens, positive
     * @throws IllegalArgumentException for 0 or less; clearing is {@link #clear()}
     */
    public void set(int value) {
        if (value <= 0) {
            throw new IllegalArgumentException("a session window is positive, got " + value
                    + "; clear() removes it");
        }
        this.tokens = value;
    }

    /** Removes the window; the automatic sources decide again. */
    public void clear() {
        this.tokens = 0;
    }
}
