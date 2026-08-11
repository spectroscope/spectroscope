package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The chain closing: a CRAG-shaped graph with a LOOP is run for real, both
 * artifacts land on disk, and the view is asked to read exactly those bytes.
 *
 * <p>Only enabled when {@code -Dproof.out} names a stem, so a normal gate run
 * does not write outside the build directory.</p>
 */
class ProofOfChainTest {

    /** router -> retrieve -> grade -> rewrite -> BACK to router, then generate. */
    private static StateGraph crag() {
        StateSchema schema = StateSchema.of(
                Channel.lastWriteWins("question"),
                Channel.lastWriteWins("query_used"),
                Channel.lastWriteWins("route"),
                Channel.appending("docs"),
                Channel.lastWriteWins("grade_ratio"),
                Channel.lastWriteWins("rewrites"),
                Channel.lastWriteWins("answer"),
                Channel.appending("citations"),
                Channel.lastWriteWins("confidence"),
                Channel.appending("trace"));

        LinkedHashMap<String, String> routerMap = new LinkedHashMap<>();
        routerMap.put("retrieve", "retrieve");
        routerMap.put("generate", "generate");

        LinkedHashMap<String, String> gradeMap = new LinkedHashMap<>();
        gradeMap.put("generate", "generate");
        gradeMap.put("rewrite", "rewrite");

        return new StateGraph(schema)
                .addNode("router", state -> {
                    String q = String.valueOf(state.get("question"));
                    return StateUpdate.of("query_used", q)
                            .and("route", "retrieve")
                            .and("trace", List.of("router: route=retrieve"));
                })
                .addNode("retrieve", state -> StateUpdate
                        .of("docs", List.of("doc-a: the release window is signed by the duty lead",
                                "doc-b: unrelated onboarding page"))
                        .and("trace", List.of("retrieve: 2 docs")))
                .addNode("grade", state -> {
                    boolean second = state.has("rewrites");
                    double ratio = second ? 0.83 : 0.25;
                    return StateUpdate.of("grade_ratio", ratio)
                            .and("trace", List.of("grade: ratio=" + ratio));
                })
                .addNode("rewrite", state -> StateUpdate
                        .of("question", "who signs off a maintenance window, and when is it released?")
                        .and("rewrites", 1)
                        .and("trace", List.of("rewrite: query widened")))
                .addNode("generate", state -> StateUpdate
                        .of("answer", "The duty lead signs the window off; it is released "
                                + "once the signature and the change record agree.")
                        .and("citations", List.of("doc-a"))
                        .and("confidence", 0.78)
                        .and("trace", List.of("generate: answered from 1 citation")))
                .addEdge(StateGraph.START, "router")
                .addEdge("retrieve", "grade")
                .addEdge("rewrite", "router")
                .addEdge("generate", StateGraph.END)
                .addConditionalEdges("router",
                        (FanOutPath) state -> state.get("route"), routerMap)
                .addConditionalEdges("grade",
                        (FanOutPath) state -> ((Number) state.get("grade_ratio")).doubleValue() < 0.5
                                ? "rewrite" : "generate", gradeMap);
    }

    @Test
    void aRealRunWritesBothArtifactsWhereTheViewCanBeHandedThem() throws Exception {
        String stem = System.getProperty("proof.out");
        org.junit.jupiter.api.Assumptions.assumeTrue(stem != null, "-Dproof.out not set");

        Path base = Path.of(stem);
        Files.deleteIfExists(ArtifactPaths.graph(base));
        Files.deleteIfExists(ArtifactPaths.state(base));

        try (GraphArtifact lifecycle = new GraphArtifact(base);
             StateArtifact values = new StateArtifact(base)) {

            // No fan-out class: each artifact refuses the other's vocabulary, so
            // the refusal IS the routing.
            Consumer<Map<String, Object>> both = record -> {
                lifecycle.accept(record);
                values.accept(record);
            };

            CompiledGraph graph = crag().compile(both, StatePolicy.summary());
            GraphState answer = graph.invoke(Map.of(
                    "question", "How does a maintenance window get released, and who has to sign it?"));

            assertEquals(0, graph.sinkFailures(), "no sink may have failed");
            assertTrue(answer.has("answer"), "the run must have produced an answer");
        }

        List<String> lifecycleLines = Files.readAllLines(ArtifactPaths.graph(base));
        List<String> valueLines = Files.readAllLines(ArtifactPaths.state(base));

        assertTrue(lifecycleLines.get(0).startsWith("{\"type\":\"graph_topology\""),
                "the drawing comes first");
        assertTrue(valueLines.get(0).startsWith("{\"type\":\"state_policy\""),
                "the policy comes first");
        // The loop is the point: router is entered twice.
        assertEquals(2, lifecycleLines.stream()
                .filter(l -> l.contains("\"type\":\"node_start\"") && l.contains("\"node\":\"router\""))
                .count(), "router must be entered twice");
        // The lifecycle file must not hold a caller's values.
        assertTrue(lifecycleLines.stream().noneMatch(l -> l.contains("duty lead")),
                "the bug-report file must be free of the run's values");

        System.out.println("PROOF lifecycle=" + ArtifactPaths.graph(base) + " lines=" + lifecycleLines.size());
        System.out.println("PROOF values=" + ArtifactPaths.state(base) + " lines=" + valueLines.size());
    }
}
