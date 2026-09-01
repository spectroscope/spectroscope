package dev.spectroscope.core.graph;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.governing.Governs;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The serializable shape of a graph: what a viewer draws, fixed before a single
 * node has run.
 *
 * <p>Load-bearing, so it is complete and it is stable. Complete means START and
 * END appear as ordinary nodes — a renderer that has to special-case two
 * sentinels will get one of them wrong — and every conditional target is an edge
 * of its own, tagged with the branch it belongs to, so a decision reads as a
 * fan-out rather than a dead end.</p>
 *
 * <p>Stable means the same graph yields the same bytes. Order comes from
 * declaration order throughout: START, the nodes as declared, END; then the
 * direct edges as declared, then the conditional ones branch by branch. No
 * unordered collection is ever iterated into the output. Artifacts get compared
 * across runs, and a topology that reshuffles itself would make every comparison
 * noise.</p>
 *
 * @param schemaVersion bumped when this shape changes, so a reader from a later
 *                      version can tell what it is looking at
 * @param entry         the node the drawing anchors on, or {@code null}
 * @param nodes         START, the declared nodes, END
 * @param edges         direct edges first, then conditional ones branch by branch
 * @param branches      one entry per declared fan-out, in declaration order
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record Topology(@JsonProperty("schema_version") int schemaVersion,
                       String entry,
                       List<Node> nodes,
                       List<Edge> edges,
                       List<Branch> branches) {

    /** The current shape of this record. */
    @Governs(kind = Governs.Kind.PLUMBING, unit = Governs.Unit.NONE)
    public static final int SCHEMA_VERSION = 1;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * One drawable node.
     *
     * @param id    the node name, START and END included
     * @param label what to write in the box
     */
    public record Node(String id, String label) {
    }

    /**
     * One drawable arrow.
     *
     * <p>{@code branch} is present ONLY on a conditional edge and names the
     * SOURCE NODE, never the decision function — the measured caller passes
     * lambdas, so a function's own name means nothing.</p>
     *
     * @param from   the source node id
     * @param to     the destination node id
     * @param kind   {@code "direct"} or {@code "conditional"}
     * @param branch the branch name on a conditional edge, {@code null} otherwise
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Edge(String from, String to, String kind, String branch) {
    }

    /**
     * One decision.
     *
     * @param name    the branch name, unique across the graph
     * @param source  the node it leaves from
     * @param targets where it can go; empty when the caller declared no path map
     */
    public record Branch(String name, String source, List<String> targets) {
    }

    /**
     * Draws a spec.
     *
     * <p>END is emitted exactly once, from its own virtual slot. It arrives in a
     * path map as both key and value in the measured caller, so reading the
     * nodes back out of the path maps would duplicate it.</p>
     *
     * @param spec the frozen graph
     * @return its drawing
     */
    public static Topology of(GraphSpec spec) {
        List<String> names = branchNames(spec.branches());

        List<Node> nodes = new ArrayList<>();
        nodes.add(new Node(StateGraph.START, StateGraph.START));
        spec.nodes().keySet().forEach(name -> nodes.add(new Node(name, name)));
        nodes.add(new Node(StateGraph.END, StateGraph.END));

        List<Edge> edges = new ArrayList<>();
        for (GraphSpec.Edge edge : spec.edges()) {
            edges.add(new Edge(edge.from(), edge.to(), "direct", null));
        }
        List<Branch> branches = new ArrayList<>();
        for (int index = 0; index < spec.branches().size(); index++) {
            GraphSpec.Branch branch = spec.branches().get(index);
            String name = names.get(index);
            for (String target : branch.targets()) {
                edges.add(new Edge(branch.source(), target, "conditional", name));
            }
            branches.add(new Branch(name, branch.source(), branch.targets()));
        }

        return new Topology(SCHEMA_VERSION, entryOf(spec), List.copyOf(nodes), List.copyOf(edges),
                List.copyOf(branches));
    }

    /**
     * Names each branch after its source, disambiguating repeats.
     *
     * <p>Naming after the decision function is not available: the measured caller
     * passes lambdas. A second branch out of the same node is rare but legal, and
     * the edges reference the branch by name, so the names have to be unique.</p>
     */
    private static List<String> branchNames(List<GraphSpec.Branch> branches) {
        Map<String, Integer> seen = new LinkedHashMap<>();
        List<String> names = new ArrayList<>();
        for (GraphSpec.Branch branch : branches) {
            int count = seen.merge(branch.source(), 1, Integer::sum);
            names.add(count == 1 ? branch.source() : branch.source() + "#" + count);
        }
        return names;
    }

    /** The node START points at — the first one, if a graph fans out from START. */
    private static String entryOf(GraphSpec spec) {
        for (GraphSpec.Edge edge : spec.edges()) {
            if (StateGraph.START.equals(edge.from())) {
                return edge.to();
            }
        }
        for (GraphSpec.Branch branch : spec.branches()) {
            if (StateGraph.START.equals(branch.source()) && !branch.targets().isEmpty()) {
                return branch.targets().get(0);
            }
        }
        return null;
    }

    /**
     * The drawing as one compact JSON line.
     *
     * <p>No spaces, non-ASCII raw, {@code null} fields omitted entirely — an
     * absent key means "not applicable" and is a different statement from a
     * recorded null. {@code schema_version} keeps its snake_case spelling while
     * every other key in the dialect is camelCase: that is how the python
     * edition ships it, and cross-edition byte identity outranks the local
     * convention.</p>
     *
     * @return the line, byte-identical for two compiles of the same graph
     */
    public String toJson() {
        try {
            return MAPPER.writeValueAsString(this);
        } catch (JsonProcessingException failure) {
            throw new IllegalStateException("the topology could not be serialized", failure);
        }
    }
}
