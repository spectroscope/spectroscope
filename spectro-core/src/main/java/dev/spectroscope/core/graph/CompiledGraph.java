package dev.spectroscope.core.graph;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

import static dev.spectroscope.core.graph.StateGraph.END;
import static dev.spectroscope.core.graph.StateGraph.START;

/**
 * A frozen graph, ready to run and already able to describe itself.
 *
 * <p>Execution is Pregel-style. One superstep runs the ENTIRE current frontier,
 * collects every node's update, and only then applies them. A node never sees a
 * sibling's write from its own superstep — if updates were applied as they
 * arrived, a node could read a sibling's write and the run would stop being
 * reproducible. Determinism is the product: a run that cannot be replayed cannot
 * be watched.</p>
 *
 * <p>Frontier order is declaration order throughout, never a hash set's order.
 * It decides how two nodes writing the same last-write-wins channel resolve, so
 * an unordered collection anywhere in the walk would make the same graph give
 * two answers.</p>
 *
 * <p>The frontier runs its nodes one after another. The python edition runs them
 * concurrently, and every property above survives either way: what makes a
 * superstep a superstep is that no update is applied until every node has
 * returned, not that the nodes overlap in time. Concurrency here is a
 * performance question, and it is deliberately not answered yet.</p>
 */
public final class CompiledGraph {

    /**
     * The superstep ceiling a run gets when the caller names none.
     *
     * <p>LangGraph 1.x's own number, counted rather than read: a runaway
     * single-node cycle runs exactly this many iterations there. An earlier 25
     * was a margin chosen against one caller's loop, and it is the obvious wrong
     * guess — a corrective-RAG graph configured for four rewrites legitimately
     * needs 27 supersteps, so at 25 an operator got a working system on LangGraph
     * and a recursion failure here.</p>
     */
    public static final int DEFAULT_RECURSION_LIMIT = 10007;

    /**
     * How many frontiers are kept to name a cycle in the failure message. A
     * ceiling of ten thousand must not quietly turn into ten thousand retained
     * frontiers.
     */
    private static final int RETAINED_FRONTIERS = 16;

    private final GraphSpec spec;
    private final Topology topology;
    private final Map<String, List<String>> edgesFrom = new LinkedHashMap<>();
    private final Map<String, List<NamedBranch>> branchesFrom = new LinkedHashMap<>();

    /** A branch carried with the name the topology gave it. */
    private record NamedBranch(GraphSpec.Branch branch, String name) {
    }

    CompiledGraph(GraphSpec spec) {
        this.spec = spec;
        this.topology = Topology.of(spec);
        for (GraphSpec.Edge edge : spec.edges()) {
            edgesFrom.computeIfAbsent(edge.from(), key -> new ArrayList<>()).add(edge.to());
        }
        // The branch names are read back OUT of the topology rather than
        // recomputed: one naming algorithm, in the module that owns the drawing.
        // A second implementation would drift, and then the records would stop
        // agreeing with the picture they are supposed to light up.
        for (int index = 0; index < spec.branches().size(); index++) {
            GraphSpec.Branch branch = spec.branches().get(index);
            String name = topology.branches().get(index).name();
            branchesFrom.computeIfAbsent(branch.source(), key -> new ArrayList<>())
                    .add(new NamedBranch(branch, name));
        }
    }

    /** The frozen graph this was compiled from. */
    public GraphSpec spec() {
        return spec;
    }

    /**
     * The drawing, computed once at compile time and never recomputed — a
     * topology that could change between runs would make the view a guess.
     */
    public Topology topology() {
        return topology;
    }

    /**
     * Runs to completion from a plain channel map.
     *
     * @param input the starting channels
     * @return the end state
     * @throws Exception whatever a node or a decision threw
     */
    public GraphState invoke(Map<String, ?> input) throws Exception {
        return invoke(GraphState.of(input), RunConfig.defaults());
    }

    /**
     * Runs to completion under the default config.
     *
     * @param input the starting state
     * @return the end state
     * @throws Exception whatever a node or a decision threw
     */
    public GraphState invoke(GraphState input) throws Exception {
        return invoke(input, RunConfig.defaults());
    }

