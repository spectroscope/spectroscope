package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static dev.spectroscope.core.graph.StateGraph.END;
import static dev.spectroscope.core.graph.StateGraph.START;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The fan-out and the in-memory sink, ported from the python edition's
 * {@code MultiSink} and {@code ListSink} — so wiring both artifact files no
 * longer needs a caller-side lambda, and a test can hold the records the file
 * would hold.
 */
class MultiSinkTest {

    private static StateGraph linear() {
        return new StateGraph(StateSchema.of(Channel.appending("trace")))
                .addNode("a", state -> StateUpdate.of("trace", List.of("a")))
                .addNode("b", state -> StateUpdate.of("trace", List.of("b")))
                .addEdge(START, "a")
                .addEdge("a", "b")
                .addEdge("b", END);
    }

    // -- MultiSink ------------------------------------------------------------- //

    @Test
    void everyRecordReachesEverySinkInDeclarationOrder() throws Exception {
        List<String> arrivals = new ArrayList<>();
        MultiSink fanOut = new MultiSink(
                record -> arrivals.add("first:" + record.get("type")),
                record -> arrivals.add("second:" + record.get("type")));

        linear().compile(fanOut).invoke(GraphState.empty());

        assertTrue(arrivals.size() >= 2, arrivals.toString());
        assertEquals("first:graph_topology", arrivals.get(0));
        assertEquals("second:graph_topology", arrivals.get(1),
                "each record visits the sinks in the order they were declared");
    }

    @Test
    void aRaisingSinkStarvesLaterSinksOfThatRecordAndTheRunGoesOn() throws Exception {
        // Python parity: the fan-out is a bare loop with NO per-sink isolation.
        // The absorbing catch lives in the runtime's emit, where the whole
        // fan-out counts as ONE failure — observation stays fail-safe, but a
        // sink that wants to survive its neighbours has to say so itself.
        List<String> reached = new ArrayList<>();
        MultiSink fanOut = new MultiSink(
                record -> {
                    throw new IllegalStateException("disk full");
                },
                record -> reached.add(String.valueOf(record.get("type"))));

        CompiledGraph graph = linear().compile(fanOut);
        GraphState end = graph.invoke(GraphState.empty());

        assertEquals(List.of("a", "b"), end.get("trace"), "the run is unchanged");
        assertEquals(List.of(), reached, "the second sink never saw a record");
        assertTrue(graph.sinkFailures() > 0, "the loss is counted, not silent");
    }

    @Test
    void theFanOutItselfPropagatesWhatASinkThrows() {
        MultiSink fanOut = new MultiSink(record -> {
            throw new IllegalStateException("mine to see");
        });

        assertThrows(IllegalStateException.class,
                () -> fanOut.accept(new LinkedHashMap<>(Map.of("type", "graph_start"))),
                "no catch inside the fan-out — fail-safety is the runtime's seam, "
                        + "and hiding the throw here would count nothing anywhere");
    }

    @Test
    void bothArtifactFilesArriveThroughOneMultiSink(@TempDir Path directory) throws Exception {
        Path stem = directory.resolve("run.jsonl");
        try (GraphArtifact lifecycle = new GraphArtifact(stem);
             StateArtifact values = new StateArtifact(stem)) {
            linear().compile(new MultiSink(lifecycle, values),
                    StatePolicy.summary().withAllowed(List.of("trace")))
                    .invoke(GraphState.empty());
        }

        assertTrue(Files.size(ArtifactPaths.graph(stem)) > 0);
        assertTrue(Files.size(ArtifactPaths.state(stem)) > 0);
        assertEquals(2, ArtifactReader.loadStatePayloads(stem).size(),
                "the values landed in the values file through the shared fan-out");
        assertTrue(ArtifactReader.loadGraphArtifact(stem).records().stream()
                        .noneMatch(record -> "state_payload".equals(record.get("type"))),
                "each file still refuses the other's vocabulary");
    }

    // -- ListSink --------------------------------------------------------------- //

    @Test
    void aListSinkKeepsTheLatestTopologyAndAppendsTheRest() throws Exception {
        ListSink sink = new ListSink();
        linear().compile(sink).invoke(GraphState.empty());
        Map<String, Object> firstTopo = sink.topology();
        linear().compile(sink); // a re-ingest rebuilt the graph against the same sink

        assertTrue(sink.topology() != firstTopo,
                "the LATEST drawing wins on the in-memory sink — the deliberate "
                        + "asymmetry with loadGraphArtifact, which keeps the FIRST");
        assertEquals("graph_topology", sink.topology().get("type"));
        assertTrue(sink.records().stream()
                        .noneMatch(record -> "graph_topology".equals(record.get("type"))),
                "the drawing lives on topology(), never among the records");
        assertEquals("graph_start", sink.records().get(0).get("type"));
        assertEquals("graph_end", sink.records().get(sink.records().size() - 1).get("type"));
    }

    @Test
    void aListSinkNormalizesTheWayTheFileWould() {
        ListSink sink = new ListSink();
        LinkedHashMap<String, Object> handBuilt = new LinkedHashMap<>();
        handBuilt.put("runId", "r-1");
        handBuilt.put("type", "graph_start");
        sink.accept(handBuilt);

        Map<String, Object> kept = sink.records().get(0);
        assertEquals(List.of("type", "runId", "ts"), List.copyOf(kept.keySet()),
                "type first, ts last, stamped when absent — asserts must see the "
                        + "same shape the file would hold");
    }
}
