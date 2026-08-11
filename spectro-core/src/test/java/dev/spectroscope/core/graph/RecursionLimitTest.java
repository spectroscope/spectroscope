package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static dev.spectroscope.core.graph.StateGraph.END;
import static dev.spectroscope.core.graph.StateGraph.START;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The ceiling. 25 was a margin chosen against one caller's loop: an operator who
 * set RETRIEVAL__MAX_REWRITES=4 got a working system on LangGraph and a recursion
 * error here, because the corrective-RAG replica needs 27 supersteps.
 */
class RecursionLimitTest {

    private static final StateSchema SCHEMA = StateSchema.of(Channel.lastWriteWins("turns"));

    /** A cycle with no exit: the shape the ceiling exists for. */
    private static CompiledGraph endlessCycle(AtomicInteger runs) {
        return new StateGraph(SCHEMA)
                .addNode("router", state -> {
                    runs.incrementAndGet();
                    return StateUpdate.none();
                })
                .addNode("rewrite", state -> StateUpdate.none())
                .addEdge(START, "router")
                .addEdge("router", "rewrite")
                .addEdge("rewrite", "router")
                .compile();
    }

    @Test
    void theDefaultIsTenThousandAndSevenAndNotTwentyFive() {
        assertEquals(10007, CompiledGraph.DEFAULT_RECURSION_LIMIT,
                "LangGraph 1.x's own number, counted rather than read");
        assertEquals(10007, RunConfig.defaults().resolvedRecursionLimit());
    }

    @Test
    void aTwentySevenSuperstepCorrectionLoopCompletesWithNoExplicitLimit() throws Exception {
        AtomicInteger turns = new AtomicInteger();
        GraphState end = new StateGraph(SCHEMA)
                .addNode("router", state -> StateUpdate.none())
                .addNode("rewrite", state -> StateUpdate.of("turns", turns.incrementAndGet()))
                .addEdge(START, "router")
                .addConditionalEdges("router", state -> turns.get() >= 13 ? END : "rewrite",
                        List.of("rewrite", END))
                .addEdge("rewrite", "router")
                .compile().invoke(GraphState.empty());

        assertEquals(13, end.get("turns"), "27 supersteps: 14 routers and 13 rewrites");
    }

    @Test
    void aNoExitCycleRaisesAfterExactlyTheConfiguredNumberOfSupersteps() {
        AtomicInteger runs = new AtomicInteger();
        assertThrows(GraphRecursionException.class,
                () -> endlessCycle(runs).invoke(GraphState.empty(),
                        RunConfig.defaults().withRecursionLimit(3)));

        assertEquals(2, runs.get(),
                "three node-bearing supersteps: router, rewrite, router — the limit counts supersteps");
    }

    @Test
    void theMessageNamesTheCycleAndTheKnobThatWidensIt() {
        GraphRecursionException failure = assertThrows(GraphRecursionException.class,
                () -> endlessCycle(new AtomicInteger()).invoke(GraphState.empty(),
                        RunConfig.defaults().withRecursionLimit(5)));

        assertTrue(failure.getMessage().contains("router -> rewrite"), failure.getMessage());
        assertTrue(failure.getMessage().contains("recursion_limit"), failure.getMessage());
        assertTrue(failure.getMessage().contains("5"), failure.getMessage());
    }

    @Test
    void theRetainedCycleHistoryIsBoundedNoMatterHowHighTheCeilingIs() {
        // A ring of twenty nodes under a limit of two hundred: only the last
        // sixteen frontiers are kept, so the message can name at most sixteen
        // nodes. A limit of ten thousand must not quietly retain ten thousand
        // frontiers, and this is the shape where that would show.
        StateGraph ring = new StateGraph(SCHEMA);
        for (int i = 0; i < 20; i++) {
            ring.addNode("n" + i, state -> StateUpdate.none());
        }
        ring.addEdge(START, "n0");
        for (int i = 0; i < 20; i++) {
            ring.addEdge("n" + i, "n" + ((i + 1) % 20));
        }

        GraphRecursionException failure = assertThrows(GraphRecursionException.class,
                () -> ring.compile().invoke(GraphState.empty(),
                        RunConfig.defaults().withRecursionLimit(200)));

        String cycle = failure.getMessage().split("cycling through ")[1].split("\\.")[0];
        assertTrue(cycle.split(" -> ").length <= 16, cycle);
    }

    @Test
    void aLimitBelowOneIsRefusedWhereTheConfigIsBuilt() {
        // Refusing at construction is strictly earlier than refusing at the top
        // of the loop: a run started with an impossible ceiling never begins, so
        // no artifact can carry the beginning of one.
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                () -> RunConfig.defaults().withRecursionLimit(0));

        assertTrue(failure.getMessage().contains("recursion_limit must be at least 1"),
                failure.getMessage());
        assertThrows(IllegalArgumentException.class, () -> new RunConfig(-1, Map.of()));
    }

    @Test
    void aLimitOfOneStopsAfterOneSuperstep() {
        AtomicInteger runs = new AtomicInteger();
        assertThrows(GraphRecursionException.class,
                () -> endlessCycle(runs).invoke(GraphState.empty(),
                        RunConfig.defaults().withRecursionLimit(1)));
        assertEquals(1, runs.get());
    }

    @Test
    void aRunConfigCarriesTheCallerFacingConfigurableMap() {
        RunConfig config = RunConfig.defaults().withConfigurable(Map.of("thread_id", "t-1"));
        assertEquals("t-1", config.configurable().get("thread_id"));
        assertEquals(10007, config.resolvedRecursionLimit());
    }
}
