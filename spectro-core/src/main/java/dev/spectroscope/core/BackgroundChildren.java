package dev.spectroscope.core;

import dev.spectroscope.core.peer.PeerEnvelope;

import java.util.List;

/**
 * Card 505: the children a parent run started in the background, as the
 * parent's own loop meets them at its exits.
 *
 * <p>At an {@code end_turn} below the cap the loop waits for its children and
 * hands their results in as the next text: one attributed message block per
 * child, the same block and trailer a message from another agent gets, so a
 * result cannot speak in the operator's voice. With a goal stated it waits
 * only up to the next check in interval (card 504: 30, 60, 120 minutes, then
 * 120) and then appends a goal check in that lists the children still
 * running. Every {@code run_end} settles first: what still runs
 * is cancelled and waited for up to a fixed time, so in the normal case its
 * last events land before the run's end; a child that ignores its cancel past
 * that time is logged and left behind.</p>
 */
public interface BackgroundChildren {

    /** The line the harness writes above the results it hands in at an end_turn. */
    String HAND_IN_HEADER = "[Background children] Your turn ended while children you started in the background"
            + " were still working, so the run waited for them. The harness wrote this line; each block below"
            + " is the result one child wrote, in its own words.";

    /** @return true while a background child of the current run runs or holds a result nobody collected */
    boolean pending();

    /**
     * Waits without polling until every background child of the run has
     * ended, the signal is cancelled or the wait has passed, and collects the
     * results nobody collected yet.
     *
     * @param signal the run's cancel
     * @param waitMs at most this long; zero or less waits until they have ended
     * @return the collected results as messages from their children, in spawn
     *         order; empty when there was nothing to hand in; null when a
     *         child still runs or the signal was cancelled
     */
    List<PeerEnvelope> join(CancelSignal signal, long waitMs);

    /**
     * Card 504: the children still running, one line each: id, role, state
     * and the child's last status line, for the goal's check in.
     *
     * @return the lines, each ending with a newline; empty when none runs
     */
    String runningLines();

    /** @return how many children are still running */
    int runningCount();

    /** @return the first check in interval of a goal run; the doublings follow from it */
    long checkInMs();

    /** The run is ending: cancels what still runs and waits a fixed time for it to end. */
    void settle();
}
