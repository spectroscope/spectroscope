package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static dev.spectroscope.core.graph.StateGraph.END;
import static dev.spectroscope.core.graph.StateGraph.START;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Reading the two artifact files back, ported from the python edition's
 * {@code load_graph_artifact} / {@code load_state_payloads} /
 * {@code load_state_policies} — so writer and reader are pairwise checkable in
 * ONE language instead of across three.
 *
 * <p>Tolerance is the contract: blank lines, torn lines and non-object lines
 * are dropped without a word, because the common reason for a torn line is a
 * crash and the reader's job is to show what survived. A missing FILE raises —
 * an artifact that was never written is a different problem from one that is
 * empty.</p>
 */
class ArtifactReaderTest {

    private static StateGraph linear() {
        return new StateGraph(StateSchema.of(Channel.appending("trace")))
                .addNode("a", state -> StateUpdate.of("trace", List.of("a")))
                .addNode("b", state -> StateUpdate.of("trace", List.of("b")))
                .addEdge(START, "a")
                .addEdge("a", "b")
                .addEdge("b", END);
    }

    // -- the lifecycle file --------------------------------------------------- //

    @Test
    void aWrittenRunReadsBackAsTopologyAndRecords(@TempDir Path directory) throws Exception {
        Path stem = directory.resolve("run.jsonl");
        try (GraphArtifact lifecycle = new GraphArtifact(stem)) {
            linear().compile(lifecycle).invoke(Map.of());
        }

        ArtifactReader.LoadedGraphArtifact loaded = ArtifactReader.loadGraphArtifact(stem);

        assertEquals("graph_topology", loaded.topology().get("type"));
        assertEquals(List.of("graph_start",
                        "edge_taken", "node_start", "node_end",
                        "edge_taken", "node_start", "node_end",
                        "edge_taken", "graph_end"),
                loaded.records().stream().map(record -> record.get("type")).toList(),
                "the lifecycle comes back in the order it was written");
    }

    @Test
    void theFirstTopologyLeadsALaterOneStaysInTheRecords(@TempDir Path directory)
            throws Exception {
        Path stem = directory.resolve("run.jsonl");
        try (GraphArtifact lifecycle = new GraphArtifact(stem)) {
            // A re-ingest rebuilt the graph against the same append-mode file.
            linear().compile(lifecycle);
            linear().compile(lifecycle);
        }

        ArtifactReader.LoadedGraphArtifact loaded = ArtifactReader.loadGraphArtifact(stem);

        assertEquals("graph_topology", loaded.topology().get("type"));
        assertEquals(1, loaded.records().stream()
                        .filter(record -> "graph_topology".equals(record.get("type"))).count(),
                "a viewer must be able to SEE that the shape changed instead of "
                        + "silently reading the wrong drawing");
    }

    @Test
    void blankTornAndNonObjectLinesAreDroppedWithoutAWord(@TempDir Path directory)
            throws Exception {
        Path stem = directory.resolve("run.jsonl");
        Files.writeString(ArtifactPaths.graph(stem), """
                {"type":"graph_topology","schema_version":1}

                {"type":"graph_start","runId":"r-1"
                42
                "just a string"
                {"type":"graph_end","runId":"r-1","steps":2}
                """, StandardCharsets.UTF_8);

        ArtifactReader.LoadedGraphArtifact loaded = ArtifactReader.loadGraphArtifact(stem);

        assertEquals("graph_topology", loaded.topology().get("type"));
        assertEquals(List.of("graph_end"),
                loaded.records().stream().map(record -> record.get("type")).toList(),
                "the torn graph_start of a crash is dropped; the reader shows what survived");
    }

    @Test
    void aMissingFileRaisesRatherThanPretendingEmptiness(@TempDir Path directory) {
        assertThrows(IOException.class,
                () -> ArtifactReader.loadGraphArtifact(directory.resolve("never-written.jsonl")),
                "an artifact that was never written is a different problem from an empty one");
    }

    @Test
    void aNodeErrorReadsBackWithItsFlatErrorAndMessage(@TempDir Path directory) {
        // The night this package was proved, the TYPESCRIPT reader expected a
        // nested error object where the writer emits two flat sibling fields —
        // and a real failure parsed to nothing. This pins the flat shape at the
        // Java reader, so the pair cannot drift apart again.
        Path stem = directory.resolve("run.jsonl");
        assertThrows(IllegalStateException.class, () -> {
            try (GraphArtifact lifecycle = new GraphArtifact(stem)) {
                new StateGraph(StateSchema.of())
                        .addNode("boom", state -> {
                            throw new IllegalStateException("the real reason");
                        })
                        .addEdge(START, "boom")
                        .addEdge("boom", END)
                        .compile(lifecycle)
                        .invoke(Map.of());
            }
        });

        Map<String, Object> error;
        try {
            error = ArtifactReader.loadGraphArtifact(stem).records().stream()
                    .filter(record -> "node_error".equals(record.get("type")))
                    .findFirst().orElseThrow();
        } catch (IOException failure) {
            throw new AssertionError(failure);
        }
        assertEquals("IllegalStateException", error.get("error"),
                "error is a flat string sibling, not a nested object");
        assertEquals("the real reason", error.get("message"));
    }

