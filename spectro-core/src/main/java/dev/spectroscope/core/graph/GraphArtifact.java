package dev.spectroscope.core.graph;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Collection;
import java.util.List;

/**
 * The lifecycle file, {@code <stem>.graph.jsonl}: the drawing plus the light that
 * walks it, and never a caller's values.
 *
 * <p>This is the file people attach to bug reports. That promise is kept HERE,
 * where it cannot be forgotten, rather than at a call site: a {@code state_policy}
 * or {@code state_payload} handed to this writer is dropped and counted, so no
 * wiring mistake can put a corpus in it.</p>
 */
public final class GraphArtifact extends JsonlArtifact {

    /** The seven lifecycle records, and nothing else. */
    private static final List<String> TYPES = List.of("graph_topology", "graph_start", "node_start",
            "node_end", "node_error", "edge_taken", "graph_end");

    /**
     * @param path any path of the family; it is re-pointed at {@code .graph.jsonl}
     * @throws IOException when the file cannot be opened
     */
    public GraphArtifact(Path path) throws IOException {
        super(ArtifactPaths.graph(path));
    }

    @Override
    protected Collection<String> accepted() {
        return TYPES;
    }
}
