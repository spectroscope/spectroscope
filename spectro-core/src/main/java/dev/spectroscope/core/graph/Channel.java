package dev.spectroscope.core.graph;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.function.BinaryOperator;

/**
 * One channel of the state, and how a second write to it lands: folded through
 * a reducer, or straight over the top.
 *
 * <p>That distinction is the whole reason supersteps work. A superstep runs the
 * entire frontier, collects each node's partial update, and only then folds them
 * in — so two nodes writing the same reducing channel both survive, while two
 * nodes writing the same last-write-wins channel REFUSE, the way LangGraph
 * refuses. A silent frontier-order resolution was divergence D2, and it is
 * closed.</p>
 *
 * <p>The python edition reads the reducer out of a channel's {@code Annotated}
 * metadata and has to check by hand that it can serve as {@code (a, b) -> c},
 * because a reducer is only exercised on the SECOND write and an unusable one
 * survives a smoke test. Here the reducer is declared, and {@link BinaryOperator}
 * settles the arity at compile time; the only thing left to refuse is an absent
 * one, which is refused where it was declared rather than at the first fold.</p>
 */
public final class Channel {

    private final String name;
    private final BinaryOperator<Object> reducer;

    private Channel(String name, BinaryOperator<Object> reducer) {
        this.name = name;
        this.reducer = reducer;
    }

    /**
     * A channel where the newest write replaces the old value.
     *
     * @param name the channel name
     * @return the declaration
     */
    public static Channel lastWriteWins(String name) {
        return new Channel(name, null);
    }

    /**
     * A channel whose writes fold together.
     *
     * @param name    the channel name
     * @param reducer {@code (current, incoming) -> merged}, called only from the
     *                second write on — the first one seeds the channel
     * @return the declaration
     * @throws InvalidReducerException when no reducer is given, which would leave
     *                                 a channel that claims to fold and cannot
     */
    public static Channel reducing(String name, BinaryOperator<Object> reducer) {
        if (reducer == null) {
            throw new InvalidReducerException("Invalid reducer. Expected (a, b) -> c on channel '"
                    + name + "', got none. Declare Channel.lastWriteWins(\"" + name
                    + "\") if the channel is meant to overwrite.");
        }
        return new Channel(name, reducer);
    }

    /**
     * The common case: a channel that accumulates, python's
     * {@code Annotated[list, operator.add]}.
     *
     * <p>The fold builds a FRESH unmodifiable list rather than appending in
     * place. Java has no deep copy, so an in-place append at superstep 2 would
     * rewrite the snapshot superstep 1 already filed, and the run would stop
     * being replayable — which is the one property this package exists for.</p>
     *
     * @param name the channel name
     * @return the declaration
     */
    public static Channel appending(String name) {
        return reducing(name, (current, incoming) -> {
            List<Object> merged = new ArrayList<>(asList(current));
            merged.addAll(asList(incoming));
            return Collections.unmodifiableList(merged);
        });
    }

    private static List<Object> asList(Object value) {
        return value instanceof Collection<?> collection
                ? new ArrayList<>(collection)
                : Collections.singletonList(value);
    }

    /** The declared name. */
    public String name() {
        return name;
    }

    /** Whether a second write folds rather than overwrites. */
    public boolean folds() {
        return reducer != null;
    }

    /**
     * @param current  the value already in the channel, never {@code null} —
     *                 a reducer needs a left operand, so an absent or null
     *                 channel is seeded by the caller instead
     * @param incoming the value the node wrote
     * @return the merged value; never the same object as {@code current}
     */
    Object fold(Object current, Object incoming) {
        return reducer.apply(current, incoming);
    }

    @Override
    public String toString() {
        return "Channel[" + name + (folds() ? ", reducing]" : ", lastWriteWins]");
    }
}
