package dev.spectroscope.core.graph;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Measured against the artifact on disk, not against a reading of the spec.
 *
 * <p>{@code docs/graph-view-reference/crag-payload.state.jsonl} is a real
 * {@code summary} run — eleven supersteps with one corrective-RAG rewrite cycle —
 * and it happens to exercise both absence reasons in one file: {@code docs} is
 * written and absent because it is not on the allow list, {@code principal} is
 * written and absent because it is denied. Every line here is rebuilt from its own
 * contents and compared BYTE for byte, which is the only way to pin field order,
 * key order, number formatting and escaping at once.</p>
 */
class StateWireReferenceTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String RUN = "bbf32a7d7199";

    private static List<String> lines;
    private static List<Map<String, Object>> records;

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void readTheReference() throws IOException {
        Path path = reference();
        lines = Files.readAllLines(path);
        records = new ArrayList<>();
        for (String line : lines) {
            records.add(JSON.readValue(line, LinkedHashMap.class));
        }
    }

    /** Walks up from the test's working directory so the file is found from any module. */
    private static Path reference() {
        Path here = Path.of("").toAbsolutePath();
        while (here != null) {
            Path candidate = here.resolve("docs/graph-view-reference/crag-payload.state.jsonl");
            if (Files.exists(candidate)) {
                return candidate;
            }
            here = here.getParent();
        }
        throw new IllegalStateException("the reference artifact is not on disk under "
                + Path.of("").toAbsolutePath());
    }

    @Test
    void theSummaryPolicyIsRebuiltByteForByte() {
        Map<String, Object> rebuilt = StateRecords.statePolicy(
                StatePolicy.summary(), RUN, (Long) records.get(0).get("ts"));

        assertEquals(lines.get(0), GraphJson.line(rebuilt));
    }

    @Test
    @SuppressWarnings("unchecked")
    void everyPayloadLineIsRebuiltByteForByte() {
        assertEquals(12, lines.size(), "one policy line and eleven supersteps");
        for (int index = 1; index < lines.size(); index++) {
            Map<String, Object> original = records.get(index);
            Map<String, Object> rebuilt = StateRecords.statePayload(
                    (String) original.get("node"),
                    (Integer) original.get("superstep"),
                    (Map<String, Object>) original.get("channels"),
                    StatePolicy.summary(),
                    RUN,
                    (Long) original.get("ts"));

            assertEquals(lines.get(index), GraphJson.line(rebuilt),
                    "line " + (index + 1) + " (" + original.get("node") + ")");
        }
    }

    @Test
    void aDeniedChannelAndAnUnallowedOneBothLeaveTheirLineUnchanged() {
        LinkedHashMap<String, Object> routerWrote = new LinkedHashMap<>();
        routerWrote.put("query_used", "How does a maintenance window get released, "
                + "and who has to sign it?");
        routerWrote.put("route", "retrieve");
        routerWrote.put("principal", "alice@example.com");
        routerWrote.put("trace", List.of("router: route=retrieve"));

        assertEquals(lines.get(1), GraphJson.line(StateRecords.statePayload(
                "router", 0, routerWrote, StatePolicy.summary(), RUN, 1786397375667L)),
                "principal is denied, so it never reaches the line");

        LinkedHashMap<String, Object> retrieveWrote = new LinkedHashMap<>();
        retrieveWrote.put("docs", List.of(Map.of("document_id", "document:ops-handbook-007")));
        retrieveWrote.put("trace", List.of("retrieve: 8 hits (top_k=8)"));

        assertEquals(lines.get(2), GraphJson.line(StateRecords.statePayload(
                "retrieve", 1, retrieveWrote, StatePolicy.summary(), RUN, 1786397375668L)),
                "docs is not on the allow list, which is a different absence and the same line");
    }

    @Test
    void noReferenceLineCarriesAnEmptyTruncatedArray() {
        for (String line : lines) {
            assertTrue(!line.contains("\"truncated\":[]"), line);
        }
    }

    @Test
    void theJoinKeyIsTheWholeTripleBecauseANodeEntersTwice() {
        LinkedHashSet<String> keys = new LinkedHashSet<>();
        for (int index = 1; index < records.size(); index++) {
            Map<String, Object> record = records.get(index);
            keys.add(record.get("runId") + "|" + record.get("node") + "|" + record.get("superstep"));
        }

        assertEquals(11, keys.size());
        assertTrue(keys.contains(RUN + "|retrieve|1") && keys.contains(RUN + "|retrieve|6"),
                "joining on the node name alone would show the second turn under the first");
    }

    @Test
    void everyReferenceLineIsCompactAndItsTypeComesFirst() {
        for (String line : lines) {
            assertTrue(line.startsWith("{\"type\":"), line);
            assertTrue(line.matches(".*,\"ts\":\\d+\\}$"), line.substring(line.length() - 40));
        }
    }
}
