package dev.spectroscope.core.goal;

import dev.spectroscope.core.config.governing.Governs;

import java.util.function.LongSupplier;

/**
 * The check in clock of a goal run with background children (card 504,
 * criterion 3, concept section Goal).
 *
 * <p>While children a run started in the background are still working, the
 * goal's check is deferred at {@code end_turn}. The run waits for them up to
 * the next interval and, if one still runs, appends a check in that lists
 * them. The intervals are {@code first * 2^min(count, doublings)}: 30, 60,
 * 120 minutes and then 120. When the last child ends the deferral drops, and
 * the next deferral starts again at the first interval.</p>
 *
 * <p>One instance belongs to one agent's loop, which is sequential.</p>
 */
public final class GoalCheckIn {

    /** The first check in interval, in minutes (concept AGENT-MESSAGING, Goal;
     *  the same 30 minutes Claude Code waits before its first goal check in). */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MINUTES)
    public static final int GOAL_CHECKIN_MINUTES = 30;

    /** How many times the interval doubles before it stays flat: 30, 60, 120,
     *  then 120 minutes. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int GOAL_CHECKIN_DOUBLINGS = 2;

    /** {@link #GOAL_CHECKIN_MINUTES} in milliseconds. */
    @Governs(kind = Governs.Kind.ALIAS, unit = Governs.Unit.MILLISECONDS)
    public static final long FIRST_INTERVAL_MS = GOAL_CHECKIN_MINUTES * 60_000L;

    private final long firstMs;
    private final LongSupplier clock;
    private long deferredSince = -1;
    private long lastMark = -1;
    private int count;

    /**
     * @param firstMs the first interval; the doublings follow from it
     * @param clock   the time in milliseconds
     */
    public GoalCheckIn(long firstMs, LongSupplier clock) {
        this.firstMs = firstMs;
        this.clock = clock;
    }

    /**
     * How long the run waits for its children before the next check in. The
     * first call starts the deferral.
     *
     * @return milliseconds, 0 when a check in is due now
     */
    public long waitMs() {
        long now = clock.getAsLong();
        if (deferredSince < 0) {
            deferredSince = now;
            lastMark = now;
        }
        long interval = firstMs << Math.min(count, GOAL_CHECKIN_DOUBLINGS);
        return Math.max(0L, interval - (now - lastMark));
    }

    /** A check in was appended now. */
    public void checkedIn() {
        count++;
        lastMark = clock.getAsLong();
    }

    /** The last child ended: the deferral drops. */
    public void reset() {
        deferredSince = -1;
        lastMark = -1;
        count = 0;
    }

    /** @return true while a deferral runs */
    public boolean deferring() {
        return deferredSince >= 0;
    }

    /** @return the check ins of the current deferral */
    public int count() {
        return count;
    }

    /** @return the minutes since the deferral started, rounded, at least 1 */
    public long deferredMinutes() {
        if (deferredSince < 0) {
            return 0;
        }
        return Math.max(1L, Math.round((clock.getAsLong() - deferredSince) / 60_000.0));
    }

    /**
     * The check in the harness appends.
     *
     * @param outcome  the goal's outcome
     * @param minutes  how long the check has been deferred
     * @param children one line per child still running: id, role, state and
     *                 its last status line
     * @return the text
     */
    public static String text(String outcome, long minutes, String children) {
        return "Goal check-in: «" + outcome + "» is still active, and its check has been deferred for "
                + minutes + " min because children you started in the background are still running."
                + " The harness wrote this list; the line after each child is that child's last status"
                + " line in its own words.\n"
                + children
                + "Check on their progress and read what they sent you. If they are progressing, say so"
                + " briefly and keep waiting. If one is stuck or no longer needed, send it a message to"
                + " stop, and continue toward the goal.";
    }
}
