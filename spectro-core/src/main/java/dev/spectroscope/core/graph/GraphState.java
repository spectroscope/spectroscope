package dev.spectroscope.core.graph;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The values a run carries between supersteps — a channel map, frozen.
 *
 * <p>The python edition hands every node in a frontier its own shallow copy of a
 * mutable {@code dict}, because a node that writes into the mapping it was
 * handed would otherwise become a sibling's wrong answer. Java can close that by
 * type instead of by copying: a state is built once from a detached
 * {@link LinkedHashMap} and handed out through an unmodifiable view, so the same
 * instance can go to the whole frontier and a node that tries to write into it
 * fails at the attempt rather than silently poisoning a sibling.</p>
 *
 * <p>The copy is shallow in both editions, and deliberately so: a node that
 * mutates a list <em>inside</em> a channel still reaches everyone holding that
 * list. That is why {@link Channel#appending} folds into a fresh unmodifiable
 * list rather than appending in place — the pre-superstep state is handed to
 * every node in the frontier, and a checkpointer keeps older snapshots alive to
 * serve history.</p>
 *
 * <p>Insertion order is preserved throughout. Channel order is what a topology
 * and an artifact are compared by, so no unordered map is ever allowed to decide
 * it.</p>
 */
public final class GraphState {

    private final Map<String, Object> values;

    private GraphState(Map<String, Object> owned) {
        this.values = Collections.unmodifiableMap(owned);
    }

    /** The state a run with nothing persisted and nothing handed in starts from. */
    public static GraphState empty() {
        return new GraphState(new LinkedHashMap<>());
    }

    /**
     * A state detached from the caller's map, so a later write on their side
     * cannot reach into a run already in flight.
     *
     * @param values the channels, in the order they should stay in
     * @return an independent state carrying the same values
     */
    public static GraphState of(Map<String, ?> values) {
        return new GraphState(new LinkedHashMap<>(values));
    }

    /** Takes ownership of a map the caller has just built and will not touch again. */
    static GraphState adopt(LinkedHashMap<String, Object> owned) {
        return new GraphState(owned);
    }

    /**
     * @param channel the channel name
     * @return its value, or {@code null} when nothing has written it — the two
     *         are not distinguished, exactly as a python {@code dict.get} does
     *         not distinguish them, because a reducer treats both as "seed me"
     */
    public Object get(String channel) {
        return values.get(channel);
    }

    /** Whether the channel has been written at all — {@code null} counts as written. */
    public boolean has(String channel) {
        return values.containsKey(channel);
    }

    /** Every channel, in write order, unmodifiable. */
    public Map<String, Object> values() {
        return values;
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof GraphState state && values.equals(state.values);
    }

    @Override
    public int hashCode() {
        return values.hashCode();
    }

    @Override
    public String toString() {
        return "GraphState" + values;
    }
}
