package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;

import java.util.List;

import static dev.spectroscope.core.graph.StateGraph.END;
import static dev.spectroscope.core.graph.StateGraph.START;
import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The order of the adjacency walk, pinned where it is observable.
 *
 * <p>The walk is documented as: per source, first every static edge, then every
 * branch. Nothing measured that. Swapping the two emissions left the whole suite
 * green, and the order is not cosmetic — the frontier runs in this order, so it
 * decides the fold order of a reducing channel the whole frontier writes. An
 * appending channel records that order directly. (It no longer decides which
 * concurrent last write survives — that collision refuses since D2 closed, and
 * ConcurrentLastWriteTest pins the refusal.)</p>
 */
class FrontierOrderTest {

    private static final StateSchema SCHEMA = StateSchema.of(Channel.appending("trace"));

    private static Node writing(String mark) {
        return state -> StateUpdate.of("trace", List.of(mark));
    }

    @Test
    void aSourcesStaticEdgesComeBeforeItsConditionalTargets() throws Exception {
        GraphState end = new StateGraph(SCHEMA)
                .addNode("split", state -> StateUpdate.none())
                .addNode("viaEdge", writing("edge"))
                .addNode("viaBranch", writing("branch"))
                .addEdge(START, "split")
                .addEdge("split", "viaEdge")
                .addConditionalEdges("split", state -> "viaBranch", List.of("viaBranch"))
                .addEdge("viaEdge", END)
                .addEdge("viaBranch", END)
                .compile().invoke(GraphState.empty());

        assertEquals(List.of("edge", "branch"), end.get("trace"),
                "the static edge out of a source is walked before that source's branches — "
                        + "the fold order of the appending channel is the observable");
    }

    @Test
    void theWalkGroupsBySourceRatherThanByEdgeKind() throws Exception {
        GraphState end = new StateGraph(SCHEMA)
                .addNode("a", state -> StateUpdate.none())
                .addNode("b", state -> StateUpdate.none())
                .addNode("aDirect", writing("a-direct"))
                .addNode("aBranch", writing("a-branch"))
                .addNode("bDirect", writing("b-direct"))
                .addNode("bBranch", writing("b-branch"))
                .addEdge(START, "a")
                .addEdge(START, "b")
                .addEdge("a", "aDirect")
                .addConditionalEdges("a", state -> "aBranch", List.of("aBranch"))
                .addEdge("b", "bDirect")
                .addConditionalEdges("b", state -> "bBranch", List.of("bBranch"))
                .addEdge("aDirect", END).addEdge("aBranch", END)
                .addEdge("bDirect", END).addEdge("bBranch", END)
                .compile().invoke(GraphState.empty());

        assertEquals(List.of("a-direct", "a-branch", "b-direct", "b-branch"), end.get("trace"),
                "one source is walked out completely before the next, so a per-kind sweep "
                        + "(every edge, then every branch) is a different frontier");
    }
}
