package dev.spectroscope.core.loop;

/**
 * Card 504, criteria 6 and 8: the words a loop puts in front of the model.
 *
 * <p>A self paced loop passes the sentinel {@link #SENTINEL} as the prompt of
 * its wakeups. The harness expands it when the wakeup fires: to the full
 * instructions on the first fire and after a compaction, to a short reminder
 * after that, so the history does not carry the whole text on every tick.
 * Reader 02 measured the same split in Claude Code's dynamic loop.</p>
 */
public final class LoopPrompts {

    /** The prompt a self paced loop passes to {@code schedule_wakeup}. */
    public static final String SENTINEL = "<<loop>>";
    /** The first line of the full loop instructions. */
    public static final String FULL_HEADING = "# Loop tick (self paced)";
    /** The first line of the short reminder. */
    public static final String REMINDER_HEADING = "# Loop tick (reminder)";
    /** Fix round 1: what opens a wakeup prompt the model wrote. */
    public static final String MODEL_WRITTEN_HEADING = "[Loop wakeup]";

    private LoopPrompts() {
    }

    /** The rules of a self paced tick, shared by the start and the full text. */
    private static final String RULES = """
            1. Run the task now.
            2. Write a short update for this tick as plain text: what you did and what you found.
            3. Then decide whether the loop goes on. If it should, call schedule_wakeup as the last call of the \
            turn, with delaySeconds (60 to 3600; pick it from how fast the thing you watch changes), reason (one \
            short sentence the operator sees) and prompt set to the literal text <<loop>>. The turn ends when \
            schedule_wakeup returns.
            4. If the task is done or cannot make progress, write a closing summary for the operator, then call \
            schedule_wakeup with stop: true. The turn ends when it returns as well.
            If a tick ends without schedule_wakeup, the harness wakes you once more after 20 minutes; a second \
            tick without it ends the loop.""";

    /**
     * What the run that a {@code /loop} without an interval starts reads.
     *
     * @param task the operator's prompt
     * @return the task, then the self pacing rules
     */
    public static String selfPacedStart(String task) {
        return task + "\n\n" + "The operator started a loop with /loop and no interval, so you pace it yourself."
                + "\n" + RULES;
    }

    /**
     * What the run that a {@code /loop} with an interval starts, and each of
     * its fires, reads.
     *
     * @param task            the operator's prompt
     * @param intervalSeconds the fixed interval
     * @return the task, then one line about the interval
     */
    public static String fixed(String task, int intervalSeconds) {
        return task + "\n\n" + "This run belongs to a loop the operator started with /loop every "
                + intervalSeconds + " s. The harness starts the next run by itself; call schedule_wakeup only "
                + "with stop: true, when the task is done, after a closing summary for the operator: the turn"
                + " ends when it returns.";
    }

    /**
     * The sentinel's full expansion: the first fire, and the first after a compaction.
     *
     * @param task the loop's task
     * @return the full instructions
     */
    public static String full(String task) {
        return FULL_HEADING + "\n" + "This turn was started by the loop you run in this session. The loop's task,"
                + " as the operator wrote it with /loop:\n\n" + task + "\n\n" + RULES;
    }

    /** @return the sentinel's short expansion, for every other fire */
    public static String reminder() {
        return REMINDER_HEADING + "\n" + "Run the loop's task with the loop instructions given earlier in this"
                + " conversation. Write the tick update, then call schedule_wakeup as the last call of the turn"
                + " with prompt <<loop>>, or write a closing summary and call it with stop: true to end the loop.";
    }

    /**
     * A self paced wakeup whose prompt is not the sentinel fires with the rule appended; a prompt
     * the model wrote arrives here already attributed ({@link #modelWritten}).
     *
     * @param prompt the prompt the model passed
     * @return the prompt and one line about the next wakeup
     */
    public static String verbatimSelfPaced(String prompt) {
        return prompt + "\n\n" + "This run was started by a loop wakeup. Write the tick update, then call"
                + " schedule_wakeup as the last call of the turn to go on, or write a closing summary and call it"
                + " with stop: true to end the loop.";
    }

    /**
     * Fix round 1: a wakeup prompt the model wrote with {@code schedule_wakeup},
     * attributed, so neither the record nor the model reads it as the
     * operator's own words.
     *
     * @param prompt  what the model passed
     * @param written when it passed it, HH:MM:SS
     * @return the attributed prompt
     */
    public static String modelWritten(String prompt, String written) {
        return MODEL_WRITTEN_HEADING + " The model wrote this prompt with schedule_wakeup at " + written
                + "; the operator did not type it.\n\n" + prompt;
    }
}
