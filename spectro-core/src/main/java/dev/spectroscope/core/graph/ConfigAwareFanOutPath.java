package dev.spectroscope.core.graph;

/**
 * A conditional edge's decision that also wants the run's config.
 *
 * <p>The same two-shape model as {@link Node} / {@link ConfigAwareNode}, for the
 * same reason: the config-taking form is declared, never guessed from a
 * signature Java does not carry at run time. This is the form a compiled graph
 * stores; a plain {@link FanOutPath} is adapted to it at declaration.</p>
 */
@FunctionalInterface
public interface ConfigAwareFanOutPath {

    /**
     * @param state  the state AFTER the whole frontier merged
     * @param config the run's config, never {@code null}
     * @return a node name, {@link StateGraph#END}, a path-map key, or a
     *         collection of those for a fan-out
     * @throws Exception whatever the decision's own work throws
     */
    Object route(GraphState state, RunConfig config) throws Exception;
}
