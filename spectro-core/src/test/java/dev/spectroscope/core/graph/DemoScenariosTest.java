package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;

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
 * The demo scenarios the state-graph view ships: written by REAL runs of this
 * engine, never by hand — a hand-written artifact would drift from the writer
 * the first time a field moves, and the point of a demo is that it is true.
 *
 * <p>Only enabled when {@code -Ddemos.out} names a directory, the
 * {@link ProofOfChainTest} pattern: a normal gate run writes nothing outside
 * the build directory. Four scenarios, four shapes worth teaching:</p>
 *
 * <ul>
 *   <li><b>simple-rag</b> — the linear pipeline everyone starts with, recorded
 *       at {@code sample()} so the documents strip shows a kept-of-N marker;</li>
 *   <li><b>crag</b> — the corrective loop: a failed grading walks back through
 *       rewrite and the second attempt passes;</li>
 *   <li><b>react-tools</b> — plan/act/observe around a tool budget, TWO turns
 *       on ONE thread, so the thread memory is visible in the file;</li>
 *   <li><b>failing-run</b> — a groundedness check that throws: the run dies
 *       honestly, node_error and graph_end both on disk.</li>
 * </ul>
 */
class DemoScenariosTest {

    private static RunConfig thread(String threadId) {
        return RunConfig.defaults().withConfigurable(Map.of("thread_id", threadId));
    }

    private static final List<String> CORPUS = List.of(
            "ops-handbook §7: a maintenance window is released by the change advisory board",
            "ops-handbook §6: two signatures are required, operations owner and engineer",
            "ops-handbook §5: emergency changes skip the board and are reviewed after",
            "ops-handbook §4: the board meets weekly and rates risk, reach and rollback",
            "onboarding: how to request a laptop",
            "cafeteria plan for the coming week");

    // -- simple-rag ----------------------------------------------------------- //

    private static StateGraph simpleRag() {
        StateSchema schema = StateSchema.of(
                Channel.lastWriteWins("question"),
                Channel.appending("docs"),
                Channel.appending("citations"),
                Channel.lastWriteWins("answer"),
                Channel.lastWriteWins("confidence"),
                Channel.appending("trace"));
        return new StateGraph(schema)
                .addNode("retrieve", state -> StateUpdate
                        .of("docs", CORPUS)
                        .and("trace", List.of("retrieve: 6 chunks from the handbook index")))
                .addNode("rerank", state -> StateUpdate
                        .of("trace", List.of("rerank: handbook sections first, noise last")))
                .addNode("generate", state -> StateUpdate
                        .of("answer", "The change advisory board releases the window; the "
                                + "operations owner and the responsible engineer both sign.")
                        .and("citations", List.of("ops-handbook §7", "ops-handbook §6"))
                        .and("confidence", 0.91)
                        .and("trace", List.of("generate: answered from 2 citations")))
                .addEdge(START, "retrieve")
                .addEdge("retrieve", "rerank")
                .addEdge("rerank", "generate")
                .addEdge("generate", END);
    }

    // -- crag ------------------------------------------------------------------ //

    private static StateGraph crag() {
        StateSchema schema = StateSchema.of(
                Channel.lastWriteWins("question"),
                Channel.lastWriteWins("query_used"),
                Channel.appending("docs"),
                Channel.lastWriteWins("grade_ratio"),
                Channel.lastWriteWins("rewrites"),
                Channel.lastWriteWins("answer"),
                Channel.appending("citations"),
                Channel.appending("trace"));
        return new StateGraph(schema)
                .addNode("router", state -> StateUpdate
                        .of("query_used", String.valueOf(state.get("question")))
                        .and("trace", List.of("router: vector search")))
                .addNode("retrieve", state -> {
                    boolean widened = state.has("rewrites");
                    return StateUpdate
                            .of("docs", widened ? CORPUS.subList(0, 4) : CORPUS.subList(3, 6))
                            .and("trace", List.of(widened
                                    ? "retrieve: widened query, handbook sections"
                                    : "retrieve: narrow query, mostly noise"));
                })
                .addNode("grade", state -> {
                    boolean widened = state.has("rewrites");
                    double ratio = widened ? 0.75 : 0.33;
                    return StateUpdate.of("grade_ratio", ratio)
                            .and("trace", List.of("grade: " + ratio + " of the chunks are on topic"));
                })
                .addNode("rewrite", state -> StateUpdate
                        .of("query_used", "maintenance window release signatures board")
                        .and("rewrites", 1)
                        .and("trace", List.of("rewrite: query widened")))
                .addNode("generate", state -> StateUpdate
                        .of("answer", "Released by the change advisory board, against two "
                                + "signatures: operations owner and responsible engineer.")
                        .and("citations", List.of("ops-handbook §7", "ops-handbook §6"))
                        .and("trace", List.of("generate: answered from 2 citations")))
                .addEdge(START, "router")
                .addEdge("router", "retrieve")
                .addEdge("retrieve", "grade")
                .addEdge("rewrite", "router")
                .addEdge("generate", END)
                .addConditionalEdges("grade",
                        (FanOutPath) state ->
                                ((Number) state.get("grade_ratio")).doubleValue() < 0.5
                                        ? "rewrite" : "generate",
                        List.of("rewrite", "generate"));
    }

