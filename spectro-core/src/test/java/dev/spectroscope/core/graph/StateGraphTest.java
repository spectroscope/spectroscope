package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static dev.spectroscope.core.graph.StateGraph.END;
import static dev.spectroscope.core.graph.StateGraph.START;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertIterableEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The fifteen refusals: four eager at {@code addNode}, two at {@code addEdge},
 * two at {@code addConditionalEdges}, and five deferred to {@code compile()}.
 * Each message has to name the offender — a graph that cannot be drawn is
 * reported where the mistake was made, never as a hole in the drawing.
 */
class StateGraphTest {

    private static final Node NOOP = state -> StateUpdate.none();

    private static StateGraph builder() {
        return new StateGraph(StateSchema.of());
    }

    // -- the four eager refusals at addNode --------------------------------- //

    @Test
    void addNodeRefusesANameThatIsNotANonEmptyString() {
        assertThrows(GraphValidationException.class, () -> builder().addNode("", NOOP));
        assertThrows(GraphValidationException.class, () -> builder().addNode(null, NOOP));
    }

    @Test
    void addNodeRefusesTheTwoReservedNames() {
        assertTrue(assertThrows(GraphValidationException.class, () -> builder().addNode(START, NOOP))
                .getMessage().contains("__start__"));
        assertTrue(assertThrows(GraphValidationException.class, () -> builder().addNode(END, NOOP))
                .getMessage().contains("__end__"));
    }

    @Test
    void addNodeRefusesADuplicateName() {
        StateGraph graph = builder().addNode("a", NOOP);
        assertTrue(assertThrows(GraphValidationException.class, () -> graph.addNode("a", NOOP))
                .getMessage().contains("already defined"));
    }

    @Test
    void addNodeRefusesAnAbsentAction() {
        assertThrows(GraphValidationException.class, () -> builder().addNode("a", (Node) null));
        assertThrows(GraphValidationException.class, () -> builder().addNode("a", (ConfigAwareNode) null));
    }

    // -- the two eager refusals at addEdge ---------------------------------- //

    @Test
    void nothingLeavesEndAndNothingEntersStart() {
        assertTrue(assertThrows(GraphValidationException.class, () -> builder().addEdge(END, "a"))
                .getMessage().contains("nothing leaves END"));
        assertTrue(assertThrows(GraphValidationException.class, () -> builder().addEdge("a", START))
                .getMessage().contains("nothing enters START"));
    }

    @Test
    void anEdgeMayBeDeclaredBeforeTheNodeItPointsAt() {
        StateGraph graph = builder().addEdge("a", "b").addNode("a", NOOP).addNode("b", NOOP);
        graph.addEdge(START, "a").addEdge("b", END);
        assertEquals(3, graph.toSpec().edges().size());
    }

    @Test
    void anIdenticalEdgeDeclaredTwiceIsRecordedOnce() {
        GraphSpec spec = builder().addNode("a", NOOP).addEdge(START, "a")
                .addEdge("a", END).addEdge("a", END).toSpec();
        assertEquals(2, spec.edges().size(), "a duplicate would draw a second arrow");
    }

    // -- the two eager refusals at addConditionalEdges ---------------------- //

    @Test
    void addConditionalEdgesRefusesAnAbsentPathAndEndAsASource() {
        assertThrows(GraphValidationException.class,
                () -> builder().addConditionalEdges("a", (FanOutPath) null, Map.of()));
        assertTrue(assertThrows(GraphValidationException.class,
                () -> builder().addConditionalEdges(END, state -> END, Map.of()))
                .getMessage().contains("nothing leaves END"));
    }

    @Test
    void aListPathMapIsNormalisedToTheIdentityMappingAtDeclarationTime() {
        GraphSpec spec = builder().addNode("a", NOOP).addNode("b", NOOP).addNode("c", NOOP)
                .addEdge(START, "a")
                .addConditionalEdges("a", state -> "b", List.of("b", "c"))
                .addEdge("b", END).addEdge("c", END)
                .toSpec();

        GraphSpec.Branch branch = spec.branches().get(0);
        assertEquals(Map.of("b", "b", "c", "c"), branch.pathMap());
        assertIterableEquals(List.of("b", "c"), branch.targets());
    }

    @Test
    void aDictPathMapDeduplicatesItsTargetsAndKeepsDeclarationOrder() {
        GraphSpec spec = builder().addNode("a", NOOP).addNode("b", NOOP)
                .addEdge(START, "a")
                .addConditionalEdges("a", state -> "yes", Map.of("yes", "b", "no", "b"))
                .addEdge("b", END)
                .toSpec();
        assertIterableEquals(List.of("b"), spec.branches().get(0).targets(),
                "two return values routing to one node draw one arrow");
    }

