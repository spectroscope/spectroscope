package dev.spectroscope.core.goal;

/**
 * The goal a session is carrying right now, and the thing that will decide it
 * (card 267).
 *
 * <p>One object on {@code AgentOptions} rather than two fields, for the same
 * reason card 262's guard carries its own asker: the statement and its teeth are
 * one decision, and a face that wired one without the other would ship a goal
 * that reports itself met.</p>
 *
 * <p><b>Why the statement is mutable and re-read.</b>
 * {@code SessionConnection.buildAgentOnce} returns the SAME agent for every
 * prompt of a browser session, so a goal baked into the system prompt at build
 * time could not be stated, changed or cleared without a reconnect — and the
 * whole point of criterion 2 is that the goal is re-read rather than remembered.
 * The loop reads {@link #stated()} once per turn, so an operator who edits the
 * goal file between turns is obeyed on the next one.</p>
 *
 * <p>Volatile and nothing more: one field written from a socket thread and read
 * from the agent's own virtual thread. There is no compound state here to make
 * atomic.</p>
 */
public final class SessionGoal {

    private final GoalCheck check;

    private volatile RunGoal stated;

    /** Card 504: what the host does when the loop checks in or clears the goal. */
    private volatile Listener listener = new Listener() { };

    /**
     * Card 504: the two things the loop tells the session's host about its
     * goal. Both default to nothing, so a face that listens to neither stays
     * as card 267 left it.
     */
    public interface Listener {

        /**
         * A check in was appended while background children ran.
         *
         * @param count       the check ins of this deferral, 1-based
         * @param deferredMin how long the check has been deferred, in minutes
         * @param children    how many children were still running
         */
        default void checkedIn(int count, long deferredMin, int children) {
        }

        /**
         * The goal cleared itself after an unrecoverable error.
         *
         * @param reason {@code context_limit}, {@code authentication}, {@code billing}
         *               or {@code model_unavailable}
         */
        default void cleared(String reason) {
        }
    }

    /**
     * @param check what decides this session's goals — {@link CommandGoalCheck}
     *              everywhere it is wired today. Null is not allowed: a goal
     *              whose teeth are missing would be a goal that grades itself
     */
    public SessionGoal(GoalCheck check) {
        if (check == null) {
            throw new IllegalArgumentException("a goal without a check is a wish");
        }
        this.check = check;
    }

    /** The goal in force, re-read by the loop on every turn.
     *  @return the stated goal, or null when none is stated */
    public RunGoal stated() {
        return stated;
    }

    /** States (or replaces, or with null clears) the goal.
     *  @param goal the operator's statement; a goal with a blank outcome clears */
    public void state(RunGoal goal) {
        this.stated = goal != null && goal.stated() ? goal : null;
    }

    /**
     * Card 504: the host's listener.
     *
     * @param listener the listener, or null for none
     */
    public void listen(Listener listener) {
        this.listener = listener == null ? new Listener() { } : listener;
    }

    /** @return the host's listener, never null */
    public Listener listener() {
        return listener;
    }

    /**
     * Card 504, criterion 4: clears the goal after an unrecoverable error and
     * tells the host, which removes the file and says so.
     *
     * @param reason the error class
     */
    public void clear(String reason) {
        this.stated = null;
        listener.cleared(reason);
    }

    /** What decides it.
     *  @return the check, never null */
    public GoalCheck check() {
        return check;
    }
}
