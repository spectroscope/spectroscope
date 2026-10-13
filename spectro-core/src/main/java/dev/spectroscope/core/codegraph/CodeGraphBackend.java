package dev.spectroscope.core.codegraph;

import dev.spectroscope.core.config.governing.Governs;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * Card 587, criterion 6: the program that builds and answers the code graph.
 * The {@code codeGraphBackend} setting names one, and the {@code /graph}
 * command, the folder chip's build and the model's {@code code_graph} tool all
 * read that one name. graphify is the only backend today, and the command
 * lines are graphify's own ({@code CodeGraphTool.argv},
 * {@code GraphifyCommand.steps}): a second graph program needs its command
 * lines there as well as a backend here.
 *
 * @param name      the value the setting takes
 * @param binary    the program's name on the tool PATH
 * @param install   the line a person runs to install it
 * @param graphFile the graph the tool asks, relative to the folder
 * @param pageFile  the page the browser panel shows, relative to the folder
 */
public record CodeGraphBackend(String name, String binary, String install, Path graphFile, Path pageFile) {

    /** graphify 0.9.67 (card 472 builds, card 547 answers). */
    public static final CodeGraphBackend GRAPHIFY = new CodeGraphBackend("graphify", "graphify",
            "uv tool install graphifyy", Path.of("graphify-out", "graph.json"), Path.of("graphify-out", "graph.html"));

    /** Every backend, the setting's legal values in this order. */
    public static final List<CodeGraphBackend> ALL = List.of(GRAPHIFY);

    /** The shipped value of the setting. */
    public static final String DEFAULT = GRAPHIFY.name();

    /**
     * The largest graph page a folder may have and still count as having a
     * code graph; the browser panel serves no larger page. graphify draws an
     * aggregated page past 5000 nodes, so real pages stay far below (card 546).
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.BYTES)
    public static final long MAX_PAGE_BYTES = 64L * 1024 * 1024;

    /** Card 587, fix round: what {@link #lookup} found in a folder. */
    public sealed interface Lookup permits Found, Missing, Outside {
    }

    /**
     * The folder has a code graph.
     *
     * @param root  the folder, real
     * @param graph the graph file, real
     * @param page  the page file, real
     */
    public record Found(Path root, Path graph, Path page) implements Lookup {
    }

    /** The folder has no code graph. */
    public record Missing() implements Lookup {
    }

    /**
     * A file of the graph resolves to a place outside the folder.
     *
     * @param real where it resolves to
     */
    public record Outside(Path real) implements Lookup {
    }

    /**
     * Every part is present, and both files are relative paths without a
     * {@code ..} segment; {@link #lookup} still follows links and refuses a
     * file that resolves outside the folder.
     */
    public CodeGraphBackend {
        for (String part : new String[] {name, binary, install}) {
            if (part == null || part.isBlank()) {
                throw new IllegalArgumentException("a code graph backend needs a name, a program and an install line");
            }
        }
        if (graphFile == null || pageFile == null || graphFile.isAbsolute() || pageFile.isAbsolute()) {
            throw new IllegalArgumentException("a code graph backend's files are relative to the folder");
        }
        for (Path file : new Path[] {graphFile, pageFile}) {
            for (Path segment : file) {
                if ("..".equals(segment.toString())) {
                    throw new IllegalArgumentException("a code graph backend's files stay inside the folder: " + file);
                }
            }
        }
    }

    /**
     * Card 587, fix round (M9): the one rule for whether a folder has a code
     * graph, read by every reader (the tool, {@code /graph ask}, the skill
     * offer, the build endpoints and the folder chip). The graph and its page
     * are both regular files inside the folder, followed through every link,
     * and the page is at most {@link #MAX_PAGE_BYTES}. A graph that an extract
     * wrote without its page (clustering failed) is no graph yet.
     *
     * @param folder the folder, or null
     * @return what the folder holds
     */
    public Lookup lookup(Path folder) {
        if (folder == null) {
            return new Missing();
        }
        try {
            Path root = folder.toRealPath();
            for (Path file : new Path[] {graphFile, pageFile}) {
                Path candidate = root.resolve(file);
                if (Files.exists(candidate)) {
                    Path real = candidate.toRealPath();
                    if (!real.startsWith(root)) {
                        return new Outside(real);
                    }
                }
            }
            Path graph = root.resolve(graphFile);
            Path page = root.resolve(pageFile);
            if (!Files.isRegularFile(graph) || !Files.isRegularFile(page)) {
                return new Missing();
            }
            Path realPage = page.toRealPath();
            if (Files.size(realPage) > MAX_PAGE_BYTES) {
                return new Missing();
            }
            return new Found(root, graph.toRealPath(), realPage);
        } catch (IOException | RuntimeException unreadable) {
            return new Missing();
        }
    }

    /**
     * @param folder the folder, or null
     * @return true when {@link #lookup} finds its code graph
     */
    public boolean hasGraph(Path folder) {
        return lookup(folder) instanceof Found;
    }

    /** @return the setting's legal values */
    public static Set<String> names() {
        Set<String> names = new LinkedHashSet<>();
        ALL.forEach(b -> names.add(b.name()));
        return Set.copyOf(names);
    }

    /**
     * @param name a value of the setting
     * @return its backend, or empty for an unknown or absent name
     */
    public static Optional<CodeGraphBackend> named(String name) {
        return ALL.stream().filter(b -> b.name().equals(name)).findFirst();
    }

    /**
     * @param name a value of the setting
     * @return its backend
     * @throws IllegalArgumentException naming the value and the legal ones
     */
    public static CodeGraphBackend require(String name) {
        return named(name).orElseThrow(() -> new IllegalArgumentException("codeGraphBackend \"" + name
                + "\" is not a code graph backend; the backends are " + String.join(", ", ALL.stream()
                .map(CodeGraphBackend::name).toList())));
    }
}
