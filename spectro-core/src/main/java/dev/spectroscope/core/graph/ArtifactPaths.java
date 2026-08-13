package dev.spectroscope.core.graph;

import java.nio.file.Path;
import java.util.List;

/**
 * Where a run's two sibling artifacts land.
 *
 * <p>A caller hands ONE path to both writers and has to end up with two files:
 * {@code <stem>.graph.jsonl} for the lifecycle and {@code <stem>.state.jsonl} for
 * the values. So the suffix rule is idempotent across the whole family — a path
 * that already carries a known suffix is re-pointed rather than extended, which
 * is what makes {@code state(Path.of("run.graph.jsonl"))} land on
 * {@code run.state.jsonl} instead of {@code run.graph.state.jsonl}.</p>
 */
public final class ArtifactPaths {

    /**
     * The suffixes that are re-pointed rather than kept. {@code .llm.jsonl} is in
     * here because it is the third file of the same family (the provider
     * exchange) and a caller who hands its path to a graph writer means the run,
     * not the transcript. {@code .browser.jsonl} is the fourth for the same
     * reason (card 204, the browser trace).
     */
    private static final List<String> FAMILY =
            List.of(".graph.jsonl", ".state.jsonl", ".llm.jsonl", ".browser.jsonl");

    private ArtifactPaths() {
    }

    /**
     * @param path any path of the family, or a bare session path
     * @return the sibling that carries the lifecycle records
     */
    public static Path graph(Path path) {
        return retarget(path, ".graph.jsonl");
    }

    /**
     * @param path any path of the family, or a bare session path
     * @return the sibling that carries the state records
     */
    public static Path state(Path path) {
        return retarget(path, ".state.jsonl");
    }

    /**
     * The sibling that carries the browser trace (card 204): one line per
     * browser tool call and one per its outcome, screenshots by reference only.
     *
     * @param path any path of the family, or a bare session path
     * @return the sibling that carries the browser records
     */
    public static Path browser(Path path) {
        return retarget(path, ".browser.jsonl");
    }

    private static Path retarget(Path path, String suffix) {
        String name = path.getFileName().toString();
        String stem = null;
        for (String known : FAMILY) {
            if (name.endsWith(known)) {
                stem = name.substring(0, name.length() - known.length());
                break;
            }
        }
        if (stem == null) {
            stem = name.endsWith(".jsonl") ? name.substring(0, name.length() - ".jsonl".length()) : name;
        }
        Path parent = path.getParent();
        String target = stem + suffix;
        return parent == null ? Path.of(target) : parent.resolve(target);
    }
}
