package dev.spectroscope.core.graph;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The seven lifecycle builders, measured against the 37 lines of
 * {@code docs/graph-view-reference/crag-payload.graph.jsonl}.
 *
 * <p>The reference file is the oracle rather than this test's own opinion: every
 * line it holds is parsed, handed back to the builder that would have produced
 * it, and the result compared as BYTES. Key order, the omitted-null rule, the
 * absence of a space after any separator and the raw non-ASCII are then all
 * pinned by one assertion each rather than by a hand-written expectation that
 * could drift away from the file a viewer actually reads.</p>
 */
class GraphRecordsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** The 37 lines of ground truth, found by walking up from the module. */
    private static List<String> referenceLines() throws IOException {
        Path here = Path.of("").toAbsolutePath();
        for (int up = 0; up < 6 && here != null; up++, here = here.getParent()) {
            Path candidate = here.resolve("docs/graph-view-reference/crag-payload.graph.jsonl");
            if (Files.isRegularFile(candidate)) {
                return Files.readAllLines(candidate, StandardCharsets.UTF_8).stream()
                        .filter(line -> !line.isBlank()).toList();
            }
        }
        throw new IOException("the reference artifact was not found above " + Path.of("").toAbsolutePath());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> parse(String line) throws IOException {
        return MAPPER.readValue(line, Map.class);
    }

    /** The line a sink would write for this record — the same path a run takes. */
    private static String written(Map<String, Object> record) {
        return GraphJson.line(GraphJson.ordered(record, 0L));
    }

    private static long ts(Map<String, Object> parsed) {
        return ((Number) parsed.get("ts")).longValue();
    }

    private static String runId(Map<String, Object> parsed) {
        return (String) parsed.get("runId");
    }

    private static int intOf(Map<String, Object> parsed, String key) {
        return ((Number) parsed.get(key)).intValue();
    }

    @SuppressWarnings("unchecked")
    private static Topology topologyOf(Map<String, Object> parsed) {
        List<Topology.Node> nodes = new ArrayList<>();
        for (Map<String, Object> node : (List<Map<String, Object>>) parsed.get("nodes")) {
            nodes.add(new Topology.Node((String) node.get("id"), (String) node.get("label")));
        }
        List<Topology.Edge> edges = new ArrayList<>();
        for (Map<String, Object> edge : (List<Map<String, Object>>) parsed.get("edges")) {
            edges.add(new Topology.Edge((String) edge.get("from"), (String) edge.get("to"),
                    (String) edge.get("kind"), (String) edge.get("branch")));
        }
        List<Topology.Branch> branches = new ArrayList<>();
        for (Map<String, Object> branch : (List<Map<String, Object>>) parsed.get("branches")) {
            branches.add(new Topology.Branch((String) branch.get("name"), (String) branch.get("source"),
                    (List<String>) branch.get("targets")));
        }
        return new Topology(intOf(parsed, "schema_version"), (String) parsed.get("entry"),
                nodes, edges, branches);
    }

    /**
     * The one field of the reference that cannot be reconstructed: the update
     * itself is not in the lifecycle file, by design, so its true size is not
     * either. Everything around it still has to land byte for byte.
     */
    private static String withoutUpdateBytes(String line) {
        return line.replaceAll("\"updateBytes\":\\d+", "\"updateBytes\":*");
    }

    // -- the reference file, line by line -------------------------------------- //

    @Test
    void everyReferenceLineIsRebuiltByItsBuilder() throws Exception {
        List<String> lines = referenceLines();
        assertEquals(37, lines.size(), "the reference artifact is 37 lines of ground truth");

        Map<String, Integer> seen = new LinkedHashMap<>();
        for (String line : lines) {
            Map<String, Object> parsed = parse(line);
            String type = (String) parsed.get("type");
            seen.merge(type, 1, Integer::sum);

            String rebuilt = switch (type) {
                case "graph_topology" ->
                        written(GraphRecords.graphTopology(topologyOf(parsed), ts(parsed)));
                case "graph_start" ->
                        written(GraphRecords.graphStart(runId(parsed), null, ts(parsed)));
                case "node_start" -> written(GraphRecords.nodeStart(runId(parsed),
                        (String) parsed.get("node"), intOf(parsed, "superstep"), ts(parsed)));
                case "node_end" -> {
                    // The keys are ground truth; the values behind them are not in
                    // this file at all, which is the promise the file is kept for.
                    LinkedHashMap<String, Object> update = new LinkedHashMap<>();
                    for (Object key : (List<?>) parsed.get("updateKeys")) {
                        update.put((String) key, "x");
                    }
                    yield withoutUpdateBytes(written(GraphRecords.nodeEnd(runId(parsed),
                            (String) parsed.get("node"), intOf(parsed, "superstep"),
                            intOf(parsed, "durationMs"), update, ts(parsed))));
                }
                case "edge_taken" -> written(GraphRecords.edgeTaken(runId(parsed),
                        (String) parsed.get("from"), (String) parsed.get("to"),
                        (String) parsed.get("branch"), intOf(parsed, "superstep"), ts(parsed)));
                case "graph_end" -> written(GraphRecords.graphEnd(runId(parsed),
                        intOf(parsed, "steps"), (long) intOf(parsed, "durationMs"), ts(parsed)));
                default -> throw new AssertionError("unknown record type " + type);
            };

            String expected = "node_end".equals(type) ? withoutUpdateBytes(line) : line;
            assertEquals(expected, rebuilt, "rebuilt line differs for a " + type);
        }

        assertEquals(Map.of("graph_topology", 1, "graph_start", 1, "node_start", 11,
                "node_end", 11, "edge_taken", 12, "graph_end", 1), seen);
    }

    // -- graph_topology --------------------------------------------------------- //

    @Test
    void theTopologyRecordWrapsAndNeverReinterpretsAKey() {
        Topology topology = new StateGraph(StateSchema.of(Channel.lastWriteWins("x")))
                .addNode("a", state -> null)
                .addEdge(StateGraph.START, "a")
                .addEdge("a", StateGraph.END)
                .compile()
                .topology();

        String line = written(GraphRecords.graphTopology(topology, 7L));

        assertTrue(line.startsWith("{\"type\":\"graph_topology\",\"schema_version\":1,"), line);
        assertFalse(line.contains("schemaVersion"), "the topology owns its own snake_case key");
        assertFalse(line.contains("runId"), "a drawing belongs to no single run");
        assertTrue(line.endsWith(",\"ts\":7}"), line);
    }

    // -- graph_start / graph_end ------------------------------------------------ //

    @Test
    void aThreadIdIsOmittedEntirelyWhenThereIsNone() {
        assertEquals("{\"type\":\"graph_start\",\"runId\":\"r\",\"ts\":7}",
                written(GraphRecords.graphStart("r", null, 7L)));
        assertEquals("{\"type\":\"graph_start\",\"runId\":\"r\",\"threadId\":\"t\",\"ts\":7}",
                written(GraphRecords.graphStart("r", "t", 7L)));
    }

    @Test
    void aGraphEndWithoutADurationOmitsIt() {
        assertEquals("{\"type\":\"graph_end\",\"runId\":\"r\",\"steps\":2,\"ts\":7}",
                written(GraphRecords.graphEnd("r", 2, null, 7L)));
    }

    // -- node_end --------------------------------------------------------------- //

    @Test
    void aNodeThatWroteNothingStillSaysSoWithAnEmptyListAndAZero() {
        String line = written(GraphRecords.nodeEnd("r", "noop", 1, 0, null, 7L));

        assertTrue(line.contains("\"updateKeys\":[],\"updateBytes\":0"), line);
    }

    @Test
    void updateKeysAreInTheNodesOwnWriteOrderAndNeverSorted() {
        LinkedHashMap<String, Object> update = new LinkedHashMap<>();
        update.put("zebra", 1);
        update.put("alpha", 2);

        assertTrue(written(GraphRecords.nodeEnd("r", "n", 1, 0, update, 7L))
                .contains("\"updateKeys\":[\"zebra\",\"alpha\"]"));
    }

    @Test
    void updateBytesIsTheTrueSerializedSizeOfTheWholeUpdate() {
        LinkedHashMap<String, Object> update = new LinkedHashMap<>();
        update.put("docs", List.of(1, 2));
        update.put("trace", List.of("x"));

        assertEquals("{\"docs\":[1,2],\"trace\":[\"x\"]}".getBytes(StandardCharsets.UTF_8).length,
                GraphRecords.nodeEnd("r", "retrieve", 2, 41, update, 7L).get("updateBytes"));
    }

    @Test
    void measuringAValueThatCannotBeDescribedNeverTakesTheRunDown() {
        Object hostile = new Object() {
            @Override
            public String toString() {
                throw new IllegalStateException("no");
            }
        };
        Map<String, Object> record = GraphRecords.nodeEnd("r", "n", 0, 0,
                Map.of("boom", hostile), 7L);

        assertTrue(record.get("updateBytes") instanceof Integer, "a size, not an exception");
    }

    @Test
    void aNodeEndCarriesNoneOfTheValuesItMeasured() {
        Map<String, Object> update = Map.of("secret", "sk-proj-AbCdEf0123456789XyZwVu");

        assertFalse(written(GraphRecords.nodeEnd("r", "n", 0, 0, update, 7L))
                .contains("sk-proj"), "the lifecycle file is the one you attach to a bug report");
    }

    // -- node_error ------------------------------------------------------------- //

    @Test
    void theErrorClassAndTheMessageAreSeparateFields() {
        Map<String, Object> record = GraphRecords.nodeError("r", "grade", 3,
                new IllegalArgumentException("empty corpus"), null, 7L);

        assertEquals("IllegalArgumentException", record.get("error"));
        assertEquals("empty corpus", record.get("message"));
        assertEquals("{\"type\":\"node_error\",\"runId\":\"r\",\"node\":\"grade\",\"superstep\":3,"
                + "\"error\":\"IllegalArgumentException\",\"message\":\"empty corpus\",\"ts\":7}",
                written(record));
    }

    @Test
    void aPlainStringFailureIsRecordedUnderTheLiteralClassError() {
        Map<String, Object> record = GraphRecords.nodeError("r", "n", 0, "went wrong", 12L, 7L);

        assertEquals("Error", record.get("error"));
        assertEquals("went wrong", record.get("message"));
        assertEquals(12L, ((Number) record.get("durationMs")).longValue());
    }

    @Test
    void anOverLongMessageIsCutToAThousandAndSaysSoWithOneEllipsis() {
        String flood = "x".repeat(5000);
        String message = (String) GraphRecords
                .nodeError("r", "n", 0, new IllegalStateException(flood), null, 7L).get("message");

        assertEquals(1001, message.length());
        assertTrue(message.endsWith("…"));
        assertEquals(1, message.chars().filter(point -> point == '…').count());
    }

    @Test
    void anExceptionWithoutAMessageStillCarriesItsClass() {
        Map<String, Object> record = GraphRecords.nodeError("r", "n", 0,
                new IllegalStateException(), null, 7L);

        assertEquals("IllegalStateException", record.get("error"));
        assertNotNull(record.get("message"), "a message field that is null would be dropped entirely");
    }

    // -- edge_taken ------------------------------------------------------------- //

    @Test
    void aDirectEdgeCarriesNoBranchKeyAtAll() {
        assertEquals("{\"type\":\"edge_taken\",\"runId\":\"r\",\"from\":\"a\",\"to\":\"b\","
                        + "\"superstep\":1,\"ts\":7}",
                written(GraphRecords.edgeTaken("r", "a", "b", null, 1, 7L)));
    }

    @Test
    void aConditionalEdgeIsNamedAfterItsSourceNode() {
        assertEquals("{\"type\":\"edge_taken\",\"runId\":\"r\",\"from\":\"grade\",\"to\":\"web\","
                        + "\"branch\":\"grade#2\",\"superstep\":4,\"ts\":7}",
                written(GraphRecords.edgeTaken("r", "grade", "web", "grade#2", 4, 7L)));
    }

    // -- the dialect ------------------------------------------------------------ //

    @Test
    void nonAsciiGoesOutRawAndNoSeparatorEverCarriesASpace() {
        String line = written(GraphRecords.nodeError("r", "wartung", 0,
                new IllegalStateException("Wartungsfenster — Freigabe für Überlast"), null, 7L));

        assertTrue(line.contains("Wartungsfenster — Freigabe für Überlast"), line);
        assertFalse(line.contains("\\u"), "non-ASCII is raw, never escaped");
        assertFalse(line.contains(", ") || line.contains(": "), "compact separators");
    }

    @Test
    void everyBuilderPutsTypeFirstAndTsLast() {
        List<Map<String, Object>> every = List.of(
                GraphRecords.graphStart("r", "t", 7L),
                GraphRecords.nodeStart("r", "n", 0, 7L),
                GraphRecords.nodeEnd("r", "n", 0, 1, Map.of("a", 1), 7L),
                GraphRecords.nodeError("r", "n", 0, new IllegalStateException("x"), 1L, 7L),
                GraphRecords.edgeTaken("r", "a", "b", "a", 1, 7L),
                GraphRecords.graphEnd("r", 2, 3L, 7L));

        for (Map<String, Object> record : every) {
            List<String> keys = List.copyOf(record.keySet());
            assertEquals("type", keys.get(0), record.toString());
            assertEquals("ts", keys.get(keys.size() - 1), record.toString());
        }
    }
}
