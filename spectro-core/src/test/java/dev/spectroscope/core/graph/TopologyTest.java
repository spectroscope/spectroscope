package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static dev.spectroscope.core.graph.StateGraph.END;
import static dev.spectroscope.core.graph.StateGraph.START;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertIterableEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The drawing, and the bytes it turns into. Artifacts get compared across runs,
 * so a topology that reshuffles itself would make every comparison noise: order
 * comes from declaration order throughout and no unordered collection is ever
 * iterated into the output.
 */
class TopologyTest {

    private static final Node NOOP = state -> StateUpdate.none();

    /** The corrective-RAG shape: a router, a fan-out, and a loop back into it. */
    private static StateGraph crag() {
        return new StateGraph(StateSchema.of(Channel.appending("trace")))
                .addNode("router", NOOP)
                .addNode("retrieve", NOOP)
                .addNode("grade", NOOP)
                .addNode("rewrite", NOOP)
                .addNode("generate", NOOP)
                .addEdge(START, "router")
                .addEdge("router", "retrieve")
                .addEdge("retrieve", "grade")
                .addConditionalEdges("grade", state -> "generate",
                        orderedMap("useful", "generate", "retry", "rewrite"))
                .addEdge("rewrite", "router")
                .addConditionalEdges("generate", state -> END, orderedMap("stop", END))
                .addEdge("generate", END);
    }

