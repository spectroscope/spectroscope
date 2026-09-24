package dev.spectroscope.core.steering;

import java.util.ArrayDeque;

/**
 * What the operator said while the run was already working (card 380).
 *
 * <p>The house calls this act steering, and it did so before this card existed:
 * {@code ProgressGuard} hands anything that is not one of its three labels to
 * the model "as steering, verbatim". This holder is the same act without a
 * guard in front of it. A person types a sentence into a turn that is in
 * flight, and the run reads it at its next safe point.</p>
 *
 * <p><b>Polled, never a callback.</b> The shape is card 267's goal, one field
 * over: the socket thread writes, the agent's own virtual thread reads once per
 * turn, and nothing waits on anybody. A port with a callback would put a
 * listener on the loop's thread and turn a sentence into a scheduling problem.
 * The difference from the goal is where the text lands. A goal goes into the
 * system prompt for the turn; a steering message goes into the history as user
 * content, which is why it needs the fold and the attribution and the goal does
 * not.</p>
 *
 * <p><b>Taken means gone.</b> {@link #take()} drains, so one sentence cannot buy
 * two turns, the same rule card 266 wrote for continuations.</p>
 *
 * <p><b>It lives exactly as long as a run</b> (fix round 2026-09-24). A run
 * {@link #open() opens} it before its first turn and {@link #close() closes} it
 * on every way out, and the close hands back whatever the run did not read. A
 * sentence that arrives while no run is open is refused with
 * {@link Submitted#NO_RUN} and never kept. The first build kept it, and the
 * NEXT run folded it into its first request as "sent while you were working",
 * a claim about a run that never saw it. Owner call 3 of the card asked for
 * the opposite: an unread sentence falls back to the old waiting line and
 * starts the next run as that run's own prompt.</p>
 *
 * <p>Every method holds the monitor, because the close and the refusal have to
 * be one step: a sentence that slipped in between "drained" and "closed" would
 * be exactly the leftover this class exists to rule out.</p>
 */
public final class SteeringInbox {

    /** The sentence the model reads, around the operator's own words.
     *
     * <p>Not decoration. The model has to be able to tell a person from a tool,
     * because a file in the workspace can print a sentence too, and a sentence
     * that arrives as bare content carries the operator's authority without
     * having earned it. {@code ProgressGuard} already fences a person's words
     * this way, and {@code Fire} fences an http payload the same way. */
    private static final String PREFIX =
            "The person watching this run sent a message while you were working. They said: ";

    /** What became of one submit. */
    public enum Submitted {
        /** In line; the running loop reads it at its next safe point. */
        WAITING,
        /** Null, empty or whitespace: dropped, nothing happened. */
        BLANK,
        /** No run is open to read it. Nothing was kept, and the caller owes the
         *  operator the text back. */
        NO_RUN
    }

    private final ArrayDeque<String> waiting = new ArrayDeque<>();
    private boolean open;

    /**
     * Puts one sentence in line, from whichever thread has it.
     *
     * <p>Blank is dropped HERE rather than at the caller: the edge is the one
     * place every submitter passes through, and a rule kept in the composer
     * only is a rule a second face can miss. The same rule {@code enqueue}
     * already keeps for the browser's waiting line.</p>
     *
     * @param text what the operator typed; null, empty and whitespace are refused
     * @return {@link Submitted#WAITING} when it is in line, {@link Submitted#BLANK}
     *         when there was nothing to put there, {@link Submitted#NO_RUN} when
     *         no run is open to read it
     */
    public synchronized Submitted submit(String text) {
        if (text == null || text.isBlank()) {
            return Submitted.BLANK;
        }
        if (!open) {
            return Submitted.NO_RUN;
        }
        waiting.add(text.strip());
        return Submitted.WAITING;
    }

    /** A run starts reading. Called by the loop before its first turn. */
    public synchronized void open() {
        open = true;
    }

    /**
     * The run is over, whichever way it ended: stop taking sentences and hand
     * back what nobody read.
     *
     * @return the unread sentences folded in arrival order, or null when the
     *         run read everything it was given
     */
    public synchronized String close() {
        open = false;
        return drain();
    }

    /** Whether anything is in line.
     *  @return true when a later {@link #take()} would return a sentence */
    public synchronized boolean waiting() {
        return !waiting.isEmpty();
    }

    /**
     * Takes everything in line, folded into one text in arrival order.
     *
     * <p>All of them rather than one: two sentences typed a second apart are one
     * correction, and delivering them across two turns would let the second
     * arrive after the model has acted on the first. The fleet's own
     * {@code FireSlot} coalesces the same way.</p>
     *
     * @return the folded text, or null when nothing was waiting
     */
    public synchronized String take() {
        return drain();
    }

    private String drain() {
        StringBuilder folded = new StringBuilder();
        for (String next = waiting.poll(); next != null; next = waiting.poll()) {
            if (!folded.isEmpty()) {
                folded.append('\n');
            }
            folded.append(next);
        }
        return folded.isEmpty() ? null : folded.toString();
    }

    /**
     * Wraps the operator's words in the attribution the model reads.
     *
     * @param text the folded sentences, as {@link #take()} returned them
     * @return the attributed text, with the operator's own words quoted
     */
    public static String attributed(String text) {
        return PREFIX + "\"" + text + "\"";
    }
}
