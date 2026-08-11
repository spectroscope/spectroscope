package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;

import static dev.spectroscope.core.graph.StateGraph.END;
import static dev.spectroscope.core.graph.StateGraph.START;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Streaming, ported from the python edition's {@code get_stream_writer} and
 * {@code astream} — synchronously, because this engine is synchronous: chunks
 * arrive on the caller's own thread, inline, in the order the run produced
 * them. What makes it streaming is WHEN the caller sees a chunk (mid-run, not
 * at the end), not which thread carries it.
 */
class StreamingTest {

    private static StateGraph linear() {
        return new StateGraph(StateSchema.of(Channel.appending("trace")))
                .addNode("a", state -> StateUpdate.of("trace", List.of("a")))
                .addNode("b", state -> StateUpdate.of("trace", List.of("b")))
                .addEdge(START, "a")
                .addEdge("a", "b")
                .addEdge("b", END);
    }

    // -- the writer ------------------------------------------------------------ //

    @Test
    void theWriterOutsideARunRaises() {
        IllegalStateException refusal = assertThrows(IllegalStateException.class,
                CompiledGraph::streamWriter,
                "python parity: callers use the raise as 'this code is not being streamed'");
        assertTrue(refusal.getMessage().contains("run"), refusal.getMessage());
    }

    @Test
    void aNodeCanEmitMidRunAndTheChunkArrivesBeforeTheNodesUpdate() throws Exception {
        List<String> order = new ArrayList<>();
        CompiledGraph graph = new StateGraph(StateSchema.of())
                .addNode("worker", state -> {
                    CompiledGraph.streamWriter().write("halfway");
                    return StateUpdate.of("answer", "done");
                })
                .addEdge(START, "worker")
                .addEdge("worker", END)
                .compile();

        graph.stream(GraphState.empty(), RunConfig.defaults(),
                EnumSet.of(CompiledGraph.StreamMode.UPDATES, CompiledGraph.StreamMode.CUSTOM),
                chunk -> order.add(chunk.mode() + ":" + summary(chunk.chunk())));

        assertEquals(List.of("CUSTOM:halfway", "UPDATES:worker"), order,
                "the custom chunk streams DURING the node, the update only after "
                        + "the superstep merged");
    }

    @Test
    void aRouterCanEmitThroughTheWriterToo() throws Exception {
        List<Object> chunks = new ArrayList<>();
        CompiledGraph graph = new StateGraph(StateSchema.of())
                .addNode("worker", state -> StateUpdate.none())
                .addConditionalEdges(START, state -> {
                    CompiledGraph.streamWriter().write("deciding…");
                    return "worker";
                }, List.of("worker"))
                .addEdge("worker", END)
                .compile();

        graph.stream(GraphState.empty(), RunConfig.defaults(),
                EnumSet.of(CompiledGraph.StreamMode.CUSTOM),
                chunk -> chunks.add(chunk.chunk()));

        assertEquals(List.of("deciding…"), chunks,
                "a router emitting progress is an ordinary pattern, so the writer is "
                        + "bound during routing as well");
    }

    @Test
    void withoutACustomConsumerTheWriterSwallowsQuietly() throws Exception {
        CompiledGraph graph = new StateGraph(StateSchema.of())
                .addNode("worker", state -> {
                    CompiledGraph.streamWriter().write("nobody listens");
                    return StateUpdate.of("answer", "done");
                })
                .addEdge(START, "worker")
                .addEdge("worker", END)
                .compile();

        assertEquals("done", graph.invoke(GraphState.empty()).get("answer"),
                "the writer inside a run is real and never null, so a node branching on "
                        + "its presence takes its streaming path and the write costs nothing");
    }

    @Test
    void theWriterIsGoneAgainAfterTheRun() throws Exception {
        linear().compile().invoke(GraphState.empty());
        assertThrows(IllegalStateException.class, CompiledGraph::streamWriter,
                "a binding that leaked past its run would stream one caller's chunks "
                        + "into another caller's consumer");
    }

    // -- the modes -------------------------------------------------------------- //

    @Test
    void valuesModeYieldsTheStateAfterEachSuperstepBoundary() throws Exception {
        List<Object> traces = new ArrayList<>();
        linear().compile().stream(GraphState.empty(), RunConfig.defaults(),
                EnumSet.of(CompiledGraph.StreamMode.VALUES),
                chunk -> traces.add(((Map<?, ?>) chunk.chunk()).get("trace")));

        assertEquals(3, traces.size(),
                "the loaded state with the first frontier, then one per superstep");
        assertEquals(null, traces.get(0), "before any node ran, nothing wrote the channel");
        assertEquals(List.of("a"), traces.get(1));
        assertEquals(List.of("a", "b"), traces.get(2));
    }

    @Test
    void updatesModeYieldsEachNodesOwnWrite() throws Exception {
        List<Object> updates = new ArrayList<>();
        linear().compile().stream(GraphState.empty(), RunConfig.defaults(),
                EnumSet.of(CompiledGraph.StreamMode.UPDATES),
                chunk -> updates.add(chunk.chunk()));

        assertEquals(List.of(
                        Map.of("a", Map.of("trace", List.of("a"))),
                        Map.of("b", Map.of("trace", List.of("b")))),
                updates,
                "one update chunk per node, carrying the node's OWN write — b's chunk "
                        + "holds [b] alone, so this reddens if the merge leaks in");
    }

    @Test
    void streamReturnsTheEndStateLikeInvoke() throws Exception {
        GraphState end = linear().compile().stream(GraphState.empty(), RunConfig.defaults(),
                EnumSet.of(CompiledGraph.StreamMode.VALUES), chunk -> {
                });
        assertEquals(List.of("a", "b"), end.get("trace"));
    }

    @Test
    void anEmptyModeSetRefuses() {
        CompiledGraph graph = linear().compile();
        assertThrows(IllegalArgumentException.class,
                () -> graph.stream(GraphState.empty(), RunConfig.defaults(),
                        EnumSet.noneOf(CompiledGraph.StreamMode.class), chunk -> {
                        }),
                "python parity D6: asking for nothing is a caller bug, not a silent no-op");
    }

    @Test
    void aConsumerExceptionIsARealFailureNotAnObservation() {
        // The stream consumer is the CALLER's own code asking for the chunks —
        // unlike a sink, it is not observation riding along. A consumer that
        // throws is the caller failing, and hiding that would be lying to them.
        CompiledGraph graph = linear().compile();
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> graph.stream(GraphState.empty(), RunConfig.defaults(),
                        EnumSet.of(CompiledGraph.StreamMode.VALUES), chunk -> {
                            throw new IllegalStateException("the caller's own bug");
                        }));
        assertEquals("the caller's own bug", failure.getMessage());
    }

    /** The single node name of an updates chunk, or the chunk's own text. */
    private static String summary(Object chunk) {
        if (chunk instanceof Map<?, ?> map && map.size() == 1) {
            return String.valueOf(map.keySet().iterator().next());
        }
        return String.valueOf(chunk);
    }
}