    /**
     * A path map whose iteration order is the caller's own. {@code Map.of} is
     * randomly ordered per JVM start, which would make the arrow order — and so
     * the bytes — differ between two runs of the same graph.
     */
    private static Map<String, String> orderedMap(String... pairs) {
        LinkedHashMap<String, String> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put(pairs[i], pairs[i + 1]);
        }
        return map;
    }

    @Test
    void startAndEndAreOrdinaryNodesAtTheTwoEnds() {
        List<Topology.Node> nodes = crag().compile().topology().nodes();

        assertEquals(START, nodes.get(0).id(), "a renderer that special-cases a sentinel gets one wrong");
        assertEquals(END, nodes.get(nodes.size() - 1).id());
        assertIterableEquals(
                List.of(START, "router", "retrieve", "grade", "rewrite", "generate", END),
                nodes.stream().map(Topology.Node::id).toList());
    }

    @Test
    void endIsEmittedExactlyOnceEvenWhenAPathMapCarriesItAsKeyAndValue() {
        StateGraph graph = new StateGraph(StateSchema.of()).addNode("a", NOOP)
                .addEdge(START, "a")
                .addConditionalEdges("a", state -> END, orderedMap(END, END));

        long ends = graph.compile().topology().nodes().stream()
                .filter(node -> END.equals(node.id())).count();
        assertEquals(1, ends, "reading nodes out of the path maps would duplicate END");
    }

    @Test
    void theSameGraphYieldsTheSameBytes() {
        assertEquals(crag().compile().topology().toJson(), crag().compile().topology().toJson());
    }

    @Test
    void theEnvelopeKeepsTheSnakeCaseSchemaVersionTheOtherEditionWrites() {
        String json = crag().compile().topology().toJson();
        assertTrue(json.startsWith("{\"schema_version\":1,"), json);
        assertFalse(json.contains("schemaVersion"),
                "cross-edition byte identity outranks the local naming convention");
    }

    @Test
    void aDirectEdgeCarriesNoBranchKeyAtAll() {
        String json = new StateGraph(StateSchema.of()).addNode("a", NOOP)
                .addEdge(START, "a").addEdge("a", END).compile().topology().toJson();

        assertTrue(json.contains("{\"from\":\"__start__\",\"to\":\"a\",\"kind\":\"direct\"}"), json);
        assertFalse(json.contains("\"branch\""), json);
    }

    @Test
    void directEdgesComeFirstInDeclarationOrderThenTheConditionalOnesBranchByBranch() {
        List<Topology.Edge> edges = crag().compile().topology().edges();

        assertIterableEquals(
                List.of("__start__->router", "router->retrieve", "retrieve->grade",
                        "rewrite->router", "generate->__end__",
                        "grade->generate", "grade->rewrite", "generate->__end__"),
                edges.stream().map(edge -> edge.from() + "->" + edge.to()).toList());
        assertEquals("direct", edges.get(0).kind());
        assertEquals("conditional", edges.get(5).kind());
        assertEquals("grade", edges.get(5).branch());
    }

    @Test
    void aBranchIsNamedAfterItsSourceAndARepeatGetsASuffix() {
        Topology topology = new StateGraph(StateSchema.of())
                .addNode("router", NOOP).addNode("a", NOOP).addNode("b", NOOP)
                .addEdge(START, "router")
                .addConditionalEdges("router", state -> "a", Map.of("x", "a"))
                .addConditionalEdges("router", state -> "b", Map.of("y", "b"))
                .addEdge("a", END).addEdge("b", END)
                .compile().topology();

        assertIterableEquals(List.of("router", "router#2"),
                topology.branches().stream().map(Topology.Branch::name).toList());
        assertEquals("router#2", topology.edges().stream()
                .filter(edge -> "b".equals(edge.to()) && "conditional".equals(edge.kind()))
                .findFirst().orElseThrow().branch());
    }

    @Test
    void entryIsTheTargetOfTheFirstEdgeOutOfStart() {
        assertEquals("router", crag().compile().topology().entry());
    }

    @Test
    void entryFallsBackToTheFirstTargetOfTheFirstBranchOutOfStart() {
        Topology topology = new StateGraph(StateSchema.of())
                .addNode("a", NOOP).addNode("b", NOOP)
                .addConditionalEdges(START, state -> "a", List.of("a", "b"))
                .addEdge("a", END).addEdge("b", END)
                .compile().topology();
        assertEquals("a", topology.entry());
    }

    @Test
    void anEntrylessSpecCarriesANullEntryAndOmitsTheKeyFromTheBytes() {
        // Reachable only through a hand-made spec: the builder refuses to compile
        // a graph with no way in, which is the point of the deferred refusal.
        LinkedHashMap<String, ConfigAwareNode> nodes = new LinkedHashMap<>();
        nodes.put("a", (state, config) -> StateUpdate.none());
        Topology topology = Topology.of(new GraphSpec(StateSchema.of(), nodes, List.of(), List.of()));

        assertNull(topology.entry());
        assertFalse(topology.toJson().contains("\"entry\""),
                "an absent key means 'not applicable'; a null would be a value");
    }

    @Test
    void aBranchRecordCarriesItsSourceAndItsTargets() {
        Topology.Branch branch = crag().compile().topology().branches().get(0);
        assertEquals("grade", branch.source());
        assertEquals(2, branch.targets().size());
    }

    @Test
    void theCragReplicaDrawsItselfTheseExactBytes() {
        // The whole line, pinned. Every rule above is a property; this is the
        // artifact those properties add up to, and it is what a cross-edition
        // comparison against the python topology is run against.
        assertEquals("{\"schema_version\":1,\"entry\":\"router\","
                        + "\"nodes\":["
                        + "{\"id\":\"__start__\",\"label\":\"__start__\"},"
                        + "{\"id\":\"router\",\"label\":\"router\"},"
                        + "{\"id\":\"retrieve\",\"label\":\"retrieve\"},"
                        + "{\"id\":\"grade\",\"label\":\"grade\"},"
                        + "{\"id\":\"rewrite\",\"label\":\"rewrite\"},"
                        + "{\"id\":\"generate\",\"label\":\"generate\"},"
                        + "{\"id\":\"__end__\",\"label\":\"__end__\"}],"
                        + "\"edges\":["
                        + "{\"from\":\"__start__\",\"to\":\"router\",\"kind\":\"direct\"},"
                        + "{\"from\":\"router\",\"to\":\"retrieve\",\"kind\":\"direct\"},"
                        + "{\"from\":\"retrieve\",\"to\":\"grade\",\"kind\":\"direct\"},"
                        + "{\"from\":\"rewrite\",\"to\":\"router\",\"kind\":\"direct\"},"
                        + "{\"from\":\"generate\",\"to\":\"__end__\",\"kind\":\"direct\"},"
                        + "{\"from\":\"grade\",\"to\":\"generate\",\"kind\":\"conditional\",\"branch\":\"grade\"},"
                        + "{\"from\":\"grade\",\"to\":\"rewrite\",\"kind\":\"conditional\",\"branch\":\"grade\"},"
                        + "{\"from\":\"generate\",\"to\":\"__end__\",\"kind\":\"conditional\",\"branch\":\"generate\"}],"
                        + "\"branches\":["
                        + "{\"name\":\"grade\",\"source\":\"grade\",\"targets\":[\"generate\",\"rewrite\"]},"
                        + "{\"name\":\"generate\",\"source\":\"generate\",\"targets\":[\"__end__\"]}]}",
                crag().compile().topology().toJson());
    }

    @Test
    void theSchemaVersionIsPinnedAtOne() {
        assertEquals(1, Topology.SCHEMA_VERSION);
        assertEquals(1, crag().compile().topology().schemaVersion());
    }
}
