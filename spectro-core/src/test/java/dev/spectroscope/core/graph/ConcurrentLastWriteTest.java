package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static dev.spectroscope.core.graph.StateGraph.END;
import static dev.spectroscope.core.graph.StateGraph.START;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Divergence D2, closed: two siblings writing one last-write-wins channel in
 * the same superstep REFUSE, the way LangGraph refuses — instead of resolving
 * silently in frontier order. A silent last write was deterministic, but it was
 * an answer the caller never chose; the register's own row named the refusal as
 * the intended fix.
 *
 * <p>The refusal names the channel, both writers and the superstep, and says
 * what to declare when concurrent writes are MEANT to combine — because the
 * error is routinely met by someone who just added a second branch to a working
 * graph.</p>
 */
class ConcurrentLastWriteTest {

    /** START fans out to a and b; both write the channels their updates carry. */
    private static CompiledGraph fanOut(StateSchema schema, StateUpdate fromA, StateUpdate fromB) {
        return new StateGraph(schema)
                .addNode("a", state -> fromA)
                .addNode("b", state -> fromB)
                .addEdge(START, "a")
                .addEdge(START, "b")
                .addEdge("a", END)
                .addEdge("b", END)
                .compile();
    }

    @Test
    void twoSiblingsWritingOneLastWriteWinsChannelRefuse() {
        CompiledGraph graph = fanOut(StateSchema.of(Channel.lastWriteWins("answer")),
                StateUpdate.of("answer", "from a"),
                StateUpdate.of("answer", "from b"));

        InvalidUpdateException refusal = assertThrows(InvalidUpdateException.class,
                () -> graph.invoke(GraphState.empty()));

        String message = refusal.getMessage();
        assertTrue(message.contains("'answer'"), message);
        assertTrue(message.contains("'a'") && message.contains("'b'"),
                "the two writers are known here and LangGraph cannot name them — "
                        + "a port that can say more, should: " + message);
        assertTrue(message.contains("one value per superstep"), message);
        assertTrue(message.contains("Channel.reducing"),
                "the error is met by someone who just added a second branch; it must "
                        + "say what to declare when combining is meant: " + message);
    }

    @Test
    void anUndeclaredChannelRefusesTheSameWay() {
        // Undeclared channels merge without a gate — for ONE writer. Two writers
        // colliding is a graph bug in every reading, and it does not become
        // acceptable because nobody declared the channel: the silent loss is the
        // same. The single-writer stash stays as free as it ever was.
        CompiledGraph graph = fanOut(StateSchema.of(),
                StateUpdate.of("diagnostic", "from a"),
                StateUpdate.of("diagnostic", "from b"));

        assertThrows(InvalidUpdateException.class, () -> graph.invoke(GraphState.empty()));
    }

    @Test
    void twoSiblingsOnAReducingChannelStillFold() throws Exception {
        CompiledGraph graph = fanOut(StateSchema.of(Channel.appending("trace")),
                StateUpdate.of("trace", List.of("a")),
                StateUpdate.of("trace", List.of("b")));

        assertEquals(List.of("a", "b"), graph.invoke(GraphState.empty()).get("trace"),
                "a reducing channel is exactly the declared way to combine concurrent writes");
    }

    @Test
    void theSameChannelAcrossTwoSuperstepsIsNoCollision() throws Exception {
        CompiledGraph graph = new StateGraph(StateSchema.of(Channel.lastWriteWins("answer")))
                .addNode("first", state -> StateUpdate.of("answer", "early"))
                .addNode("second", state -> StateUpdate.of("answer", "late"))
                .addEdge(START, "first")
                .addEdge("first", "second")
                .addEdge("second", END)
                .compile();

        assertEquals("late", graph.invoke(GraphState.empty()).get("answer"),
                "sequential writes are the ordinary life of a last-write-wins channel");
    }

    @Test
    void aSingleWriterPerSuperstepNeverRefuses() throws Exception {
        CompiledGraph graph = fanOut(StateSchema.of(Channel.lastWriteWins("answer")),
                StateUpdate.of("answer", "only a"),
                StateUpdate.of("other", "b keeps to itself"));

        GraphState end = graph.invoke(GraphState.empty());
        assertEquals("only a", end.get("answer"));
        assertEquals("b keeps to itself", end.get("other"));
    }

    @Test
    void theRefusalStillLeavesAGraphEndBehind() {
        List<Map<String, Object>> records = new ArrayList<>();
        CompiledGraph graph = new StateGraph(StateSchema.of(Channel.lastWriteWins("answer")))
                .addNode("a", state -> StateUpdate.of("answer", "from a"))
                .addNode("b", state -> StateUpdate.of("answer", "from b"))
                .addEdge(START, "a")
                .addEdge(START, "b")
                .addEdge("a", END)
                .addEdge("b", END)
                .compile(records::add);

        assertThrows(InvalidUpdateException.class, () -> graph.invoke(GraphState.empty()));

        assertEquals(1, records.stream()
                        .filter(record -> "graph_end".equals(record.get("type"))).count(),
                "an artifact whose last run has no ending is indistinguishable from a "
                        + "viewer that lost the tail");
    }
}
