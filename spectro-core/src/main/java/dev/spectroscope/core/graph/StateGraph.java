package dev.spectroscope.core.graph;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Collects nodes and edges, then hands out a validated {@link GraphSpec}.
 *
 * <p>A LangGraph run is inferred from its logs afterwards. This package exists to
 * invert that: the topology is fixed and serializable the moment
 * {@link #compile()} returns, so a viewer can draw the whole machine and then
 * light it up as the run moves through it. Everything here serves that one
 * property, which is also why validation lives here and is loud.</p>
 *
 * <p>Thirteen refusals in all. Four fire eagerly at {@link #addNode}, two at
 * {@link #addEdge}, two at {@link #addConditionalEdges} — none of those can be
 * repaired by a later call, and an error at the offending line beats one at the
 * bottom of a builder function. The remaining five wait for {@link #toSpec()},
 * because an edge is routinely declared before the node it points at.</p>
 *
 * <p>Every method returns {@code this}. Callers chain, and a drop-in that breaks
 * a chained call is not a drop-in.</p>
 */
public final class StateGraph {

    /**
     * The virtual node every run starts from. A plain string on purpose: it is a
     * key in a path map, a value in the serialized topology, and an entry in the
     * artifact. Anything richer would need special-casing in all three.
     */
    public static final String START = "__start__";

    /** The virtual node a run falls off. Same reasoning as {@link #START}. */
    public static final String END = "__end__";

    private final StateSchema schema;
    private final Map<String, ConfigAwareNode> nodes = new LinkedHashMap<>();
    private final List<GraphSpec.Edge> edges = new ArrayList<>();
    private final List<GraphSpec.Branch> branches = new ArrayList<>();

    /**
     * @param schema the declared channels; {@link StateSchema#of(Channel...)} for a graph
     *               where every channel simply overwrites
     */
    public StateGraph(StateSchema schema) {
        this.schema = schema;
    }

    // -- building ----------------------------------------------------------- //

    /**
     * Declares a node that reads only the state.
     *
     * @param name   the node's identity, which is what a run is traced by
     * @param action the work
     * @return this builder
     * @throws GraphValidationException on an empty name, a reserved name, a
     *                                  duplicate, or an absent action
     */
    public StateGraph addNode(String name, Node action) {
        if (action == null) {
            throw new GraphValidationException(
                    "addNode(" + quoted(name) + "): the action must not be null.");
        }
        return addNode(name, (ConfigAwareNode) (state, config) -> action.run(state));
    }

    /**
     * Declares a node that also wants the run's config.
     *
     * <p>The action's own shape is never inspected beyond this overload choice —
     * see {@link Node} for why deciding by signature, or worse by calling and
     * catching, is the mistake this design exists to make impossible.</p>
     *
     * @param name   the node's identity
     * @param action the work
     * @return this builder
     * @throws GraphValidationException on an empty name, a reserved name, a
     *                                  duplicate, or an absent action
     */
    public StateGraph addNode(String name, ConfigAwareNode action) {
        if (name == null || name.isEmpty()) {
            throw new GraphValidationException(
                    "addNode: a node name must be a non-empty string, got " + quoted(name) + ".");
        }
        if (START.equals(name) || END.equals(name)) {
            throw new GraphValidationException("addNode(" + quoted(name) + "): " + quoted(name)
                    + " is reserved for the virtual " + (START.equals(name) ? "start" : "end")
                    + " node. Pick another name.");
        }
        if (nodes.containsKey(name)) {
            throw new GraphValidationException("addNode(" + quoted(name) + "): already defined. "
                    + "Node names are the identity a run is traced by, so they have to be unique.");
        }
        if (action == null) {
            throw new GraphValidationException(
                    "addNode(" + quoted(name) + "): the action must not be null.");
        }
        nodes.put(name, action);
        return this;
    }

    /**
     * Declares an unconditional edge.
     *
     * <p>Whether the two ends exist is checked at {@link #toSpec()}, not here —
     * edges are routinely declared before the nodes they point at. The two
     * refusals below are different in kind: nothing leaves END and nothing
     * enters START, so no later {@code addNode} could make them valid.</p>
     *
     * <p>An identical edge declared twice is recorded once. It is a no-op
     * semantically, and a duplicate would draw a second arrow.</p>
     *
     * @param from the source, possibly {@link #START}
     * @param to   the destination, possibly {@link #END}
     * @return this builder
     * @throws GraphValidationException when the edge leaves END or enters START
     */
    public StateGraph addEdge(String from, String to) {
        if (END.equals(from)) {
            throw new GraphValidationException("addEdge(" + quoted(from) + ", " + quoted(to)
                    + "): nothing leaves END — it is where a run stops.");
        }
        if (START.equals(to)) {
            throw new GraphValidationException("addEdge(" + quoted(from) + ", " + quoted(to)
                    + "): nothing enters START — it is where a run begins.");
        }
        GraphSpec.Edge edge = new GraphSpec.Edge(from, to);
        if (!edges.contains(edge)) {
            edges.add(edge);
        }
        return this;
    }

    /** Sugar for {@code addEdge(START, name)}, kept because LangGraph has it. */
    public StateGraph setEntryPoint(String name) {
        return addEdge(START, name);
    }

    /**
     * Declares a fan-out with no path map — the forgiving form, at a cost.
     *
     * <p>LangGraph then uses the decision's return value as the node name
     * directly. It is legal and the view pays for it: the possible targets stop
     * being knowable at compile time, so the branch is drawn as a decision with
     * no arrows and reachability can no longer be proven for anything.</p>
     *
     * @param source the node the decision leaves from
     * @param path   the decision
     * @return this builder
     */
    public StateGraph addConditionalEdges(String source, FanOutPath path) {
        return addConditionalEdges(source, adapt(source, path), (Map<String, String>) null);
    }

    /**
     * Declares a fan-out whose return values translate through a map.
     *
     * <p>The map's ITERATION ORDER is the order the arrows are drawn in, and so
     * part of the topology's bytes. Pass a {@link LinkedHashMap}: {@code Map.of}
     * is randomly ordered per JVM start, which would make two runs of the same
     * graph produce two different drawings.</p>
     *
     * @param source  the node the decision leaves from
     * @param path    the decision
     * @param pathMap what a return value means, or {@code null} for none
     * @return this builder
     */
    public StateGraph addConditionalEdges(String source, FanOutPath path, Map<String, String> pathMap) {
        return addConditionalEdges(source, adapt(source, path), pathMap);
    }

    /**
     * Declares a fan-out whose return values ARE node names.
     *
     * @param source  the node the decision leaves from
     * @param path    the decision
     * @param pathMap the reachable node names, normalised to an identity mapping
     * @return this builder
     */
    public StateGraph addConditionalEdges(String source, FanOutPath path, List<String> pathMap) {
        return addConditionalEdges(source, adapt(source, path), identity(source, pathMap));
    }

    /** The config-taking form of {@link #addConditionalEdges(String, FanOutPath)}. */
    public StateGraph addConditionalEdges(String source, ConfigAwareFanOutPath path) {
        return addConditionalEdges(source, path, (Map<String, String>) null);
    }

    /** The config-taking form of {@link #addConditionalEdges(String, FanOutPath, List)}. */
    public StateGraph addConditionalEdges(String source, ConfigAwareFanOutPath path, List<String> pathMap) {
        return addConditionalEdges(source, path, identity(source, pathMap));
    }

    /**
     * The config-taking form of
     * {@link #addConditionalEdges(String, FanOutPath, Map)}, and the one seam the
     * other five delegate to.
     *
     * @param source  the node the decision leaves from
     * @param path    the decision
     * @param pathMap what a return value means, or {@code null} for none
     * @return this builder
     * @throws GraphValidationException on an absent decision or END as a source
     */
    public StateGraph addConditionalEdges(String source, ConfigAwareFanOutPath path,
                                          Map<String, String> pathMap) {
        if (path == null) {
            throw new GraphValidationException(
                    "addConditionalEdges(" + quoted(source) + "): the path must not be null.");
        }
        if (END.equals(source)) {
            throw new GraphValidationException(
                    "addConditionalEdges(" + quoted(source) + "): nothing leaves END.");
        }
        // Several return values routing to one node is normal, and the drawing
        // needs one arrow — so the targets are de-duplicated, keeping the map's
        // own order.
        List<String> targets = pathMap == null
                ? List.of()
                : new ArrayList<>(new LinkedHashSet<>(pathMap.values()));
        branches.add(new GraphSpec.Branch(source, path, pathMap, targets));
        return this;
    }

    private ConfigAwareFanOutPath adapt(String source, FanOutPath path) {
        if (path == null) {
            throw new GraphValidationException(
                    "addConditionalEdges(" + quoted(source) + "): the path must not be null.");
        }
        return (state, config) -> path.route(state);
    }

    private Map<String, String> identity(String source, List<String> names) {
        if (names == null) {
            return null;
        }
        LinkedHashMap<String, String> mapping = new LinkedHashMap<>();
        for (String name : names) {
            if (name == null) {
                throw new GraphValidationException("addConditionalEdges(" + quoted(source)
                        + "): a list path map holds node names, got null.");
            }
            mapping.put(name, name);
        }
        return mapping;
    }

    // -- freezing ----------------------------------------------------------- //

    /**
     * Validates the graph and returns an independent snapshot of it.
     *
     * @return the frozen spec; later builder mutation cannot reach it
     * @throws GraphValidationException for each of the five deferred faults, in
     *                                  the documented order
     */
    public GraphSpec toSpec() {
        validate();
        return new GraphSpec(schema, nodes, edges, branches);
    }

    /**
     * Validates, freezes, and hands the result to the runtime.
     *
     * @return a graph that can already describe itself: its topology is true
     *         before a single node has run, which is the property this package
     *         exists for
     */
    public CompiledGraph compile() {
        return new CompiledGraph(toSpec());
    }

    // -- validation --------------------------------------------------------- //

    /** Every way a graph can be undrawable, each with the offender named. */
    private void validate() {
        Set<String> known = nodes.keySet();

        for (GraphSpec.Edge edge : edges) {
            if (!START.equals(edge.from()) && !known.contains(edge.from())) {
                throw new GraphValidationException(refusedEdge(edge, edge.from()));
            }
            if (!END.equals(edge.to()) && !known.contains(edge.to())) {
                throw new GraphValidationException(refusedEdge(edge, edge.to()));
            }
        }

        for (GraphSpec.Branch branch : branches) {
            if (!START.equals(branch.source()) && !known.contains(branch.source())) {
                throw new GraphValidationException("addConditionalEdges(" + quoted(branch.source())
                        + ", ...): " + quoted(branch.source()) + " is not a node. Declared nodes: "
                        + known + ".");
            }
            for (String target : branch.targets()) {
                if (!END.equals(target) && !known.contains(target)) {
                    throw new GraphValidationException("addConditionalEdges("
                            + quoted(branch.source()) + ", ...): the path map routes to "
                            + quoted(target) + ", which is not a node. Declared nodes: " + known + ".");
                }
            }
        }

        if (!hasEntry()) {
            throw new GraphValidationException("the graph has no entry: add an edge from START to "
                    + "the first node, e.g. addEdge(START, "
                    + quoted(known.isEmpty() ? "first_node" : known.iterator().next()) + ").");
        }

        Set<String> reachable = reachable();
        List<String> unreachable = new ArrayList<>();
        for (String name : known) {
            if (!reachable.contains(name)) {
                unreachable.add(name);
            }
        }
        if (!unreachable.isEmpty()) {
            throw new GraphValidationException("unreachable from START: " + unreachable
                    + ". Every node needs an edge or a path map entry leading to it, or the run "
                    + "can never enter it.");
        }
    }

    private String refusedEdge(GraphSpec.Edge edge, String offender) {
        return "addEdge(" + quoted(edge.from()) + ", " + quoted(edge.to()) + "): " + quoted(offender)
                + " is not a node. Declared nodes: " + nodes.keySet() + ".";
    }

    private boolean hasEntry() {
        return edges.stream().anyMatch(edge -> START.equals(edge.from()))
                || branches.stream().anyMatch(branch -> START.equals(branch.source()));
    }

    /**
     * Nodes a run can actually enter, walked from START.
     *
     * <p>A branch with no path map is treated as reaching every node. Its real
     * targets are unknowable, and calling a node unreachable on the strength of
     * a guess would refuse a legal graph.</p>
     */
    private Set<String> reachable() {
        Map<String, Set<String>> adjacency = new LinkedHashMap<>();
        for (GraphSpec.Edge edge : edges) {
            adjacency.computeIfAbsent(edge.from(), key -> new LinkedHashSet<>()).add(edge.to());
        }
        for (GraphSpec.Branch branch : branches) {
            Set<String> reached = branch.pathMap() == null
                    ? new LinkedHashSet<>(nodes.keySet())
                    : new LinkedHashSet<>(branch.targets());
            adjacency.computeIfAbsent(branch.source(), key -> new LinkedHashSet<>()).addAll(reached);
        }

        Set<String> seen = new LinkedHashSet<>();
        seen.add(START);
        Deque<String> frontier = new ArrayDeque<>();
        frontier.push(START);
        while (!frontier.isEmpty()) {
            for (String next : adjacency.getOrDefault(frontier.pop(), Set.of())) {
                if (seen.add(next)) {
                    frontier.push(next);
                }
            }
        }
        return seen;
    }

    private static String quoted(String value) {
        return value == null ? "null" : "'" + value + "'";
    }
}
