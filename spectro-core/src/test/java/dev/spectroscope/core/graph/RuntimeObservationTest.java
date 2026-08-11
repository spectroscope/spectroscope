package dev.spectroscope.core.graph;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * A real run through the sink seam: the light, in the order it walks the drawing.
 *
 * <p>Two properties are load-bearing beyond the record order. A graph compiled
 * without a sink must behave exactly as one always did — observation is opt-in,
 * so the run pays nothing for it. And observing may never alter the observed: a
 * sink that throws on every single call must leave the run's answer, and any
 * exception already in flight, completely untouched.</p>
 */
class RuntimeObservationTest {

    /** The whole record stream, in emission order, exactly as a file would see it. */
    private final List<Map<String, Object>> records = new ArrayList<>();

    private final Consumer<Map<String, Object>> collecting = records::add;

    private Logger logger;
    private Level before;
    private ListAppender<ILoggingEvent> warnings;

    @BeforeEach
    void captureWarnings() {
        logger = (Logger) LoggerFactory.getLogger(CompiledGraph.class);
        before = logger.getLevel();
        logger.setLevel(Level.WARN);
        warnings = new ListAppender<>();
        warnings.start();
        logger.addAppender(warnings);
    }

    @AfterEach
    void releaseLogger() {
        logger.detachAppender(warnings);
        logger.setLevel(before);
    }

    private List<String> types() {
        return records.stream().map(record -> (String) record.get("type")).toList();
    }

    private List<Map<String, Object>> ofType(String type) {
        return records.stream().filter(record -> type.equals(record.get("type"))).toList();
    }

    private static StateGraph linear() {
        return new StateGraph(StateSchema.of(Channel.lastWriteWins("note")))
                .addNode("a", state -> StateUpdate.of("note", "from a"))
                .addNode("b", state -> StateUpdate.of("note", "from b"))
                .addEdge(StateGraph.START, "a")
                .addEdge("a", "b")
                .addEdge("b", StateGraph.END);
    }

    /** Ten records: the drawing, the two ends, three arrows and two node pairs. */
    private static final int LINEAR_RECORD_COUNT = 10;

    // -- opt-in ----------------------------------------------------------------- //

    @Test
    void aGraphCompiledWithoutASinkAnswersExactlyAsItAlwaysDid() throws Exception {
        CompiledGraph unobserved = linear().compile();
        CompiledGraph observed = linear().compile(collecting);

        GraphState quiet = unobserved.invoke(Map.of("note", "seed"));
        GraphState watched = observed.invoke(Map.of("note", "seed"));

        assertEquals(quiet, watched);
        assertEquals(0, unobserved.sinkFailures());
        assertEquals(LINEAR_RECORD_COUNT, records.size(), types().toString());
    }

    @Test
    void theDrawingReachesTheSinkAtCompileTimeBeforeAnyNodeHasRun() {
        linear().compile(collecting);

        assertEquals(List.of("graph_topology"), types());
    }

    // -- the order the light walks in ------------------------------------------- //

    @Test
    void oneRunEmitsItsLifecycleInTheOrderAReaderWalksIt() throws Exception {
        linear().compile(collecting).invoke(Map.of());

        assertEquals(List.of("graph_topology", "graph_start",
                "edge_taken", "node_start", "node_end",
                "edge_taken", "node_start", "node_end",
                "edge_taken", "graph_end"), types());
    }

    @Test
    void anEdgeCarriesTheSuperstepItLeadsIntoAndTheOneIntoEndIsWalkedToo() throws Exception {
        linear().compile(collecting).invoke(Map.of());

        List<Map<String, Object>> edges = ofType("edge_taken");
        assertEquals(List.of("__start__", "a", "b"),
                edges.stream().map(edge -> edge.get("from")).toList());
        assertEquals(List.of("a", "b", "__end__"),
                edges.stream().map(edge -> edge.get("to")).toList());
        assertEquals(List.of(0, 1, 2),
                edges.stream().map(edge -> edge.get("superstep")).toList());

        // The arrow into a frontier is recorded BEFORE that frontier lights up.
        assertEquals(List.of(0, 1),
                ofType("node_start").stream().map(record -> record.get("superstep")).toList());
    }

