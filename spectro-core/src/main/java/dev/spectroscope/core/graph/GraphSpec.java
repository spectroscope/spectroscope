package dev.spectroscope.core.graph;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The frozen shape of a graph: everything the runtime executes and the viewer
 * draws, and nothing that changes while it does either.
 *
 * <p>A snapshot, not a view. A builder kept around after {@code compile()} can go
 * on being edited without the compiled graph quietly changing underneath a run
 * that is already in flight, so every collection here is copied on the way in
 * and unmodifiable on the way out.</p>
 *
 * @param schema   the declared channels and how they merge
 * @param nodes    the declared nodes in DECLARATION order — the order decides
 *                 the drawing's bytes, so it is a {@link LinkedHashMap} and
 *                 never a hash map
 * @param edges    the unconditional edges in declaration order
 * @param branches the conditional fan-outs in declaration order
 */
public record GraphSpec(StateSchema schema,
                        Map<String, ConfigAwareNode> nodes,
                        List<Edge> edges,
                        List<Branch> branches) {

    public GraphSpec {
        nodes = Collections.unmodifiableMap(new LinkedHashMap<>(nodes));
        edges = List.copyOf(edges);
        branches = List.copyOf(branches);
    }

    /**
     * One unconditional edge. {@code from} may be {@link StateGraph#START} and
     * {@code to} may be {@link StateGraph#END}; both are ordinary node ids.
     *
     * @param from the source
     * @param to   the destination
     */
    public record Edge(String from, String to) {
    }

    /**
     * One conditional fan-out: a source node, the decision, and the nodes that
     * decision can name.
     *
     * @param source   the node the decision leaves from
     * @param path     the decision itself
     * @param pathMap  what a return value translates to, or {@code null} when the
     *                 caller declared none — then the targets are UNKNOWABLE at
     *                 compile time, the drawing loses its arrows, and
     *                 reachability can no longer be proven for anything
     * @param targets  the de-duplicated destinations in declaration order; empty
     *                 for an unmapped branch
     */
    public record Branch(String source, ConfigAwareFanOutPath path,
                         Map<String, String> pathMap, List<String> targets) {

        public Branch {
            pathMap = pathMap == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(pathMap));
            targets = List.copyOf(targets);
        }
    }
}
