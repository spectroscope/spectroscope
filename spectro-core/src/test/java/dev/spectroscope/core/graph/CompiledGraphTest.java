package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static dev.spectroscope.core.graph.StateGraph.END;
import static dev.spectroscope.core.graph.StateGraph.START;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertIterableEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The superstep loop. One superstep runs the whole frontier, collects every
 * update, and applies them only after every node returned — if updates were
 * applied as they arrived, a node could read a sibling's write from its own
 * superstep and the run would stop being reproducible.
 */
class CompiledGraphTest {

    private static final StateSchema SCHEMA = StateSchema.of(
            Channel.appending("trace"),
            Channel.lastWriteWins("answer"));

    /** Both halves of a fan-out under one entry, so a frontier really has two nodes. */
    private static StateGraph fanOut(Node left, Node right) {
        return new StateGraph(SCHEMA)
                .addNode("split", state -> StateUpdate.none())
                .addNode("left", left)
                .addNode("right", right)
                .addEdge(START, "split")
                .addEdge("split", "left")
                .addEdge("split", "right")
                .addEdge("left", END)
                .addEdge("right", END);
    }

    @Test
    void aNodeNeverSeesASiblingsWriteFromItsOwnSuperstep() throws Exception {
        List<Object> seen = new ArrayList<>();
        GraphState end = fanOut(
                state -> StateUpdate.of("answer", "from left"),
                state -> {
                    seen.add(state.get("answer"));
                    return StateUpdate.none();
                }).compile().invoke(GraphState.empty());

        assertIterableEquals(java.util.Collections.singletonList(null), seen,
                "the right node ran in the same superstep and must see the pre-superstep state");
        assertEquals("from left", end.get("answer"));
    }

    @Test
    void bothWritesToAReducerChannelSurviveOneSuperstep() throws Exception {
        GraphState end = fanOut(
                state -> StateUpdate.of("trace", List.of("left")),
                state -> StateUpdate.of("trace", List.of("right"))).compile().invoke(GraphState.empty());

        assertEquals(List.of("left", "right"), end.get("trace"));
    }

    @Test
    void twoNodesWritingOnePlainChannelRefuseInsteadOfResolvingSilently() {
        // The premise this test once carried — "the resolution is reproducible" —
        // was divergence D2, and it is closed: reproducible was not the same as
        // chosen. ConcurrentLastWriteTest pins the refusal's whole contract.
        assertThrows(InvalidUpdateException.class, () -> fanOut(
                state -> StateUpdate.of("answer", "left"),
                state -> StateUpdate.of("answer", "right")).compile().invoke(GraphState.empty()));
    }

    @Test
    void theStateHandedToANodeCannotBeMutatedIntoASiblingsWrongAnswer() {
        Exception failure = assertThrows(Exception.class, () -> fanOut(
                state -> {
                    state.values().put("answer", "smuggled");
                    return StateUpdate.none();
                },
                state -> StateUpdate.none()).compile().invoke(GraphState.empty()));

        assertTrue(failure instanceof UnsupportedOperationException, failure.toString());
    }

    @Test
    void aFanOutReachingTheSameNodeByTwoRoutesRunsItOnce() throws Exception {
        AtomicInteger joins = new AtomicInteger();
        new StateGraph(SCHEMA)
                .addNode("split", state -> StateUpdate.none())
                .addNode("left", state -> StateUpdate.none())
                .addNode("right", state -> StateUpdate.none())
                .addNode("join", state -> {
                    joins.incrementAndGet();
                    return StateUpdate.none();
                })
                .addEdge(START, "split")
                .addEdge("split", "left").addEdge("split", "right")
                .addEdge("left", "join").addEdge("right", "join")
                .addEdge("join", END)
                .compile().invoke(GraphState.empty());

        assertEquals(1, joins.get(), "duplicates collapse keeping the first occurrence");
    }

