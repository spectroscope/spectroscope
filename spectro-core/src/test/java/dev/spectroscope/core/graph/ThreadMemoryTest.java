package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static dev.spectroscope.core.graph.StateGraph.END;
import static dev.spectroscope.core.graph.StateGraph.START;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The checkpointer seam of the runtime: what {@code compile(checkpointer)}
 * buys, ported from the python edition's {@code _load}/{@code _persist} and the
 * harvested spec — a second run on the same thread continues from the persisted
 * state THROUGH the reducers (rule 432), a thread-less run goes unrecorded
 * rather than failing (rule 440), and {@code graph_start} carries a
 * {@code threadId} only when a checkpointer is configured (rule 103).
 */
class ThreadMemoryTest {

    private static RunConfig thread(String threadId) {
        return RunConfig.defaults().withConfigurable(Map.of("thread_id", threadId));
    }

    /** START -> a -> b -> END over one appending channel. */
    private static StateGraph linear() {
        return new StateGraph(StateSchema.of(Channel.appending("trace")))
                .addNode("a", state -> StateUpdate.of("trace", List.of("a")))
                .addNode("b", state -> StateUpdate.of("trace", List.of("b")))
                .addEdge(START, "a")
                .addEdge("a", "b")
                .addEdge("b", END);
    }

    /** A single node that writes nothing — the state is whatever was loaded. */
    private static StateGraph echo() {
        return new StateGraph(StateSchema.of(Channel.lastWriteWins("answer")))
                .addNode("echo", state -> StateUpdate.none())
                .addEdge(START, "echo")
                .addEdge("echo", END);
    }

    // -- the multi-turn contract --------------------------------------------- //

    @Test
    void aSecondRunOnTheSameThreadContinuesFromThePersistedState() throws Exception {
        CompiledGraph graph = linear().compile(new InMemorySaver());

        graph.invoke(GraphState.empty(), thread("t-1"));
        GraphState second = graph.invoke(GraphState.empty(), thread("t-1"));

        assertEquals(List.of("a", "b", "a", "b"), second.get("trace"),
                "turn two starts from where turn one stopped");
    }

    @Test
    void twoThreadsDoNotShareAPast() throws Exception {
        CompiledGraph graph = linear().compile(new InMemorySaver());

        graph.invoke(GraphState.empty(), thread("mine"));
        GraphState other = graph.invoke(GraphState.empty(), thread("yours"));

        assertEquals(List.of("a", "b"), other.get("trace"));
    }

    @Test
    void aRunWithoutAThreadIdGoesUnrecordedRatherThanFailing() throws Exception {
        InMemorySaver saver = new InMemorySaver();
        CompiledGraph graph = linear().compile(saver);

        GraphState state = graph.invoke(GraphState.empty(), RunConfig.defaults());

        assertEquals(List.of("a", "b"), state.get("trace"),
                "a graph run from a script is a legitimate use");
        assertTrue(saver.get(thread("t-1")).values().isEmpty(),
                "an unaddressable checkpoint must not be filed under an invented thread");
    }

    @Test
    void theInputIsAppliedThroughTheReducersOntoThePersistedState() throws Exception {
        CompiledGraph graph = echo().compile(new InMemorySaver());

        graph.invoke(GraphState.of(Map.of("answer", "first")), thread("t-1"));
        GraphState kept = graph.invoke(GraphState.empty(), thread("t-1"));
        assertEquals("first", kept.get("answer"),
                "an input that does not mention the channel must not erase the past");

        GraphState overwritten = graph.invoke(GraphState.of(Map.of("answer", "third")),
                thread("t-1"));
        assertEquals("third", overwritten.get("answer"));
    }

    @Test
    void aCheckpointerDoesNotChangeTheAnswer() throws Exception {
        GraphState without = linear().compile().invoke(GraphState.empty(), thread("t-1"));
        GraphState with = linear().compile(new InMemorySaver())
                .invoke(GraphState.empty(), thread("t-fresh"));

        assertEquals(without.values(), with.values(),
                "memory may add a past, never alter a first turn");
    }

