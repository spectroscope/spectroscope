package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The two files and the wall between them.
 *
 * <p>{@code .graph.jsonl} is the file people attach to bug reports, so it never
 * holds a caller's values. That is enforced at the writer, not at a call site,
 * and the refusal is COUNTED — a silently ignored record and a correctly empty
 * file look the same afterwards.</p>
 */
class ArtifactSinkTest {

    private static Map<String, Object> record(Object... pairs) {
        LinkedHashMap<String, Object> built = new LinkedHashMap<>();
        for (int index = 0; index < pairs.length; index += 2) {
            built.put((String) pairs[index], pairs[index + 1]);
        }
        return built;
    }

    // -- the wall ------------------------------------------------------------- //

    @Test
    void theGraphFileRefusesAStatePayloadAndCountsIt(@TempDir Path directory) throws Exception {
        Path path = directory.resolve("run.graph.jsonl");
        byte[] before;
        try (GraphArtifact artifact = new GraphArtifact(path)) {
            artifact.accept(record("type", "graph_start", "runId", "r", "ts", 1L));
            before = Files.readAllBytes(path);

            artifact.accept(StateRecords.statePayload("n", 0, Map.of("answer", "secret"),
                    StatePolicy.sample(), "r", 2L));
            artifact.accept(StateRecords.statePolicy(StatePolicy.sample(), "r", 3L));

            assertEquals(2, artifact.refused());
        }
        assertArrayEquals(before, Files.readAllBytes(path), "the file is unchanged byte for byte");
        assertFalse(new String(before, StandardCharsets.UTF_8).contains("secret"));
    }

    @Test
    void theStateFileRefusesLifecycleRecordsAndCountsThem(@TempDir Path directory) throws Exception {
        Path path = directory.resolve("run.state.jsonl");
        try (StateArtifact artifact = new StateArtifact(path)) {
            artifact.accept(record("type", "node_end", "node", "n", "ts", 1L));
            artifact.accept(record("type", "graph_topology", "ts", 1L));
            artifact.accept(record("type", "made_up", "ts", 1L));

            assertEquals(3, artifact.refused(), "the split only holds if it holds from both sides");
        }
        assertEquals(0, Files.readAllLines(path).size());
    }

    // -- the dialect ---------------------------------------------------------- //

    @Test
    void theSinkOrdersAHandBuiltRecordItself(@TempDir Path directory) throws Exception {
        Path path = directory.resolve("run.state.jsonl");
        try (StateArtifact artifact = new StateArtifact(path)) {
            artifact.accept(record("ts", 42L, "node", "n", "type", "state_payload"));
        }

        assertEquals("{\"type\":\"state_payload\",\"node\":\"n\",\"ts\":42}",
                Files.readString(path).strip(),
                "the runtime may build a record by hand, so the guarantee belongs to the writer");
    }

    @Test
    void aMissingTimestampIsStampedAndAGivenOneIsKept(@TempDir Path directory) throws Exception {
        Path path = directory.resolve("run.state.jsonl");
        long before = System.currentTimeMillis();
        try (StateArtifact artifact = new StateArtifact(path)) {
            artifact.accept(record("type", "state_payload", "node", "kept", "ts", 7L));
            artifact.accept(record("type", "state_payload", "node", "stamped"));
        }

        List<String> lines = Files.readAllLines(path);
        assertTrue(lines.get(0).endsWith(",\"ts\":7}"), lines.get(0));
        long stamped = Long.parseLong(lines.get(1).replaceAll(".*\"ts\":(\\d+)}$", "$1"));
        assertTrue(stamped >= before && stamped <= System.currentTimeMillis(),
                "a re-stamped timestamp would reorder a replay: " + stamped);
    }

    @Test
    void theLineIsCompactUtf8WithNonAsciiRaw(@TempDir Path directory) throws Exception {
        Path path = directory.resolve("run.state.jsonl");
        try (StateArtifact artifact = new StateArtifact(path)) {
            artifact.accept(StateRecords.statePayload("n", 0,
                    Map.of("answer", "Wartungsfenster — Freigabe"), StatePolicy.sample(), "r", 1L));
        }

        byte[] raw = Files.readAllBytes(path);
        String line = new String(raw, StandardCharsets.UTF_8);
        assertTrue(line.contains("Wartungsfenster — Freigabe"));
        assertFalse(line.contains("\\u"), "a \\u escape would make head -1 unreadable to a human");
        assertFalse(line.contains(", "), line);
        assertFalse(line.contains("\": "), line);
        assertTrue(indexOf(raw, "—".getBytes(StandardCharsets.UTF_8)) > 0, "the em dash goes out raw");
    }

    @Test
    void everyLineIsFlushedWithoutClosing(@TempDir Path directory) throws Exception {
        Path path = directory.resolve("run.state.jsonl");
        StateArtifact artifact = new StateArtifact(path);
        for (int index = 0; index < 3; index++) {
            artifact.accept(record("type", "state_payload", "node", "n" + index, "ts", 1L));
        }

        assertEquals(3, Files.readAllLines(path).size(),
                "the file a viewer is tailing is complete up to the moment of a crash");
        artifact.close();
    }

    @Test
    void bothFilesAppendSoOneStemCanHoldManyRuns(@TempDir Path directory) throws Exception {
        Path path = directory.resolve("run.state.jsonl");
        try (StateArtifact first = new StateArtifact(path)) {
            first.accept(record("type", "state_policy", "runId", "a", "ts", 1L));
        }
        try (StateArtifact second = new StateArtifact(path)) {
            second.accept(record("type", "state_policy", "runId", "b", "ts", 2L));
        }

        assertEquals(2, Files.readAllLines(path).size());
    }

    // -- the paths ------------------------------------------------------------ //

    @Test
    void theSuffixRuleIsIdempotentAcrossTheFamily() {
        assertEquals(Path.of("run.state.jsonl"), ArtifactPaths.state(Path.of("run.graph.jsonl")));
        assertEquals(Path.of("run.graph.jsonl"), ArtifactPaths.graph(Path.of("run.graph.jsonl")));
        assertEquals(Path.of("run.state.jsonl"), ArtifactPaths.state(Path.of("run.state.jsonl")));
        assertEquals(Path.of("20260810-session.state.jsonl"),
                ArtifactPaths.state(Path.of("20260810-session.jsonl")));
        assertEquals(Path.of("run.state.jsonl"), ArtifactPaths.state(Path.of("run.llm.jsonl")));
        assertEquals(Path.of("/tmp/run.state.jsonl"), ArtifactPaths.state(Path.of("/tmp/run")));
    }

    @Test
    void oneStemHandedToBothWritersLandsInTwoFiles(@TempDir Path directory) throws Exception {
        Path stem = directory.resolve("run.graph.jsonl");
        List<Path> written = new ArrayList<>();
        try (GraphArtifact graph = new GraphArtifact(stem); StateArtifact state = new StateArtifact(stem)) {
            written.add(graph.path());
            written.add(state.path());
        }

        assertEquals(List.of(directory.resolve("run.graph.jsonl"), directory.resolve("run.state.jsonl")),
                written);
    }

    private static int indexOf(byte[] haystack, byte[] needle) {
        outer:
        for (int start = 0; start <= haystack.length - needle.length; start++) {
            for (int offset = 0; offset < needle.length; offset++) {
                if (haystack[start + offset] != needle[offset]) {
                    continue outer;
                }
            }
            return start;
        }
        return -1;
    }
}