    @Test
    void graphEndCountsTheSuperstepsARecursionLimitIsMeasuredAgainst() throws Exception {
        linear().compile(collecting).invoke(Map.of());

        assertEquals(2, ofType("graph_end").get(0).get("steps"));
    }

    @Test
    void everyRecordOfOneRunCarriesThatRunsIdAndTheDrawingCarriesNone() throws Exception {
        CompiledGraph graph = linear().compile(collecting);
        graph.invoke(Map.of());
        graph.invoke(Map.of());

        assertFalse(records.get(0).containsKey("runId"), "a drawing belongs to no single run");
        LinkedHashSet<Object> runs = new LinkedHashSet<>(records.stream().skip(1)
                .map(record -> record.get("runId")).toList());
        assertEquals(2, runs.size(), "two runs, two ids: " + runs);
        runs.forEach(run -> assertEquals(12, ((String) run).length()));
    }

    @Test
    void aConditionalEdgeIsRecordedUnderTheBranchNamedAfterItsSource() throws Exception {
        new StateGraph(StateSchema.of(Channel.lastWriteWins("note")))
                .addNode("router", state -> null)
                .addNode("web", state -> null)
                .addConditionalEdges("router", state -> "web", List.of("web", StateGraph.END))
                .addEdge(StateGraph.START, "router")
                .addEdge("web", StateGraph.END)
                .compile(collecting)
                .invoke(Map.of());

        Map<String, Object> conditional = ofType("edge_taken").get(1);
        assertEquals("router", conditional.get("branch"));
        assertEquals("web", conditional.get("to"));
        assertFalse(ofType("edge_taken").get(0).containsKey("branch"),
                "a direct edge has no branch key at all");
    }

    // -- what a node wrote ------------------------------------------------------- //

    @Test
    void nodeEndRecordsTheShapeOfTheWriteAndNoneOfItsValues() throws Exception {
        new StateGraph(StateSchema.of(Channel.lastWriteWins("answer")))
                .addNode("generate", state -> StateUpdate.of("answer", "the confidential answer"))
                .addEdge(StateGraph.START, "generate")
                .addEdge("generate", StateGraph.END)
                .compile(collecting)
                .invoke(Map.of());

        Map<String, Object> end = ofType("node_end").get(0);
        assertEquals(List.of("answer"), end.get("updateKeys"));
        assertEquals("{\"answer\":\"the confidential answer\"}"
                .getBytes(StandardCharsets.UTF_8).length, end.get("updateBytes"));
        assertFalse(records.toString().contains("confidential"), "no values in the lifecycle file");
    }

    @Test
    void aNodeThatWroteNothingStillReportsAnEmptyWrite() throws Exception {
        new StateGraph(StateSchema.of(Channel.lastWriteWins("note")))
                .addNode("noop", state -> null)
                .addEdge(StateGraph.START, "noop")
                .addEdge("noop", StateGraph.END)
                .compile(collecting)
                .invoke(Map.of());

        Map<String, Object> end = ofType("node_end").get(0);
        assertEquals(List.of(), end.get("updateKeys"));
        assertEquals(0, end.get("updateBytes"));
    }

    // -- failure ----------------------------------------------------------------- //

    @Test
    void aFailingNodeIsRecordedAndItsOwnExceptionReachesTheCallerUnchanged() {
        IllegalStateException boom = new IllegalStateException("empty corpus");
        CompiledGraph graph = new StateGraph(StateSchema.of(Channel.lastWriteWins("note")))
                .addNode("grade", state -> {
                    throw boom;
                })
                .addEdge(StateGraph.START, "grade")
                .addEdge("grade", StateGraph.END)
                .compile(collecting);

        assertSame(boom, assertThrows(IllegalStateException.class, () -> graph.invoke(Map.of())));

        assertEquals(List.of("graph_topology", "graph_start", "edge_taken", "node_start",
                "node_error", "graph_end"), types());
        Map<String, Object> failure = ofType("node_error").get(0);
        assertEquals("IllegalStateException", failure.get("error"));
        assertEquals("empty corpus", failure.get("message"));
        assertEquals(0, failure.get("superstep"));
    }

