package dev.spectroscope.core.graph;

/**
 * The decision behind a conditional edge: given the state, where does the run go
 * next.
 *
 * <p>Named {@code FanOutPath} and not {@code Path} on purpose. A caller writing
 * {@code import dev.spectroscope.core.graph.*;} would otherwise get "reference to
 * Path is ambiguous" against {@link java.nio.file.Path}, in exactly the files
 * most likely to be written by hand.</p>
 *
 * <p>Nothing may depend on the function's own name — the measured caller passes
 * lambdas. That is why a branch is named after its SOURCE node everywhere: in
 * the topology, in the artifact, and in the error a bad return value raises.</p>
 */
@FunctionalInterface
public interface FanOutPath {

    /**
     * @param state the state AFTER the whole frontier merged, which is the only
     *              reading that makes a router's decision reproducible
     * @return a node name, {@link StateGraph#END}, a key of the branch's path
     *         map, or a collection of those for a fan-out
     * @throws Exception whatever the decision's own work throws
     */
    Object route(GraphState state) throws Exception;
}