    @Test
    void theSaverOutlivesTheGraphItWasCompiledInto() throws Exception {
        InMemorySaver saver = new InMemorySaver();
        linear().compile(saver).invoke(GraphState.empty(), thread("t-1"));

        // The application rebuilt its graph — same saver, new compile.
        CompiledGraph rebuilt = linear().compile(saver);
        assertEquals(List.of("a", "b"), rebuilt.getState(thread("t-1")).values().get("trace"),
                "an open conversation must not lose its past to a recompile");

        GraphState continued = rebuilt.invoke(GraphState.empty(), thread("t-1"));
        assertEquals(List.of("a", "b", "a", "b"), continued.get("trace"));
    }

    // -- what the thread files ------------------------------------------------ //

    @Test
    void everySuperstepBoundaryFilesOneCheckpoint() throws Exception {
        CompiledGraph graph = linear().compile(new InMemorySaver());
        graph.invoke(GraphState.empty(), thread("t-1"));

        List<StateSnapshot> history = graph.getStateHistory(thread("t-1")).toList();
        assertEquals(3, history.size(),
                "the loaded state with the first frontier, then one per superstep");
        assertEquals(List.of(), history.get(0).next(), "the newest checkpoint has nothing left to run");
        assertEquals(List.of("b"), history.get(1).next());
        assertEquals(List.of("a"), history.get(2).next());
        assertEquals(List.of(2, 1, 0),
                history.stream().map(StateSnapshot::step).toList(), "newest first");
    }

    @Test
    void aSecondRunContinuesTheThreadSeriesRatherThanRestartingIt() throws Exception {
        CompiledGraph graph = linear().compile(new InMemorySaver());
        graph.invoke(GraphState.empty(), thread("t-1"));
        graph.invoke(GraphState.empty(), thread("t-1"));

        List<Integer> steps = graph.getStateHistory(thread("t-1"))
                .map(StateSnapshot::step).toList();
        assertEquals(List.of(5, 4, 3, 2, 1, 0), steps);
    }

    @Test
    void aFailedSuperstepIsNotFiled() throws Exception {
        InMemorySaver saver = new InMemorySaver();
        CompiledGraph graph = new StateGraph(StateSchema.of(Channel.appending("trace")))
                .addNode("a", state -> StateUpdate.of("trace", List.of("a")))
                .addNode("boom", state -> {
                    throw new IllegalStateException("the node's own failure");
                })
                .addEdge(START, "a")
                .addEdge("a", "boom")
                .addEdge("boom", END)
                .compile(saver);

        assertThrows(IllegalStateException.class,
                () -> graph.invoke(GraphState.empty(), thread("t-1")));

        List<StateSnapshot> history = graph.getStateHistory(thread("t-1")).toList();
        assertEquals(2, history.size(),
                "the load boundary and the superstep that completed — never the one that raised");
        assertEquals(List.of("boom"), history.get(0).next(),
                "the newest checkpoint truthfully says what stood next when the run died");
    }