    @Test
    void graphEndIsWrittenEvenWhenTheCeilingIsReached() {
        CompiledGraph graph = new StateGraph(StateSchema.of(Channel.lastWriteWins("note")))
                .addNode("spin", state -> null)
                .addEdge(StateGraph.START, "spin")
                .addEdge("spin", "spin")
                .compile(collecting);

        assertThrows(GraphRecursionException.class,
                () -> graph.invoke(GraphState.empty(), RunConfig.defaults().withRecursionLimit(3)));

        assertEquals(1, ofType("graph_end").size());
        assertEquals(3, ofType("graph_end").get(0).get("steps"));
    }

    // -- observing may not alter the observed ------------------------------------ //

    @Test
    void aSinkThatThrowsOnEveryCallLeavesTheRunsAnswerUntouched() throws Exception {
        CompiledGraph graph = linear().compile(record -> {
            throw new IllegalStateException("the disk is full");
        });

        GraphState state = graph.invoke(Map.of("note", "seed"));

        assertEquals("from b", state.get("note"));
        assertEquals(LINEAR_RECORD_COUNT, graph.sinkFailures());
    }

    @Test
    void theFirstSinkFailureWarnsOncePerGraphAndEveryOneIsCounted() throws Exception {
        CompiledGraph graph = linear().compile(record -> {
            throw new IllegalStateException("the disk is full");
        });

        graph.invoke(Map.of());
        graph.invoke(Map.of());

        assertEquals(2 * LINEAR_RECORD_COUNT - 1, graph.sinkFailures(),
                "the drawing is written once, at compile time");
        assertEquals(1, warnings.list.size(), "warning per record would bury the run in noise");
        assertTrue(warnings.list.get(0).getFormattedMessage().contains("the disk is full"));
    }

    @Test
    void aSinkFailureNeverReplacesTheExceptionAlreadyInFlight() {
        IllegalStateException boom = new IllegalStateException("Boom: the real failure");
        CompiledGraph graph = new StateGraph(StateSchema.of(Channel.lastWriteWins("note")))
                .addNode("grade", state -> {
                    throw boom;
                })
                .addEdge(StateGraph.START, "grade")
                .addEdge("grade", StateGraph.END)
                .compile(record -> {
                    throw new java.io.UncheckedIOException(new java.io.IOException("no space left"));
                });

        Exception raised = assertThrows(Exception.class, () -> graph.invoke(Map.of()));

        assertSame(boom, raised, "graph_end comes from a finally and must not overwrite the failure");
    }

    @Test
    void aSinkClosedUnderALiveGraphIsJustASinkThatRaises(@TempDir Path directory) throws Exception {
        GraphArtifact artifact = new GraphArtifact(directory.resolve("run.jsonl"));
        CompiledGraph graph = linear().compile(artifact);

        graph.invoke(Map.of());
        artifact.close();
        GraphState state = graph.invoke(Map.of("note", "seed"));

        assertEquals("from b", state.get("note"));
        assertEquals(LINEAR_RECORD_COUNT - 1, graph.sinkFailures());
        assertEquals(LINEAR_RECORD_COUNT,
                Files.readAllLines(artifact.path(), StandardCharsets.UTF_8).size(),
                "the first run is complete on disk; the runtime never reopens what it did not open");
    }

    // -- the two files, and the order across them --------------------------------- //

    @Test
    void thePolicyLandsImmediatelyAfterGraphStartAndOncePerRun() throws Exception {
        CompiledGraph graph = linear().compile(collecting, StatePolicy.sample());

        graph.invoke(Map.of());
        graph.invoke(Map.of());

        List<String> types = types();
        assertEquals(2, ofType("state_policy").size(), "one policy per run, never more");
        for (int index = 0; index < types.size(); index++) {
            if ("graph_start".equals(types.get(index))) {
                assertEquals("state_policy", types.get(index + 1),
                        "a reader meeting a payload must find its run's policy above it");
            }
        }
        assertEquals(records.stream().filter(r -> "graph_start".equals(r.get("type")))
                        .map(r -> r.get("runId")).toList(),
                ofType("state_policy").stream().map(r -> r.get("runId")).toList());
    }

    @Test
    void aPayloadFollowsTheNodeEndItBelongsTo() throws Exception {
        linear().compile(collecting, StatePolicy.full(true)).invoke(Map.of());

        List<String> types = types();
        assertEquals(2, ofType("state_payload").size());
        for (int index = 0; index < types.size(); index++) {
            if (!"state_payload".equals(types.get(index))) {
                continue;
            }
            Map<String, Object> payload = records.get(index);
            Map<String, Object> end = records.get(index - 1);
            assertEquals("node_end", end.get("type"), "a payload comes AFTER its node_end");
            assertEquals(end.get("node"), payload.get("node"));
            assertEquals(end.get("superstep"), payload.get("superstep"));
            assertEquals(end.get("runId"), payload.get("runId"));
        }
    }

