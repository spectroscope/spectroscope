package dev.spectroscope.core.progress;

/**
 * The three numbers the progress guard fires on, and the one floor it will not
 * look below (card 262, criterion 6).
 *
 * <p><b>Zero means off.</b> Every field is a count, and a count of zero is the
 * off switch for that detector — one knob per detector rather than a knob and a
 * flag that can disagree about whether a detector with threshold 0 is enabled.
 * An operator who wants only the cheap detector sets the other two to 0.</p>
 *
 * <p><b>Why the defaults are what they are</b>, all three stated because card
 * 262 criterion 6 demands the default be stated rather than discovered:</p>
 * <ul>
 *   <li>{@link #identicalWrites()} = 3. The measured loop wrote the same 283
 *       bytes to 31 paths, and the model itself needed 31 copies to break out.
 *       Three is the first count at which "the same bytes under a new name" is
 *       no longer explicable as a legitimate second copy.</li>
 *   <li>{@link #repeatedFailures()} = 3. Bound by criterion 5: a flaky test that
 *       fails twice and then passes must stay silent, so the threshold sits
 *       above two AND the counter resets on any success of the same call.</li>
 *   <li>{@link #stalledPlanTurns()} = 0, i.e. <b>OFF</b>. This is the card's
 *       third net and it is the only one with a precondition it cannot check:
 *       it needs a plan that exists and is maintained. The runs this guard was
 *       cut for keep none — LM Studio reports the owner's model
 *       {@code trained_for_tool_use: false}, so it is handed no tool belt and
 *       can never call {@code update_plan}. Its false-positive surface is also
 *       the widest of the three: a run legitimately grinding through one plan
 *       step for six turns has not stalled. Built, tested, and off until an
 *       operator turns it on.</li>
 * </ul>
 *
 * @param identicalWrites   how many DISTINCT earlier paths must already carry
 *                          the exact bytes a write is about to repeat before the
 *                          guard fires; 0 disables the detector
 * @param repeatedFailures  how many times in a row one call with byte-identical
 *                          input must fail before the guard fires; 0 disables
 * @param stalledPlanTurns  how many consecutive turns a plan must sit unchanged,
 *                          with at least one step still open, before the guard
 *                          fires; 0 disables
 */
public record ProgressSettings(int identicalWrites, int repeatedFailures, int stalledPlanTurns) {

    /**
     * The floor under detector 1, in characters of content.
     *
     * <p>Not configurable, and deliberately so: it exists to keep one specific
     * class of honest work out of the detector rather than to be tuned. A
     * scaffold writes empty {@code __init__.py}, {@code py.typed} and
     * {@code .gitkeep} files by the dozen, all byte-identical and all
     * legitimate, and every one of them is shorter than this. The loop this card
     * was cut from wrote 283 bytes a time, four times over the floor.</p>
     */
    public static final int MIN_CONTENT_CHARS = 64;

    /** The shipped defaults: both cheap detectors on, the plan net off.
     *  @return the default settings */
    public static ProgressSettings defaults() {
        return new ProgressSettings(3, 3, 0);
    }

    /** Everything off — what a face with nobody attached is given, and what a
     *  test uses to prove the guard changes nothing when disabled.
     *  @return settings under which no detector can ever fire */
    public static ProgressSettings off() {
        return new ProgressSettings(0, 0, 0);
    }

    /** Whether any detector at all is armed.
     *  @return true when at least one threshold is above zero */
    public boolean armed() {
        return identicalWrites > 0 || repeatedFailures > 0 || stalledPlanTurns > 0;
    }
}