    @Test
    void aThrowingSaverIsARealFailureNotAnObservation() {
        CheckpointSaver failing = new CheckpointSaver() {
            @Override
            public RunConfig put(RunConfig config, Map<String, ?> values, List<String> next,
                                 Integer step, String source) {
                throw new IllegalStateException("the store is full");
            }

            @Override
            public StateSnapshot get(RunConfig config) {
                return StateSnapshot.empty(config);
            }

            @Override
            public java.util.stream.Stream<StateSnapshot> list(RunConfig config,
                    Map<String, Object> filter, RunConfig before, Integer limit) {
                return java.util.stream.Stream.empty();
            }
        };

        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> linear().compile(failing).invoke(GraphState.empty(), thread("t-1")));
        assertEquals("the store is full", failure.getMessage(),
                "a checkpoint that cannot be written is lost memory, not lost observation");
    }

    // -- asking a thread ------------------------------------------------------ //

    @Test
    void getStateReturnsTheEndOfTheNewestRun() throws Exception {
        CompiledGraph graph = linear().compile(new InMemorySaver());
        graph.invoke(GraphState.empty(), thread("t-1"));

        StateSnapshot snapshot = graph.getState(thread("t-1"));
        assertEquals(List.of("a", "b"), snapshot.values().get("trace"));
        assertTrue(snapshot.next().isEmpty());
        assertEquals(2, snapshot.step());
    }

    @Test
    void getStateOfAThreadNobodyRanIsEmptyRatherThanAnError() throws Exception {
        CompiledGraph graph = linear().compile(new InMemorySaver());

        StateSnapshot snapshot = graph.getState(thread("nobody"));
        assertTrue(snapshot.values().isEmpty(), "no history is the normal state of a first message");
        assertEquals(-1, snapshot.step());
    }

    @Test
    void getStateHonoursACheckpointIdPin() throws Exception {
        CompiledGraph graph = linear().compile(new InMemorySaver());
        graph.invoke(GraphState.empty(), thread("t-1"));

        StateSnapshot middle = graph.getStateHistory(thread("t-1")).toList().get(1);
        StateSnapshot pinned = graph.getState(middle.config());

        assertEquals(middle.values(), pinned.values());
        assertEquals(middle.step(), pinned.step());
    }

    @Test
    void aThreadQuestionWithoutACheckpointerRaises() {
        CompiledGraph amnesiac = linear().compile();

        MissingCheckpointerException refusal = assertThrows(MissingCheckpointerException.class,
                () -> amnesiac.getState(thread("t-1")));
        assertTrue(refusal.getMessage().contains("compile"),
                "the message must say how to get memory, not just that there is none: "
                        + refusal.getMessage());
        assertThrows(MissingCheckpointerException.class,
                () -> amnesiac.getStateHistory(thread("t-1")));
    }

    // -- the wire: threadId only when a checkpointer is configured ------------ //

    @Test
    void graphStartCarriesTheThreadIdWhenACheckpointerIsConfigured() throws Exception {
        List<Map<String, Object>> records = new ArrayList<>();
        linear().compile(new InMemorySaver(), records::add)
                .invoke(GraphState.empty(), thread("t-9f3c"));

        Map<String, Object> start = records.stream()
                .filter(record -> "graph_start".equals(record.get("type")))
                .findFirst().orElseThrow();
        assertEquals("t-9f3c", start.get("threadId"));
    }

    @Test
    void graphStartOmitsTheThreadIdWithoutACheckpointerEvenWhenTheCallerNamedOne()
            throws Exception {
        List<Map<String, Object>> records = new ArrayList<>();
        linear().compile(records::add).invoke(GraphState.empty(), thread("t-9f3c"));

        Map<String, Object> start = records.stream()
                .filter(record -> "graph_start".equals(record.get("type")))
                .findFirst().orElseThrow();
        assertFalse(start.containsKey("threadId"),
                "harvested rule 103: threadId is present only when a checkpointer is "
                        + "configured — a graph without memory has no threads, so the key "
                        + "would claim an identity nothing can look up: " + start);
    }

    @Test
    void aCheckpointedRunStillOmitsTheKeyWhenNoThreadWasNamed() throws Exception {
        List<Map<String, Object>> records = new ArrayList<>();
        linear().compile(new InMemorySaver(), records::add)
                .invoke(GraphState.empty(), RunConfig.defaults());

        Map<String, Object> start = records.stream()
                .filter(record -> "graph_start".equals(record.get("type")))
                .findFirst().orElseThrow();
        assertFalse(start.containsKey("threadId"), start.toString());
    }

    // -- the compile surface --------------------------------------------------- //

    @Test
    void compileAcceptsCheckpointerSinkAndPolicyTogether() throws Exception {
        List<Map<String, Object>> records = new ArrayList<>();
        CompiledGraph graph = linear().compile(new InMemorySaver(), records::add,
                StatePolicy.summary());
        graph.invoke(GraphState.empty(), thread("t-1"));

        assertEquals(List.of("a", "b"),
                graph.getState(thread("t-1")).values().get("trace"));
        assertTrue(records.stream().anyMatch(r -> "state_policy".equals(r.get("type"))),
                "the policy record proves the sink and the policy both arrived");
        assertEquals(StatePolicy.summary().mode(), graph.statePolicy().mode(),
                "statePolicy() must report the configured tier");
    }
}