    @Test
    void aConditionalPathSeesTheStateAsItStandsAfterTheWholeFrontierMerged() throws Exception {
        List<Object> decidedOn = new ArrayList<>();
        new StateGraph(SCHEMA)
                .addNode("split", state -> StateUpdate.none())
                .addNode("left", state -> StateUpdate.of("trace", List.of("left")))
                .addNode("right", state -> StateUpdate.of("trace", List.of("right")))
                .addEdge(START, "split")
                .addEdge("split", "left").addEdge("split", "right")
                .addConditionalEdges("left", state -> {
                    decidedOn.add(state.get("trace"));
                    return END;
                }, List.of(END))
                .addEdge("right", END)
                .compile().invoke(GraphState.empty());

        assertEquals(List.of(List.of("left", "right")), decidedOn,
                "deciding on the pre-merge state routes on the answer to the previous question");
    }

    @Test
    void theRunStartsFromTheInputFoldedThroughTheReducers() throws Exception {
        GraphState end = new StateGraph(SCHEMA)
                .addNode("a", state -> StateUpdate.of("trace", List.of("a")))
                .addEdge(START, "a").addEdge("a", END)
                .compile()
                .invoke(GraphState.of(Map.of("trace", List.of("seed"))));

        assertEquals(List.of("seed", "a"), end.get("trace"));
    }

    @Test
    void startMayCarryConditionalBranches() throws Exception {
        GraphState end = new StateGraph(SCHEMA)
                .addNode("a", state -> StateUpdate.of("answer", "a"))
                .addNode("b", state -> StateUpdate.of("answer", "b"))
                .addConditionalEdges(START, state -> "b", List.of("a", "b"))
                .addEdge("a", END).addEdge("b", END)
                .compile().invoke(GraphState.empty());

        assertEquals("b", end.get("answer"), "the engine has exactly one routing implementation");
    }

    @Test
    void aPathMayFanOutByReturningAList() throws Exception {
        GraphState end = new StateGraph(SCHEMA)
                .addNode("router", state -> StateUpdate.none())
                .addNode("a", state -> StateUpdate.of("trace", List.of("a")))
                .addNode("b", state -> StateUpdate.of("trace", List.of("b")))
                .addEdge(START, "router")
                .addConditionalEdges("router", state -> List.of("a", "b"), List.of("a", "b"))
                .addEdge("a", END).addEdge("b", END)
                .compile().invoke(GraphState.empty());

        assertEquals(List.of("a", "b"), end.get("trace"));
    }

    @Test
    void aPathValueThatNamesANodeIsHonouredEvenWhenTheMapDoesNotMentionIt() throws Exception {
        GraphState end = new StateGraph(SCHEMA)
                .addNode("router", state -> StateUpdate.none())
                .addNode("a", state -> StateUpdate.of("answer", "a"))
                .addEdge(START, "router")
                .addConditionalEdges("router", state -> "a", Map.of("mapped", "a"))
                .addEdge("a", END)
                .compile().invoke(GraphState.empty());

        assertEquals("a", end.get("answer"));
    }

    @Test
    void returningEndFromAPathTerminatesThatBranch() throws Exception {
        GraphState end = new StateGraph(SCHEMA)
                .addNode("router", state -> StateUpdate.of("answer", "done"))
                .addEdge(START, "router")
                .addConditionalEdges("router", state -> "stop", Map.of("stop", END))
                .compile().invoke(GraphState.empty());

        assertEquals("done", end.get("answer"));
    }

    @Test
    void aPathValueThatNamesNothingRaisesAndTheMessageNamesTheSourceNode() {
        Exception failure = assertThrows(Exception.class, () -> new StateGraph(SCHEMA)
                .addNode("router", state -> StateUpdate.none())
                .addNode("a", state -> StateUpdate.none())
                .addEdge(START, "router")
                .addConditionalEdges("router", state -> "garbage", Map.of("mapped", "a"))
                .addEdge("a", END)
                .compile().invoke(GraphState.empty()));

        assertTrue(failure.getMessage().contains("router"),
                "path functions are routinely lambdas, so their own name says nothing: " + failure.getMessage());
        assertTrue(failure.getMessage().contains("garbage"), failure.getMessage());
    }