    // -- the values file ------------------------------------------------------- //

    @Test
    void statePayloadsComeBackKeyedByRunNodeAndSuperstep(@TempDir Path directory)
            throws Exception {
        Path stem = directory.resolve("run.jsonl");
        try (GraphArtifact lifecycle = new GraphArtifact(stem);
             StateArtifact values = new StateArtifact(stem)) {
            linear().compile(record -> {
                lifecycle.accept(record);
                values.accept(record);
            }, StatePolicy.summary().withAllowed(List.of("trace"))).invoke(Map.of());
        }

        String runId = String.valueOf(ArtifactReader.loadGraphArtifact(stem).records().stream()
                .filter(record -> "graph_start".equals(record.get("type")))
                .findFirst().orElseThrow().get("runId"));

        Map<ArtifactReader.PayloadKey, Map<String, Object>> payloads =
                ArtifactReader.loadStatePayloads(stem);

        assertTrue(payloads.containsKey(new ArtifactReader.PayloadKey(runId, "a", 0)),
                "a node can enter twice in one run, so the join needs the superstep: "
                        + payloads.keySet());
        assertTrue(payloads.containsKey(new ArtifactReader.PayloadKey(runId, "b", 1)));
    }

    @Test
    void aRepeatPayloadWritesOverItsEarlierSelf(@TempDir Path directory) throws Exception {
        Path stem = directory.resolve("run.jsonl");
        Files.writeString(ArtifactPaths.state(stem), """
                {"type":"state_payload","runId":"r-1","node":"a","superstep":0,"marker":"first"}
                {"type":"state_payload","runId":"r-1","node":"a","superstep":0,"marker":"second"}
                """, StandardCharsets.UTF_8);

        Map<ArtifactReader.PayloadKey, Map<String, Object>> payloads =
                ArtifactReader.loadStatePayloads(stem);

        assertEquals("second",
                payloads.get(new ArtifactReader.PayloadKey("r-1", "a", 0)).get("marker"),
                "the file is append-mode; the last line is the one the run finished with");
    }

    @Test
    void aPayloadWithoutASuperstepKeysAtMinusOne(@TempDir Path directory) throws Exception {
        Path stem = directory.resolve("run.jsonl");
        Files.writeString(ArtifactPaths.state(stem), """
                {"type":"state_payload","runId":"r-1","node":"a"}
                """, StandardCharsets.UTF_8);

        assertTrue(ArtifactReader.loadStatePayloads(stem)
                        .containsKey(new ArtifactReader.PayloadKey("r-1", "a", -1)),
                "the python reference defaults a missing superstep to -1, and the join "
                        + "must land on the same key in both editions");
    }

    @Test
    void statePoliciesComeBackKeyedByRunId(@TempDir Path directory) throws Exception {
        Path stem = directory.resolve("run.jsonl");
        try (StateArtifact values = new StateArtifact(stem)) {
            CompiledGraph graph = linear().compile(values, StatePolicy.summary());
            graph.invoke(Map.of());
            graph.invoke(Map.of());
        }

        Map<String, Map<String, Object>> policies = ArtifactReader.loadStatePolicies(stem);

        assertEquals(2, policies.size(), "one policy record per run, keyed by that run");
        policies.forEach((runId, record) ->
                assertEquals("state_policy", record.get("type")));
    }

    @Test
    void aMissingStateFileRaisesLikeAMissingLifecycleFile(@TempDir Path directory)
            throws Exception {
        // Faithful to the python reference: all three loaders read the file
        // directly and a missing one raises. Whether "state recording was off"
        // is a normal absence is the CALLER's judgement — a reader that silently
        // equated it with "recorded nothing" would repeat the zero-byte-file
        // mistake this layer exists to avoid.
        Path stem = directory.resolve("run.jsonl");
        try (GraphArtifact lifecycle = new GraphArtifact(stem)) {
            linear().compile(lifecycle).invoke(Map.of());
        }

        assertThrows(IOException.class, () -> ArtifactReader.loadStatePayloads(stem));
        assertThrows(IOException.class, () -> ArtifactReader.loadStatePolicies(stem));
    }
}