    // -- react-tools ----------------------------------------------------------- //

    private static StateGraph reactTools() {
        StateSchema schema = StateSchema.of(
                Channel.lastWriteWins("question"),
                Channel.lastWriteWins("plan"),
                Channel.appending("observations"),
                Channel.lastWriteWins("tool_calls"),
                Channel.lastWriteWins("answer"),
                Channel.appending("trace"));
        return new StateGraph(schema)
                .addNode("plan", state -> {
                    int calls = state.get("tool_calls") == null ? 0
                            : ((Number) state.get("tool_calls")).intValue();
                    return StateUpdate.of("plan", calls == 0
                                    ? "look the window schedule up before answering"
                                    : "enough observed, write the answer")
                            .and("trace", List.of("plan: step " + (calls + 1)));
                })
                .addNode("act", state -> {
                    int calls = state.get("tool_calls") == null ? 0
                            : ((Number) state.get("tool_calls")).intValue();
                    return StateUpdate.of("tool_calls", calls + 1)
                            .and("observations", List.of(calls == 0
                                    ? "calendar: next window friday 22:00"
                                    : "signoff: both signatures present"))
                            .and("trace", List.of("act: tool call " + (calls + 1)));
                })
                .addNode("answer", state -> StateUpdate
                        .of("answer", "Friday 22:00, and it is already signed off twice.")
                        .and("trace", List.of("answer: two observations were enough")))
                .addEdge(START, "plan")
                .addEdge("act", "plan")
                .addEdge("answer", END)
                .addConditionalEdges("plan",
                        (FanOutPath) state -> {
                            Object calls = state.get("tool_calls");
                            return calls != null && ((Number) calls).intValue() >= 2
                                    ? "answer" : "act";
                        },
                        List.of("act", "answer"));
    }

    // -- failing-run ------------------------------------------------------------ //

    private static StateGraph failingRun() {
        StateSchema schema = StateSchema.of(
                Channel.lastWriteWins("question"),
                Channel.appending("docs"),
                Channel.lastWriteWins("answer"),
                Channel.appending("trace"));
        return new StateGraph(schema)
                .addNode("retrieve", state -> StateUpdate
                        .of("docs", List.of(CORPUS.get(4), CORPUS.get(5)))
                        .and("trace", List.of("retrieve: nothing on topic came back")))
                .addNode("generate", state -> {
                    throw new IllegalStateException(
                            "GroundednessError: no retrieved chunk supports an answer");
                })
                .addEdge(START, "retrieve")
                .addEdge("retrieve", "generate")
                .addEdge("generate", END);
    }

    // -- the generator ----------------------------------------------------------- //