    @Test
    void aListPathMapRefusesANullEntry() {
        assertTrue(assertThrows(GraphValidationException.class,
                () -> builder().addConditionalEdges("a", state -> "b", java.util.Arrays.asList("b", null)))
                .getMessage().contains("node names"));
    }

    @Test
    void anUnmappedBranchHasNoKnowableTargets() {
        GraphSpec spec = builder().addNode("a", NOOP).addNode("b", NOOP)
                .addEdge(START, "a")
                .addConditionalEdges("a", state -> "b")
                .toSpec();
        assertEquals(null, spec.branches().get(0).pathMap());
        assertTrue(spec.branches().get(0).targets().isEmpty());
    }

    // -- the five deferred refusals, in order ------------------------------- //

    @Test
    void compileRefusesAnEdgeEndpointThatIsNotANode() {
        StateGraph graph = builder().addNode("a", NOOP).addEdge(START, "a").addEdge("a", "ghost");
        assertTrue(assertThrows(GraphValidationException.class, graph::toSpec)
                .getMessage().contains("ghost"));
    }

    @Test
    void compileRefusesABranchSourceThatIsNotANode() {
        StateGraph graph = builder().addNode("a", NOOP).addEdge(START, "a")
                .addConditionalEdges("ghost", state -> END, Map.of("x", END));
        assertTrue(assertThrows(GraphValidationException.class, graph::toSpec)
                .getMessage().contains("ghost"));
    }

    @Test
    void compileRefusesAPathMapTargetThatIsNotANode() {
        StateGraph graph = builder().addNode("a", NOOP).addEdge(START, "a")
                .addConditionalEdges("a", state -> "x", Map.of("x", "ghost"));
        assertTrue(assertThrows(GraphValidationException.class, graph::toSpec)
                .getMessage().contains("ghost"));
    }

    @Test
    void compileRefusesAGraphWithNoEntry() {
        StateGraph graph = builder().addNode("a", NOOP).addEdge("a", END);
        assertTrue(assertThrows(GraphValidationException.class, graph::toSpec)
                .getMessage().contains("no entry"));
    }

    @Test
    void compileRefusesANodeNoPathCanReach() {
        StateGraph graph = builder().addNode("a", NOOP).addNode("orphan", NOOP)
                .addEdge(START, "a").addEdge("a", END);
        assertTrue(assertThrows(GraphValidationException.class, graph::toSpec)
                .getMessage().contains("orphan"));
    }

    @Test
    void theRefusalsFireInTheDocumentedOrder() {
        // Every deferred fault at once: the edge endpoint is named first, because
        // an unknown endpoint makes every later answer a guess.
        StateGraph graph = builder().addNode("a", NOOP).addNode("orphan", NOOP)
                .addEdge("a", "ghost");
        assertTrue(assertThrows(GraphValidationException.class, graph::toSpec)
                .getMessage().contains("ghost"));
    }

    @Test
    void reachabilityTreatsAnUnmappedBranchAsReachingEveryNode() {
        GraphSpec spec = builder().addNode("router", NOOP).addNode("only_reachable_by_guess", NOOP)
                .addEdge(START, "router")
                .addConditionalEdges("router", state -> "only_reachable_by_guess")
                .toSpec();
        assertEquals(2, spec.nodes().size(),
                "calling a node unreachable on the strength of a guess would refuse a legal graph");
    }

    // -- the shape of the builder itself ------------------------------------ //

    @Test
    void everyBuilderMethodReturnsTheBuilder() {
        StateGraph graph = builder();
        assertSame(graph, graph.addNode("a", NOOP));
        assertSame(graph, graph.addEdge(START, "a"));
        assertSame(graph, graph.addConditionalEdges("a", state -> END, Map.of("x", END)));
        assertSame(graph, graph.setEntryPoint("a"));
    }

    @Test
    void setEntryPointIsExactlyAnEdgeFromStart() {
        GraphSpec spec = builder().addNode("a", NOOP).setEntryPoint("a").addEdge("a", END).toSpec();
        assertEquals(new GraphSpec.Edge(START, "a"), spec.edges().get(0));
    }

    @Test
    void toSpecIsAnIndependentSnapshot() {
        StateGraph graph = builder().addNode("a", NOOP).addEdge(START, "a").addEdge("a", END);
        GraphSpec spec = graph.toSpec();
        graph.addNode("b", NOOP);

        assertEquals(1, spec.nodes().size(),
                "later builder mutation must not change an already-compiled graph");
    }

    @Test
    void aSpecRefusesToBeEditedThroughItsOwnCollections() {
        GraphSpec spec = builder().addNode("a", NOOP).addEdge(START, "a").addEdge("a", END).toSpec();
        assertThrows(UnsupportedOperationException.class, () -> spec.edges().clear());
        assertThrows(UnsupportedOperationException.class, () -> spec.nodes().clear());
    }
}
