package dev.spectroscope.core.graph;

/**
 * A node that reads the state and writes a partial update.
 *
 * <p>This is one of the two node shapes; {@link ConfigAwareNode} is the other.
 * The python edition decides which one a callable is by reading the parameter
 * NAMES off its signature — a parameter literally called {@code config} gets the
 * run's config injected. Java erases parameter names, so the shape is declared
 * instead: which overload of {@link StateGraph#addNode} a lambda binds to IS the
 * decision, settled by the compiler at the call site.</p>
 *
 * <p>What the runtime must never do is decide by calling the node and catching
 * an arity error. A node whose own body throws would then be misread as a
 * different shape, run a second time, and have its real failure reported as a
 * signature problem. That was a measured bug in the python edition (ledger row
 * F3), and Java's overload resolution makes the whole question disappear.</p>
 */
@FunctionalInterface
public interface Node {

    /**
     * @param state the state as it stood when the superstep began — a sibling's
     *              write from this same superstep is deliberately not in it
     * @return the channels this node wrote, or {@code null} for "nothing changed"
     * @throws Exception whatever the node's own work throws; the runtime lets it
     *                   through unchanged so the caller's own catch still works
     */
    StateUpdate run(GraphState state) throws Exception;
}
