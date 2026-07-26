package dev.spectroscope.core.leveling;

import dev.spectroscope.core.events.RunEvent;

import java.io.IOException;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Holds this home's ladder state in memory and persists every change.
 *
 * <p>The fold decides what a piece of evidence means; this class owns the one
 * mutable cell and the file behind it. Every mutation is synchronized, so the
 * server's threads (a socket run, a REST beacon, the settings) cannot interleave
 * a read-modify-write.</p>
 *
 * <p>Failures are absorbed on purpose. A home whose disk refuses the state file
 * still runs agents; it just stops keeping score, and says so once. That is the
 * registered-port contract from card 16, applied one layer up so it also holds
 * for beacons that arrive over REST.</p>
 */
public final class LevelingRecorder {

    private final Ladder ladder;
    private final LevelingStore store;
    private final AtomicBoolean warned = new AtomicBoolean();
    private LevelingState state;

    /**
     * @param ladder the ladder in force
     * @param store where the state lives
     * @param freshMode the mode to use when the store has nothing yet
     */
    public LevelingRecorder(Ladder ladder, LevelingStore store, LevelingState.Mode freshMode) {
        this.ladder = Objects.requireNonNull(ladder, "ladder");
        this.store = Objects.requireNonNull(store, "store");
        Optional<LevelingState> stored = store.read();
        this.state = stored.orElseGet(() -> LevelingState.fresh(
                Objects.requireNonNull(freshMode, "freshMode")));
        if (stored.isEmpty() && state.mode() != LevelingState.Mode.OFF) {
            // Write the fresh-home decision down at once. It is derived from what the
            // home looks like right now, and the home changes within seconds of this
            // line (the server seeds its settings file). An unrecorded decision would
            // be re-made on the next start against a home that no longer looks new.
            // Off is the exception: a home that tracks nothing needs no file to say so.
            persist();
        }
    }

    /** @return the ladder this recorder measures against */
    public Ladder ladder() {
        return ladder;
    }

    /** @return the current state, a snapshot that will not change under the caller */
    public synchronized LevelingState state() {
        return state;
    }

    /**
     * Folds one event of a live run.
     *
     * @param sessionId the session the event belongs to
     * @param eventIndex its position in that session
     * @param event the event
     */
    public synchronized void observe(String sessionId, int eventIndex, RunEvent event) {
        apply(LevelingFold.observe(ladder, state, sessionId, eventIndex, event));
    }

    /**
     * Records that a face showed a surface.
     *
     * @param surface the surface id
     * @param sessionId the session on screen, may be null
     * @param ts when it happened
     */
    public synchronized void visit(String surface, String sessionId, long ts) {
        apply(LevelingFold.visit(ladder, state, surface, sessionId, ts));
    }

    /**
     * Marks a criterion by hand.
     *
     * @param criterionId the criterion
     * @param ts when the operator ticked it
     */
    public synchronized void tick(String criterionId, long ts) {
        apply(LevelingFold.tick(ladder, state, criterionId, ts));
    }

    /**
     * Marks a criterion the server established for itself.
     *
     * @param criterionId the criterion
     * @param ts when it was established
     */
    public synchronized void establish(String criterionId, long ts) {
        apply(LevelingFold.establish(ladder, state, criterionId, ts));
    }

    /**
     * Restarts the ladder from the dark frame, keeping the operator's chosen mode.
     *
     * <p>Persisted even in {@code off}: a wipe the disk never heard about would
     * come back at the next start, and an operator who asked to start over would
     * find their old marks waiting.</p>
     */
    public synchronized void reset() {
        LevelingState wiped = LevelingFold.reset(state);
        if (wiped.equals(state)) {
            return;
        }
        state = wiped;
        persist();
    }

    /**
     * Switches the mode. A switch is always persisted, including into and out of
     * {@code off}, because the operator's decision is not tracking data.
     *
     * @param mode the new mode
     */
    public synchronized void mode(LevelingState.Mode mode) {
        Objects.requireNonNull(mode, "mode");
        if (state.mode() == mode) {
            // Picking the mode you are already in is still an answer, and the most
            // likely one: the intro offers the ladder, and a fresh home starts in
            // it. Returning early here would throw that answer away and ask again
            // on the next boot.
            introAnswered();
            return;
        }
        // Choosing a mode IS the answer to the intro question, whichever way it goes.
        state = new LevelingState(mode, state.marks(), state.history(), state.facts(), true);
        persist();
    }

    /** Records that the once-per-home intro no longer needs asking. */
    public synchronized void introAnswered() {
        if (state.introSeen()) {
            return;
        }
        state = state.withIntroSeen();
        persist();
    }

    private void apply(LevelingState next) {
        if (next == state) {
            return;
        }
        state = next;
        if (state.mode() != LevelingState.Mode.OFF) {
            persist();
        }
    }

    private void persist() {
        try {
            store.write(state);
        } catch (IOException | RuntimeException unwritable) {
            if (warned.compareAndSet(false, true)) {
                System.err.println("leveling: cannot write " + store.file()
                        + ", the ladder stops keeping score (" + unwritable + ")");
            }
        }
    }
}