    @Test
    void noPolicyMeansNoStateRecordAtAll() throws Exception {
        linear().compile(collecting).invoke(Map.of());

        assertEquals(List.of(), ofType("state_policy"));
        assertEquals(List.of(), ofType("state_payload"));
    }

    @Test
    void policyOffBuildsNothingBecauseNothingIsTheDefault() throws Exception {
        linear().compile(collecting, StatePolicy.off()).invoke(Map.of());

        assertEquals(List.of(), ofType("state_policy"));
        assertEquals(List.of(), ofType("state_payload"));
    }

    @Test
    void theTwoFilesSplitOneStreamAndNeitherHoldsTheOthersWords(@TempDir Path directory)
            throws Exception {
        Path stem = directory.resolve("run.jsonl");
        try (GraphArtifact lifecycle = new GraphArtifact(stem);
             StateArtifact values = new StateArtifact(stem)) {
            // The fan-out needs no class: each file refuses the other's vocabulary,
            // so the refusal IS the routing.
            linear().compile(record -> {
                lifecycle.accept(record);
                values.accept(record);
            }, StatePolicy.full(true)).invoke(Map.of());
        }

        List<String> lifecycleLines = Files.readAllLines(ArtifactPaths.graph(stem),
                StandardCharsets.UTF_8);
        List<String> valueLines = Files.readAllLines(ArtifactPaths.state(stem),
                StandardCharsets.UTF_8);

        assertEquals(LINEAR_RECORD_COUNT, lifecycleLines.size());
        assertEquals(3, valueLines.size(), "one policy and two payloads");
        assertTrue(valueLines.get(0).startsWith("{\"type\":\"state_policy\","));
        assertTrue(valueLines.get(1).contains("\"node\":\"a\""));
        assertTrue(valueLines.get(2).contains("\"node\":\"b\""));
        assertFalse(String.join("\n", lifecycleLines).contains("from a"),
                "the file people attach to a bug report never holds a caller's values");
        assertTrue(String.join("\n", valueLines).contains("from a"));
    }

    @Test
    void aRunWithNoPolicyNeverOpensAStateFile(@TempDir Path directory) throws Exception {
        Path stem = directory.resolve("run.jsonl");
        try (GraphArtifact lifecycle = new GraphArtifact(stem)) {
            linear().compile(lifecycle).invoke(Map.of());
        }

        assertFalse(Files.exists(ArtifactPaths.state(stem)),
                "not even as a zero-byte file, which every reader would misread");
    }

    @Test
    void twoRunsAgainstOneFileStayTellableApart(@TempDir Path directory) throws Exception {
        Path stem = directory.resolve("run.jsonl");
        try (GraphArtifact lifecycle = new GraphArtifact(stem)) {
            CompiledGraph graph = linear().compile(lifecycle);
            graph.invoke(Map.of());
            graph.invoke(Map.of());
        }

        List<String> lines = Files.readAllLines(ArtifactPaths.graph(stem), StandardCharsets.UTF_8);
        assertEquals(2 * LINEAR_RECORD_COUNT - 1, lines.size());
        List<String> starts = lines.stream().filter(line -> line.contains("\"graph_start\"")).toList();
        assertEquals(2, starts.size());
        assertNotEquals(starts.get(0), starts.get(1));
    }

    // -- thread identity, from the caller's map to the wire ----------------------- //
    //
    // The record builder's own omit-when-null rule is already pinned in
    // GraphRecordsTest. What these pin is the wiring between the two: that the
    // runtime reads configurable.thread_id and hands THAT to the builder. A
    // CompiledGraph.threadId gutted to `return null` left all 163 graph tests
    // green, which made a shipped, documented field deletable in silence.
    //
    // Since the checkpointer arrived, the identity reaches the wire only on a
    // graph compiled WITH one (harvested rule 103) — these runs therefore carry
    // an InMemorySaver. They were rewritten from the placeholder era exactly as
    // the placeholder's Javadoc said they would be; the checkpointer-less half
    // of the predicate is pinned in ThreadMemoryTest.

