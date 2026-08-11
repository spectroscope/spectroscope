package dev.spectroscope.core.graph;

/**
 * A node that also wants the config the run was started with — the thread id, a
 * caller's own knobs.
 *
 * <p>The second of the two node shapes; see {@link Node} for why the shape is
 * declared rather than inferred. This is the form the compiled graph stores: a
 * plain {@link Node} is adapted to it at {@code addNode}, so the runtime has one
 * call site and no branch to get wrong.</p>
 */
@FunctionalInterface
public interface ConfigAwareNode {

    /**
     * @param state  the state as it stood when the superstep began
     * @param config the run's config, never {@code null}
     * @return the channels this node wrote, or {@code null} for "nothing changed"
     * @throws Exception whatever the node's own work throws
     */
    StateUpdate run(GraphState state, RunConfig config) throws Exception;
}