    @Test
    void aConfigAwareNodeReceivesTheRunConfigTheRunWasStartedWith() throws Exception {
        List<Object> seen = new ArrayList<>();
        RunConfig config = RunConfig.defaults().withConfigurable(Map.of("thread_id", "t-7"));

        new StateGraph(SCHEMA)
                .addNode("plain", state -> StateUpdate.none())
                .addNode("aware", (state, runConfig) -> {
                    seen.add(runConfig.configurable().get("thread_id"));
                    return StateUpdate.none();
                })
                .addEdge(START, "plain").addEdge("plain", "aware").addEdge("aware", END)
                .compile().invoke(GraphState.empty(), config);

        assertEquals(List.of("t-7"), seen);
    }

    @Test
    void aNodesOwnFailureReachesTheCallerUnchangedAndTheNodeRanExactlyOnce() {
        AtomicInteger calls = new AtomicInteger();
        IllegalStateException boom = assertThrows(IllegalStateException.class, () -> new StateGraph(SCHEMA)
                .addNode("a", state -> {
                    calls.incrementAndGet();
                    throw new IllegalStateException("boom");
                })
                .addEdge(START, "a").addEdge("a", END)
                .compile().invoke(GraphState.empty()));

        assertEquals("boom", boom.getMessage(), "a wrapped failure breaks the caller's own catch");
        assertEquals(1, calls.get(),
                "never decide a node's shape by calling it and catching an arity error");
    }

    @Test
    void aNodeMayReturnNullMeaningNothingChanged() throws Exception {
        GraphState end = new StateGraph(SCHEMA)
                .addNode("a", state -> null)
                .addEdge(START, "a").addEdge("a", END)
                .compile().invoke(GraphState.of(Map.of("answer", "kept")));

        assertEquals("kept", end.get("answer"));
    }

    @Test
    void theRunEndsWhenTheFrontierIsEmpty() throws Exception {
        GraphState end = new StateGraph(SCHEMA)
                .addNode("a", state -> StateUpdate.of("answer", "a"))
                .addEdge(START, "a")
                .compile().invoke(GraphState.empty());

        assertEquals("a", end.get("answer"), "a node with no outgoing edge simply ends the run");
    }

    @Test
    void aChainRunsOneNodePerSuperstepInDeclarationOrder() throws Exception {
        GraphState end = new StateGraph(SCHEMA)
                .addNode("one", state -> StateUpdate.of("trace", List.of("one")))
                .addNode("two", state -> StateUpdate.of("trace", List.of("two")))
                .addNode("three", state -> StateUpdate.of("trace", List.of("three")))
                .addEdge(START, "one").addEdge("one", "two").addEdge("two", "three")
                .addEdge("three", END)
                .compile().invoke(GraphState.empty());

        assertEquals(List.of("one", "two", "three"), end.get("trace"));
    }

    @Test
    void invokeAcceptsAPlainMapAndFoldsItThroughTheReducers() throws Exception {
        LinkedHashMap<String, Object> input = new LinkedHashMap<>();
        input.put("trace", List.of("seed"));

        GraphState end = new StateGraph(SCHEMA)
                .addNode("a", state -> StateUpdate.none())
                .addEdge(START, "a").addEdge("a", END)
                .compile().invoke(input);

        assertEquals(List.of("seed"), end.get("trace"));
    }

    @Test
    void anUndeclaredChannelWrittenByANodeSurvivesTheRun() throws Exception {
        GraphState end = new StateGraph(SCHEMA)
                .addNode("a", state -> StateUpdate.of("diagnostic", "kept"))
                .addEdge(START, "a").addEdge("a", END)
                .compile().invoke(GraphState.empty());

        assertEquals("kept", end.get("diagnostic"));
        assertNull(end.get("nothing_wrote_this"));
    }
}
