package dev.spectroscope.core.graph;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Collection;

/**
 * The values file, {@code <stem>.state.jsonl}: the only file that may hold what a
 * node wrote, and only the two records that say so.
 *
 * <p>It never clips. What arrives has already been through the policy in
 * {@link StateRecords}, because clipping in a sink would leave every other sink
 * in a fan-out holding the raw corpus while only this file was safe.</p>
 *
 * <p>A lifecycle record handed here is dropped and counted, the mirror image of
 * what {@link GraphArtifact} does — the split is only worth anything if it holds
 * from both sides.</p>
 */
public final class StateArtifact extends JsonlArtifact {

    /**
     * @param path any path of the family; it is re-pointed at {@code .state.jsonl}
     * @throws IOException when the file cannot be opened
     */
    public StateArtifact(Path path) throws IOException {
        super(ArtifactPaths.state(path));
    }

    @Override
    protected Collection<String> accepted() {
        return StateRecords.STATE_TYPES;
    }
}
