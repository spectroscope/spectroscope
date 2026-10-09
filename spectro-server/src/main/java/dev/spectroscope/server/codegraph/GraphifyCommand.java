package dev.spectroscope.server.codegraph;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The command lines behind "Build code graph" (card 472): which graphify
 * subcommands run, in which order, with which options.
 *
 * <p>The harness drives the graphify CLI and does not reimplement it. Every
 * step is an argument list for {@link ProcessBuilder}, never a shell string,
 * and the two values a person chooses (backend and model) are checked here
 * before they can become an argument. A value is passed as one
 * {@code --name=value} token, so even an accepted value cannot be read as a
 * second option.</p>
 *
 * <p>The steps per choice:</p>
 * <ul>
 *   <li>full build: {@code extract <folder> --code-only} (the code through
 *       graphify's local AST pass, no LLM, docs and images skipped), then
 *       {@code cluster-only <folder> --no-label}, which writes {@code graph.html}
 *       and the report and keeps the names a {@code .graphify_labels.json}
 *       already holds (graphify 0.9.67 reuses it whenever it exists; a
 *       community whose members changed is renamed after its hub);</li>
 *   <li>update: {@code update <folder>} (changed code re-extracted, graph and
 *       {@code graph.html} rewritten, existing names kept);</li>
 *   <li>either, when a backend was chosen: {@code label <folder> --missing-only},
 *       which names only the communities that have no name or a
 *       {@code Community N} placeholder. No step renames a community that has
 *       a name, so names given by hand survive a build from the app (owner
 *       decision, 2026-10-09).</li>
 * </ul>
 *
 * <p>The option names are pinned against the help text of
 * {@link #PINNED_VERSION} by {@code GraphifyHelpDriftTest}.</p>
 */
public final class GraphifyCommand {

    /** The graphify version whose {@code --help} the drift test holds these steps against. */
    public static final String PINNED_VERSION = "0.9.67";

    /** How graphify is installed, the line the sheet and doctor print when it is missing. */
    public static final String INSTALL_LINE = "uv tool install graphifyy";

    /** The graphify backends the harness maps its providers to (graphify's own names). */
    public static final Set<String> BACKENDS = Set.of("claude", "openai", "gemini", "ollama");

    /**
     * A model name as one argument: starts with a letter or digit (so it cannot
     * read as an option) and holds only the characters model ids use across
     * the providers: tags ({@code qwen3:8b}), paths ({@code openai/gpt-4o}),
     * quantisation suffixes ({@code @iq1_m}).
     */
    static final Pattern MODEL = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}");

    /** Which build the sheet asked for. */
    public enum Mode {
        /** Extract all code, then cluster and name. */
        FULL,
        /** Re-extract changed code and keep what exists. */
        UPDATE;

        /**
         * Reads the wire name the sheet sends.
         *
         * @param wire {@code full} or {@code update}
         * @return the mode
         * @throws IllegalArgumentException for anything else, null included
         */
        public static Mode parse(String wire) {
            if ("full".equals(wire)) {
                return FULL;
            }
            if ("update".equals(wire)) {
                return UPDATE;
            }
            throw new IllegalArgumentException("mode must be full or update");
        }
    }

    /**
     * The community naming choice: a graphify backend and a model. Absent
     * (null) means "no labels".
     *
     * @param backend one of {@link #BACKENDS}
     * @param model   a model id matching {@link #MODEL}
     */
    public record Naming(String backend, String model) {
        /**
         * Refuses a backend graphify does not know and a model that could be
         * read as an option or carries characters no model id has.
         *
         * @param backend one of {@link #BACKENDS}
         * @param model   the model id
         */
        public Naming {
            if (backend == null || !BACKENDS.contains(backend)) {
                throw new IllegalArgumentException("unknown graphify backend");
            }
            if (model == null || !MODEL.matcher(model).matches()) {
                throw new IllegalArgumentException("not a model name");
            }
        }
    }

    private GraphifyCommand() {
    }

    /**
     * The steps of one build, in the order they run.
     *
     * @param binary the absolute path of graphify, as the tool PATH lookup found it
     * @param folder the session's resolved workspace
     * @param mode   full build or update
     * @param naming the backend and model for community names, or null for none
     * @return one argument list per step
     */
    public static List<List<String>> steps(String binary, Path folder, Mode mode, Naming naming) {
        String target = folder.toString();
        List<List<String>> steps = new ArrayList<>();
        if (mode == Mode.FULL) {
            steps.add(List.of(binary, "extract", target, "--code-only"));
            steps.add(List.of(binary, "cluster-only", target, "--no-label"));
        } else {
            steps.add(List.of(binary, "update", target));
        }
        if (naming != null) {
            steps.add(List.of(binary, "label", target, "--missing-only",
                    "--backend=" + naming.backend(), "--model=" + naming.model()));
        }
        return List.copyOf(steps);
    }
}