    /**
     * Runs to completion.
     *
     * <p>The run starts from the input folded THROUGH the reducers rather than
     * used as-is, so the seeding rules are the same whether or not there is a
     * past to continue from. It ends when the frontier is empty — everything
     * fell into END or had no outgoing edge; END is virtual and never executed.</p>
     *
     * <p>A node's own exception reaches the caller unchanged, never wrapped. A
     * caller that already catches its own failure type must keep working, and a
     * wrapper would also let a runtime concern demote the real failure to a
     * cause.</p>
     *
     * @param input  the starting state
     * @param config the ceiling and the caller's addressing map
     * @return the end state
     * @throws GraphRecursionException when the ceiling is reached without END
     * @throws Exception               whatever a node or a decision threw
     */
    public GraphState invoke(GraphState input, RunConfig config) throws Exception {
        int limit = config.resolvedRecursionLimit();
        GraphState state = spec.schema().apply(GraphState.empty(), StateUpdate.ofMap(input.values()));

        int step = 0;
        List<String> frontier = nextFrontier(List.of(START), state, config);
        Deque<List<String>> recent = new ArrayDeque<>();

        while (!frontier.isEmpty()) {
            if (step >= limit) {
                throw new GraphRecursionException(cycleMessage(limit, recent));
            }
            if (recent.size() == RETAINED_FRONTIERS) {
                recent.removeFirst();
            }
            recent.addLast(frontier);

            // The whole frontier runs against ONE state and every update is held
            // back until the last node has returned. Collecting first is what
            // makes a superstep a superstep.
            List<Map.Entry<String, StateUpdate>> results = new ArrayList<>();
            for (String name : frontier) {
                results.add(Map.entry(name, wrapped(spec.nodes().get(name).run(state, config))));
            }
            for (Map.Entry<String, StateUpdate> result : results) {
                state = spec.schema().apply(state, result.getValue());
            }

            step++;
            List<String> sources = results.stream().map(Map.Entry::getKey).toList();
            frontier = nextFrontier(sources, state, config);
        }
        return state;
    }

    /**
     * A node's {@code null} return means "nothing changed", which the merge
     * already understands. The wrapper exists so the null never has to be
     * carried through a {@link Map#entry} that refuses it.
     */
    private static StateUpdate wrapped(StateUpdate update) {
        return update == null ? StateUpdate.none() : update;
    }

    /**
     * Where the run goes after these nodes.
     *
     * <p>Built by walking, per source in results order: first every static edge
     * out of that source in declaration order, then each branch out of it in
     * declaration order. Duplicates collapse keeping the first occurrence — a
     * fan-out reaching the same node by two routes runs it once — and END drops
     * out, because it is virtual.</p>
     *
     * <p>Conditional edges are evaluated against the state as it stands AFTER the
     * superstep merged. Deciding on the pre-merge state would route on the answer
     * to the previous question.</p>
     */
    private List<String> nextFrontier(List<String> sources, GraphState state, RunConfig config)
            throws Exception {
        LinkedHashSet<String> targets = new LinkedHashSet<>();
        for (String source : sources) {
            targets.addAll(edgesFrom.getOrDefault(source, List.of()));
            for (NamedBranch named : branchesFrom.getOrDefault(source, List.of())) {
                targets.addAll(route(named.branch(), state, config));
            }
        }
        targets.remove(END);
        return List.copyOf(targets);
    }

    /** Resolves one conditional edge to node names; a collection return fans out. */
    private List<String> route(GraphSpec.Branch branch, GraphState state, RunConfig config)
            throws Exception {
        Object decision = branch.path().route(state, config);
        List<String> resolved = new ArrayList<>();
        if (decision instanceof Collection<?> many) {
            for (Object value : many) {
                resolved.add(mapTarget(branch, value));
            }
        } else {
            resolved.add(mapTarget(branch, decision));
        }
        return resolved;
    }

    /**
     * Translates one return value of a decision into a node name.
     *
     * <p>A path map is consulted first; a value that is already a node name (or
     * END) is honoured even when the map does not mention it, which is the
     * forgiving reading and costs nothing. Anything else is a routing bug, and
     * the message names the SOURCE NODE — decisions are routinely lambdas, so
     * their own name would say nothing.</p>
     */
    private String mapTarget(GraphSpec.Branch branch, Object value) {
        Map<String, String> pathMap = branch.pathMap();
        if (value instanceof String name) {
            if (pathMap != null && pathMap.containsKey(name)) {
                return pathMap.get(name);
            }
            if (END.equals(name) || spec.nodes().containsKey(name)) {
                return name;
            }
        }
        Object known = pathMap == null ? spec.nodes().keySet() : pathMap.keySet();
        throw new GraphValidationException("the conditional edge from '" + branch.source()
                + "' returned " + value + ", which is neither a node of this graph nor a key of "
                + "its path map (known: " + known + ")");
    }

    /**
     * Names the loop that ran out of supersteps.
     *
     * <p>Whoever hits this is looking at a hung request, so the message carries
     * the cycle itself and the knob that widens it, not just a number.</p>
     */
    private static String cycleMessage(int limit, Deque<List<String>> recent) {
        LinkedHashSet<String> cycling = new LinkedHashSet<>();
        recent.forEach(cycling::addAll);
        String route = cycling.isEmpty() ? "(nothing)" : String.join(" -> ", cycling);
        return "the graph took its recursion_limit of " + limit + " supersteps without reaching END; "
                + "it is cycling through " + route + ". Give the cycle an exit, or raise the ceiling "
                + "with RunConfig.withRecursionLimit(N).";
    }
}
