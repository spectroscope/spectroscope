package dev.spectroscope.core.graph;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Reading the artifact family back — the counterpart of {@link GraphArtifact}
 * and {@link StateArtifact}, so writer and reader are pairwise checkable in ONE
 * language. Ported from the python edition's {@code load_graph_artifact},
 * {@code load_state_payloads} and {@code load_state_policies}.
 *
 * <p>Tolerant in exactly the way the reference is: blank lines, torn lines and
 * non-object lines are dropped without a word, because the common reason for a
 * torn line is a crash and the reader's job is to show what survived. A missing
 * FILE raises — an artifact that was never written is a different problem from
 * one that is empty, and that holds for the values file too: whether "recording
 * was off" is a normal absence is the caller's judgement, not the reader's.</p>
 */
public final class ArtifactReader {

    private static final ObjectMapper MAPPER = JsonMapper.builder().build();

    private ArtifactReader() {
    }

    /**
     * An artifact read back as the drawing and the runs that lit it up.
     *
     * @param topology the FIRST {@code graph_topology} of the file, or an empty
     *                 map when the file has none
     * @param records  every other record, in file order — a LATER topology stays
     *                 in here, so a viewer can see that the shape changed instead
     *                 of silently reading the wrong drawing
     */
    public record LoadedGraphArtifact(Map<String, Object> topology,
                                      List<Map<String, Object>> records) {
    }

    /**
     * The join key of the values file. Superstep is in it because a node can
     * enter twice in one run — a graph that sends {@code generate} back after
     * {@code verify} has two of them — and a reader joining on the node name
     * alone would show the second turn's values under the first turn's node. A
     * node runs at most once per superstep, so the key is unique even under
     * fan-out.
     */
    public record PayloadKey(String runId, String node, int superstep) {
    }

    /**
     * Reads the lifecycle file of {@code path}'s family back.
     *
     * @param path any path of the artifact family, or a bare session path — the
     *             same stem rule the writers use
     * @return the topology and the records, in file order
     * @throws IOException when the file does not exist or cannot be read
     */
    public static LoadedGraphArtifact loadGraphArtifact(Path path) throws IOException {
        Map<String, Object> topology = new LinkedHashMap<>();
        List<Map<String, Object>> records = new ArrayList<>();
        for (Map<String, Object> record : readRecords(ArtifactPaths.graph(path))) {
            if (topology.isEmpty() && "graph_topology".equals(record.get("type"))) {
                topology = record;
                continue;
            }
            records.add(record);
        }
        return new LoadedGraphArtifact(topology, records);
    }

    /**
     * Reads the values file back, keyed by {@code (runId, node, superstep)}.
     *
     * <p>A repeat writes over its earlier self: the file is append-mode, and the
     * last line is the one the run finished with.</p>
     *
     * @param path any path of the artifact family
     * @return the payload records, last write per key winning
     * @throws IOException when the file does not exist or cannot be read
     */
    public static Map<PayloadKey, Map<String, Object>> loadStatePayloads(Path path)
            throws IOException {
        Map<PayloadKey, Map<String, Object>> payloads = new LinkedHashMap<>();
        for (Map<String, Object> record : readRecords(ArtifactPaths.state(path))) {
            if (!"state_payload".equals(record.get("type"))) {
                continue;
            }
            payloads.put(new PayloadKey(
                    String.valueOf(record.getOrDefault("runId", "")),
                    String.valueOf(record.getOrDefault("node", "")),
                    supersteps(record.get("superstep"))), record);
        }
        return payloads;
    }

    /**
     * The policy each run in the file ran under, keyed by {@code runId} — the
     * half of the join that answers WHY a channel is missing. Without it a view
     * can only say a value is absent, which is the riddle the values layer
     * exists not to print.
     *
     * @param path any path of the artifact family
     * @return one policy record per run
     * @throws IOException when the file does not exist or cannot be read
     */
    public static Map<String, Map<String, Object>> loadStatePolicies(Path path)
            throws IOException {
        Map<String, Map<String, Object>> policies = new LinkedHashMap<>();
        for (Map<String, Object> record : readRecords(ArtifactPaths.state(path))) {
            if (!"state_policy".equals(record.get("type"))) {
                continue;
            }
            policies.put(String.valueOf(record.getOrDefault("runId", "")), record);
        }
        return policies;
    }

    /** Every parseable object line of the file, in order. */
    private static List<Map<String, Object>> readRecords(Path path) throws IOException {
        String text = Files.readString(path, StandardCharsets.UTF_8);
        List<Map<String, Object>> records = new ArrayList<>();
        for (String line : text.split("\n")) {
            String trimmed = line.strip();
            if (trimmed.isEmpty()) {
                continue;
            }
            Object parsed;
            try {
                parsed = MAPPER.readValue(trimmed, Object.class);
            } catch (IOException | RuntimeException torn) {
                continue;
            }
            if (parsed instanceof Map<?, ?> map) {
                LinkedHashMap<String, Object> record = new LinkedHashMap<>();
                map.forEach((key, value) -> record.put(String.valueOf(key), value));
                records.add(record);
            }
        }
        return records;
    }

    /** The python reference defaults a missing superstep to {@code -1}. */
    private static int supersteps(Object value) {
        return value instanceof Number number ? number.intValue() : -1;
    }
}
