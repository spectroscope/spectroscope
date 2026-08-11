package dev.spectroscope.core.graph;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * An in-memory sink for tests and exporters, ported from the python edition's
 * {@code ListSink}.
 *
 * <p>Every record is normalised exactly the way {@link JsonlArtifact} would
 * normalise it before writing — {@code type} first, {@code ts} last, stamped
 * when absent — so an assertion against this sink sees the same shape the file
 * would hold.</p>
 *
 * <p>The drawing lives on {@link #topology()} and the LATEST one wins — the
 * deliberate asymmetry with {@link ArtifactReader#loadGraphArtifact}, which
 * keeps the FIRST and leaves later ones visible among the records: a file is
 * history and a rebuilt drawing there is a fact worth seeing, while this sink
 * mirrors a living graph's current shape.</p>
 */
public final class ListSink implements Consumer<Map<String, Object>> {

    private Map<String, Object> topology;
    private final List<Map<String, Object>> records = new ArrayList<>();

    @Override
    public void accept(Map<String, Object> record) {
        Map<String, Object> ordered = GraphJson.ordered(record, System.currentTimeMillis());
        if ("graph_topology".equals(ordered.get("type"))) {
            topology = ordered;
            return;
        }
        records.add(ordered);
    }

    /** @return the latest drawing this sink has seen, or {@code null} before one arrived */
    public Map<String, Object> topology() {
        return topology;
    }

    /** @return every non-topology record, in arrival order, unmodifiable view */
    public List<Map<String, Object>> records() {
        return Collections.unmodifiableList(records);
    }
}