    @Test
    void theFourDemoScenariosAreWrittenByRealRuns() throws Exception {
        String out = System.getProperty("demos.out");
        org.junit.jupiter.api.Assumptions.assumeTrue(out != null, "-Ddemos.out not set");
        Path directory = Path.of(out);
        Files.createDirectories(directory);

        // simple-rag: sample() keeps 3 of the 6 docs, so the strip shows the
        // kept-of marker instead of pretending the corpus is three chunks long.
        write(directory.resolve("simple-rag.jsonl"), simpleRag(),
                StatePolicy.sample().withAllowed(List.of("question", "answer", "confidence",
                        "citations", "trace", "docs")),
                null, Map.of("question",
                        "How does a maintenance window get released, and who signs it?"));

        // crag records its DOCUMENTS: the narrow first retrieval (3 chunks,
        // plain) and the widened second one (4 chunks, sampled 3-of-4) put both
        // strip shapes on screen — a demo that hid the corpus would teach the
        // reference fixture's absence lesson twice and its own not at all.
        write(directory.resolve("crag.jsonl"), crag(),
                StatePolicy.sample().withAllowed(List.of("question", "query_used",
                        "grade_ratio", "answer", "citations", "trace", "docs")),
                null, Map.of("question", "Who releases a maintenance window?"));

        // react-tools: TWO turns on ONE thread — the checkpointer's memory is
        // part of the picture, so the demo file carries both runs.
        CheckpointSaver saver = new InMemorySaver();
        Path react = directory.resolve("react-tools.jsonl");
        deleteFamily(react);
        try (GraphArtifact lifecycle = new GraphArtifact(react);
             StateArtifact values = new StateArtifact(react)) {
            CompiledGraph graph = reactTools().compile(saver,
                    new MultiSink(lifecycle, values),
                    StatePolicy.summary().withAllowed(List.of("question", "plan",
                            "observations", "tool_calls", "answer", "trace")));
            graph.invoke(GraphState.of(Map.of("question", "When is the next window?")),
                    thread("t-react-demo"));
            graph.invoke(GraphState.of(Map.of("question", "And is it signed off?")),
                    thread("t-react-demo"));
        }

        Path failing = directory.resolve("failing-run.jsonl");
        deleteFamily(failing);
        try (GraphArtifact lifecycle = new GraphArtifact(failing);
             StateArtifact values = new StateArtifact(failing)) {
            CompiledGraph graph = failingRun().compile(null,
                    new MultiSink(lifecycle, values),
                    // docs on the allow list on purpose: the two off-topic
                    // chunks ARE the story — the reader sees what grounded
                    // nothing before generate refuses.
                    StatePolicy.summary().withAllowed(List.of("question", "docs", "trace")));
            assertThrows(IllegalStateException.class,
                    () -> graph.invoke(GraphState.of(Map.of("question",
                            "What does the cafeteria serve on friday?")), RunConfig.defaults()));
        }

        // The generated files must actually tell their stories.
        assertTrue(readAll(directory.resolve("simple-rag.jsonl")).contains("\"sampled\":"),
                "the rag demo must carry a sampled-list marker for the documents strip");
        String cragText = readAll(directory.resolve("crag.jsonl"));
        assertEquals(1, count(cragText, "\"node\":\"rewrite\"", "node_start"),
                "crag's rewrite runs exactly once");
        assertEquals(2, count(cragText, "\"node\":\"router\"", "node_start"),
                "the loop is the point: router is entered twice");
        String reactText = readAll(react);
        assertEquals(2, count(reactText, "\"threadId\":\"t-react-demo\"", "graph_start"),
                "the react demo is a conversation: two runs, one thread");
        String failingText = readAll(failing);
        assertTrue(failingText.contains("\"type\":\"node_error\"")
                        && failingText.contains("GroundednessError"),
                "the failing demo must carry its honest node_error");
        assertTrue(failingText.contains("\"type\":\"graph_end\""),
                "a run that died still ends its artifact");
    }

    private static void write(Path stem, StateGraph graph, StatePolicy policy,
                              CheckpointSaver saver, Map<String, ?> input) throws Exception {
        deleteFamily(stem);
        try (GraphArtifact lifecycle = new GraphArtifact(stem);
             StateArtifact values = new StateArtifact(stem)) {
            CompiledGraph compiled = saver == null
                    ? graph.compile(new MultiSink(lifecycle, values), policy)
                    : graph.compile(saver, new MultiSink(lifecycle, values), policy);
            compiled.invoke(GraphState.of(input), RunConfig.defaults());
        }
    }

    private static void deleteFamily(Path stem) throws Exception {
        Files.deleteIfExists(ArtifactPaths.graph(stem));
        Files.deleteIfExists(ArtifactPaths.state(stem));
    }

    private static String readAll(Path stem) throws Exception {
        return Files.readString(ArtifactPaths.graph(stem))
                + "\n" + Files.readString(ArtifactPaths.state(stem));
    }

    private static long count(String text, String needle, String onType) {
        return text.lines()
                .filter(line -> line.contains("\"type\":\"" + onType + "\""))
                .filter(line -> line.contains(needle))
                .count();
    }
}