    private static RunConfig addressedAs(Object threadId) {
        return RunConfig.defaults().withConfigurable(Map.of("thread_id", threadId));
    }

    private Map<String, Object> start() {
        assertEquals(1, ofType("graph_start").size());
        return ofType("graph_start").get(0);
    }

    @Test
    void theCallersThreadIdReachesGraphStartVerbatim() throws Exception {
        linear().compile(new InMemorySaver(), collecting)
                .invoke(GraphState.empty(), addressedAs("t-9f3c"));

        assertEquals("t-9f3c", start().get("threadId"));
    }

    @Test
    void aThreadIdIsNeverConfusedWithTheRunIdTheRuntimeMintsItself() throws Exception {
        linear().compile(new InMemorySaver(), collecting)
                .invoke(GraphState.empty(), addressedAs("t-9f3c"));

        assertNotEquals(start().get("runId"), start().get("threadId"),
                "the run is minted here, the thread comes from the caller");
    }

    @Test
    void twoRunsOnOneThreadCarryOneThreadIdAndTwoRunIds() throws Exception {
        CompiledGraph graph = linear().compile(new InMemorySaver(), collecting);

        graph.invoke(GraphState.empty(), addressedAs("t-same"));
        graph.invoke(GraphState.empty(), addressedAs("t-same"));

        List<Map<String, Object>> starts = ofType("graph_start");
        assertEquals(2, starts.size());
        assertEquals(List.of("t-same", "t-same"),
                starts.stream().map(record -> record.get("threadId")).toList());
        assertNotEquals(starts.get(0).get("runId"), starts.get(1).get("runId"),
                "joining a conversation back together needs the two to differ");
    }

    @Test
    void aRunThatNamedNoThreadOmitsTheKeyRatherThanWritingNull() throws Exception {
        linear().compile(collecting).invoke(GraphState.empty(), RunConfig.defaults());

        assertFalse(start().containsKey("threadId"), start().toString());
    }

    @Test
    void anAddressingMapWithoutAThreadIdOmitsTheKeyToo() throws Exception {
        linear().compile(collecting).invoke(GraphState.empty(),
                RunConfig.defaults().withConfigurable(Map.of("user_id", "u-1")));

        assertFalse(start().containsKey("threadId"), start().toString());
    }

    @Test
    void aThreadIdIsCarriedVERBATIM_notNormalised() throws Exception {
        // A surviving mutation found this hole: lower-casing and trimming the id
        // left every other thread test green. A thread_id is an identifier the
        // caller will look up again, so folding its case or eating its spaces
        // silently breaks the join and nothing here would have noticed.
        String awkward = "  Thread-ID_MiXeD  ";
        List<Map<String, Object>> seen = new ArrayList<>();
        linear().compile(new InMemorySaver(), seen::add).invoke(GraphState.empty(),
                RunConfig.defaults().withConfigurable(Map.of("thread_id", awkward)));

        Map<String, Object> start = seen.stream()
                .filter(r -> "graph_start".equals(r.get("type")))
                .findFirst().orElseThrow();
        assertEquals(awkward, start.get("threadId"),
                "the caller's id reaches the wire byte for byte — no trim, no case fold");
    }

    @Test
    void aThreadIdThatArrivedAsANumberIsWrittenAsItsText() throws Exception {
        linear().compile(new InMemorySaver(), collecting)
                .invoke(GraphState.empty(), addressedAs(4711));

        assertEquals("4711", start().get("threadId"),
                "configurable is an untyped map; the wire field stays a string");
    }

    @Test
    void aThreadIdSurvivesIntoTheFileAReaderActuallyOpens(@TempDir Path directory)
            throws Exception {
        Path stem = directory.resolve("run.jsonl");
        try (GraphArtifact lifecycle = new GraphArtifact(stem)) {
            linear().compile(new InMemorySaver(), lifecycle)
                    .invoke(GraphState.empty(), addressedAs("t-on-disk"));
        }

        List<String> lines = Files.readAllLines(ArtifactPaths.graph(stem), StandardCharsets.UTF_8);
        String line = lines.stream().filter(text -> text.contains("\"graph_start\"")).findFirst()
                .orElseThrow();

        assertTrue(line.contains("\"threadId\":\"t-on-disk\""), line);
    }
}
