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

    /** What decides it.
     *  @return the check, never null */
    public GoalCheck check() {
        return check;
    }
}
