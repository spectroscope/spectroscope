package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.codegraph.CodeGraphBackend;
import dev.spectroscope.core.config.governing.Governs;

import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * Card 547: {@code code_graph}, the model's read-only way into the code graph
 * that graphify built for the session folder ({@code graphify-out/graph.json}).
 *
 * <p>The tool runs one of graphify's read-only subcommands as an argument
 * vector, without a shell, and always with {@code --graph} naming the graph of
 * the call's own folder. Every refusal is a tool result the model can act on;
 * nothing here throws into the loop. What graphify prints is data, like a file
 * read.</p>
 *
 * <p>Card 587: the program and its graph file come from the
 * {@link CodeGraphBackend} the {@code codeGraphBackend} setting names. The
 * argument vectors are graphify's, the only backend today. Fix round: the
 * backend is asked for the folder of each call, so a folder's own setting
 * reaches the tool, and whether the folder has a graph is the backend's one
 * rule ({@link CodeGraphBackend#lookup}).</p>
 */
public final class CodeGraphTool implements Tool {

    /** The graphify version whose help {@code CodeGraphHelpDriftTest} holds the command lines against. */
    public static final String PINNED_VERSION = "0.9.67";

    /** The tool's name, as the model calls it. */
    public static final String NAME = "code_graph";

    /** The five actions, in the order the schema lists them. */
    public static final List<String> ACTIONS = List.of("query", "path", "explain", "affected", "god_nodes");

    /**
     * The wall clock budget of one graphify call, in seconds. A query on the
     * spectro repo's own graph (49 MB, 22,191 nodes) took 2.7 to 2.9 s on the
     * owner's Mac on 2026-10-12, so ten times that is room for a slower machine.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.SECONDS)
    public static final long TIMEOUT_SECONDS = 30;

    /**
     * How many characters of graphify's output one call returns. The largest
     * budget the tool lets through ({@link #MAX_BUDGET} tokens) printed 12,509
     * characters on the spectro graph, so this keeps one answer whole and still
     * keeps a single call from filling the context window.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int MAX_OUTPUT_CHARS = 16_000;

    /** The largest {@code --budget} a query may ask for, in graphify's tokens. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.TOKENS)
    public static final int MAX_BUDGET = 4_000;

    /** The smallest {@code --budget} a query may ask for, in graphify's tokens; the skill names the same range. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.TOKENS)
    public static final int MIN_BUDGET = 100;

    /** The fewest steps back {@code affected} may look; the skill names the same range. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int MIN_DEPTH = 1;

    /** The most steps back {@code affected} may look; the skill names the same range. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int MAX_DEPTH = 6;

    /** The fewest nodes {@code god_nodes} may list; the skill names the same range. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int MIN_TOP = 1;

    /** The most nodes {@code god_nodes} may list; the skill names the same range. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int MAX_TOP = 50;

    /**
     * The line a run that offers the tool adds to its system prompt. Tool
     * names stand in backticks because the System context panel renders the
     * prompt as markdown.
     */
    public static final String PROMPT_LINE =
            "If your tools include `code_graph`, ask it a question about structure "
                    + "(callers, paths, what a change affects) before you read many files to answer it.";

    /**
     * The only variables graphify gets from the server's environment, PATH
     * replaced by the tool PATH. Provider keys and the rest stay behind.
     */
    public static final List<String> PASSED_ENVIRONMENT = List.of("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR");

    /** The longest question or node name the tool passes on. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    static final int MAX_TEXT_CHARS = 500;

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern DIGITS = Pattern.compile("\\d{1,6}");
    private static final Pattern CONTROL = Pattern.compile("[\\p{Cntrl}&&[^\\t]]");

    /** Runs one argument vector in a folder; the seam the tests replace. */
    @FunctionalInterface
    public interface Runner {
        /**
         * Runs the program and collects what it printed.
         *
         * @param argv    the program and its arguments, never a shell line
         * @param workdir the folder the program starts in
         * @param signal  the run's cancel signal
         * @return what happened
         */
        Outcome run(List<String> argv, Path workdir, CancelSignal signal);
    }

    /**
     * What one run of graphify produced.
     *
     * @param output    stdout and stderr together, at most the cap
     * @param exitCode  the exit code, or -1 when the process did not end by itself
     * @param timedOut  true when the timeout stopped it
     * @param truncated true when the output was longer than the cap
     * @param cancelled true when the run's cancel signal stopped it
     */
    public record Outcome(String output, int exitCode, boolean timedOut, boolean truncated, boolean cancelled) {
    }

    /**
     * One parsed call.
     *
     * @param action the action name, one of {@link #ACTIONS}
     * @param words  the texts in argv order (question, or the node names)
     * @param flags  the options in argv order, each option followed by its value when it has one
     */
    public record Request(String action, List<String> words, List<String> flags) {
    }

    /**
     * Card 587: whether a folder can be asked, and why not.
     * {@link CodeGraphTool#offeredIn} is {@link #READY}; the {@code /graph ask}
     * refusal names the other four.
     */
    public enum Availability {
        /** The program is installed and the folder has its graph. */
        READY,
        /** There is no folder to look in. */
        NO_FOLDER,
        /** The backend's program is not on the tool PATH. */
        NOT_INSTALLED,
        /** The folder has no graph yet. */
        NO_GRAPH,
        /** The folder's graph resolves to a file outside it. */
        OUTSIDE
    }

    /**
     * A parse result: a request, or the sentence that refuses it.
     *
     * @param request the request, null when refused
     * @param refusal the refusal, null when parsed
     */
    public record Parsed(Request request, String refusal) {
    }

    private final Function<Path, CodeGraphBackend> backends;
    private final Function<CodeGraphBackend, Optional<String>> programs;
    private final Runner runner;

    /** The shipped tool on graphify: found on the tool PATH, run as a real process. */
    public CodeGraphTool() {
        this(CodeGraphBackend.GRAPHIFY);
    }

    /**
     * Card 587: the tool on one backend, whatever the folder.
     *
     * @param backend the program and the files it reads
     */
    public CodeGraphTool(CodeGraphBackend backend) {
        this(folder -> backend);
    }

    /**
     * Card 587, fix round: the tool on the backend each folder uses, asked on
     * every call ({@code CodeGraphSetting.backendFor} in production).
     *
     * @param backends the backend of a folder; the folder may be null
     */
    public CodeGraphTool(Function<Path, CodeGraphBackend> backends) {
        this(backends, backend -> locate(backend.binary()),
                processRunner(Duration.ofSeconds(TIMEOUT_SECONDS), MAX_OUTPUT_CHARS));
    }

    /**
     * The seam on graphify: where it is, and how it runs.
     *
     * @param graphify the absolute path of graphify, empty when it is not installed
     * @param runner   runs one argument vector
     */
    public CodeGraphTool(Supplier<Optional<String>> graphify, Runner runner) {
        this(CodeGraphBackend.GRAPHIFY, graphify, runner);
    }

    /**
     * The seam on one backend: where its program is, and how it runs.
     *
     * @param backend the program and the files it reads
     * @param binary  the program's absolute path, empty when it is not installed
     * @param runner  runs one argument vector
     */
    public CodeGraphTool(CodeGraphBackend backend, Supplier<Optional<String>> binary, Runner runner) {
        this(folder -> backend, ignored -> binary.get(), runner);
    }

    /**
     * The seam: the backend of a folder, where a backend's program is, and how
     * it runs.
     *
     * @param backends the backend of a folder; the folder may be null
     * @param programs a backend's program as an absolute path, empty when it is not installed
     * @param runner   runs one argument vector
     */
    public CodeGraphTool(Function<Path, CodeGraphBackend> backends,
                         Function<CodeGraphBackend, Optional<String>> programs, Runner runner) {
        this.backends = backends;
        this.programs = programs;
        this.runner = runner;
    }

    private static Optional<String> locate(String binary) {
        ToolPath.Lookup lookup = ToolPath.locate(binary);
        return lookup.isFound() ? Optional.of(lookup.found()) : Optional.empty();
    }

    /**
     * Card 587, fix round: the backend a folder uses, as this tool asks it.
     *
     * @param folder the folder, or null
     * @return its backend
     */
    public CodeGraphBackend backendFor(Path folder) {
        return backends.apply(folder);
    }

    @Override
    public String name() {
        return NAME;
    }

    @Override
    public String description() {
        return "Asks the code graph of this folder (graphify-out/graph.json, built by graphify) a question "
                + "about structure. Read only. Try it before reading many files to find callers, a path "
                + "between two parts or what a change affects. Actions: query (a question in words; "
                + "optional dfs for depth first and budget in tokens, " + MIN_BUDGET + " to " + MAX_BUDGET
                + "), path (the shortest path between the nodes from and to), explain (one node name and its "
                + "neighbors), affected (what depends on the node name; optional depth " + MIN_DEPTH + " to "
                + MAX_DEPTH + "), god_nodes (the most connected nodes; optional top " + MIN_TOP + " to " + MAX_TOP
                + "). Node names are class, "
                + "function or file names as the graph knows them. The answer is graphify's text output, "
                + "at most " + MAX_OUTPUT_CHARS + " characters.";
    }

    @Override
    public JsonNode inputSchema() {
        ObjectNode schema = JSON.createObjectNode().put("type", "object");
        ObjectNode properties = schema.putObject("properties");
        ObjectNode action = properties.putObject("action").put("type", "string")
                .put("description", "Which question to ask the graph");
        ArrayNode actions = action.putArray("enum");
        ACTIONS.forEach(actions::add);
        properties.putObject("question").put("type", "string")
                .put("description", "query: the question in words");
        properties.putObject("dfs").put("type", "boolean")
                .put("description", "query: depth first instead of breadth first");
        properties.putObject("budget").put("type", "integer")
                .put("description", "query: the most tokens of answer, " + MIN_BUDGET + " to " + MAX_BUDGET);
        properties.putObject("from").put("type", "string").put("description", "path: the start node");
        properties.putObject("to").put("type", "string").put("description", "path: the end node");
        properties.putObject("name").put("type", "string")
                .put("description", "explain and affected: the node name");
        properties.putObject("depth").put("type", "integer")
                .put("description", "affected: how many steps back, " + MIN_DEPTH + " to " + MAX_DEPTH);
        properties.putObject("top").put("type", "integer")
                .put("description", "god_nodes: how many nodes, " + MIN_TOP + " to " + MAX_TOP);
        schema.putArray("required").add("action");
        return schema;
    }

    @Override
    public boolean needsPermission() {
        return false;
    }

    @Override
    public String systemPromptLine() {
        return PROMPT_LINE;
    }

    /**
     * Offered only when the folder's backend is installed and the folder has a
     * graph that stays inside it.
     *
     * @param cwd the run's folder
     * @return true when a call could reach graphify and a graph
     */
    @Override
    public boolean offeredIn(Path cwd) {
        return availability(cwd) == Availability.READY;
    }

    /**
     * Card 587: whether a folder can be asked, and why not.
     *
     * @param cwd the folder, or null
     * @return the first reason it cannot, or {@link Availability#READY}
     */
    public Availability availability(Path cwd) {
        if (cwd == null) {
            return Availability.NO_FOLDER;
        }
        try {
            CodeGraphBackend backend = backends.apply(cwd);
            if (programs.apply(backend).isEmpty()) {
                return Availability.NOT_INSTALLED;
            }
            CodeGraphBackend.Lookup graph = backend.lookup(cwd);
            return graph instanceof CodeGraphBackend.Found ? Availability.READY
                    : graph instanceof CodeGraphBackend.Outside ? Availability.OUTSIDE : Availability.NO_GRAPH;
        } catch (RuntimeException e) {
            return Availability.NO_GRAPH;
        }
    }

    @Override
    public String execute(JsonNode input, ToolContext context) {
        try {
            Path cwd = context.cwd();
            CodeGraphBackend backend = backends.apply(cwd);
            Optional<String> binary = programs.apply(backend);
            if (binary.isEmpty()) {
                return "ERROR: " + backend.binary() + " is not on the PATH of the spectroscope server, so there "
                        + "is no code graph to ask. It is installed with `" + backend.install() + "`. Answer from "
                        + "the files instead (grep, glob, read_file).";
            }
            Parsed parsed = parse(input);
            if (parsed.refusal() != null) {
                return "ERROR: " + parsed.refusal();
            }
            CodeGraphBackend.Lookup graph = backend.lookup(cwd);
            if (graph instanceof CodeGraphBackend.Missing) {
                return "ERROR: this folder has no code graph yet (" + slashed(backend.graphFile()) + " and "
                        + slashed(backend.pageFile()) + "). The "
                        + "person can build it with /graph build or the Build code graph row in the header "
                        + "menu, or it is built with `" + backend.binary() + " update " + cwd + "`. Until then "
                        + "answer from the files (grep, glob, read_file).";
            }
            if (graph instanceof CodeGraphBackend.Outside outside) {
                return "ERROR: the code graph of this folder resolves to " + outside.real()
                        + ", which is outside this folder, so it is not read. Ask the person to rebuild "
                        + "the graph inside the folder.";
            }
            CodeGraphBackend.Found found = (CodeGraphBackend.Found) graph;
            List<String> argv = argv(binary.get(), parsed.request(), found.graph());
            Outcome outcome = runner.run(argv, found.root(), context.signal());
            return render(outcome);
        } catch (RuntimeException e) {
            return "ERROR: code_graph could not run graphify: " + e.getMessage();
        }
    }

    private static String render(Outcome outcome) {
        String output = outcome.output() == null ? "" : outcome.output();
        if (outcome.cancelled()) {
            return "ERROR: the run was cancelled while graphify was answering, so graphify was stopped."
                    + (output.isBlank() ? "" : "\nWhat it printed before:\n" + output);
        }
        if (outcome.timedOut()) {
            return "ERROR: graphify did not answer within " + TIMEOUT_SECONDS + " s and was stopped. Ask a "
                    + "narrower question, a smaller budget or a smaller depth."
                    + (output.isBlank() ? "" : "\nWhat it printed before:\n" + output);
        }
        if (outcome.exitCode() != 0) {
            return "ERROR: graphify exit " + outcome.exitCode() + ":\n" + output;
        }
        String body = output.isBlank() ? "(graphify printed nothing)" : output;
        return outcome.truncated()
                ? body + "\n[cut at " + MAX_OUTPUT_CHARS + " characters; ask a narrower question or a "
                        + "smaller budget]"
                : body;
    }

    // ---- parsing -------------------------------------------------------------

    /**
     * Reads one call's input into a request, or refuses it.
     *
     * @param input the model's arguments, untrusted
     * @return the request, or the refusal sentence
     */
    public static Parsed parse(JsonNode input) {
        if (input == null || !input.isObject()) {
            return refuse("the input must be an object with an action.");
        }
        String action = input.path("action").asText("");
        List<String> words = new ArrayList<>();
        List<String> flags = new ArrayList<>();
        try {
            switch (action) {
                case "query" -> {
                    words.add(text(input, "question"));
                    if (input.path("dfs").asBoolean(false)) {
                        flags.add("--dfs");
                    }
                    number(input, "budget", MIN_BUDGET, MAX_BUDGET, flags);
                }
                case "path" -> {
                    words.add(text(input, "from"));
                    words.add(text(input, "to"));
                }
                case "explain" -> words.add(text(input, "name"));
                case "affected" -> {
                    words.add(text(input, "name"));
                    number(input, "depth", MIN_DEPTH, MAX_DEPTH, flags);
                }
                case "god_nodes" -> number(input, "top", MIN_TOP, MAX_TOP, flags);
                default -> {
                    return refuse("unknown action \"" + action + "\". The actions are "
                            + String.join(", ", ACTIONS) + ".");
                }
            }
        } catch (IllegalArgumentException refused) {
            return refuse(refused.getMessage());
        }
        return new Parsed(new Request(action, List.copyOf(words), List.copyOf(flags)), null);
    }

    private static Parsed refuse(String sentence) {
        return new Parsed(null, sentence);
    }

    /** A question or node name: present, short, no control characters, no leading dash. */
    private static String text(JsonNode input, String field) {
        JsonNode node = input.get(field);
        if (node == null || node.isNull() || !node.isTextual() || node.asText().isBlank()) {
            throw new IllegalArgumentException("this action needs \"" + field + "\" as text.");
        }
        String value = node.asText().strip();
        if (value.startsWith("-")) {
            throw new IllegalArgumentException("\"" + field + "\" starts with a dash, which graphify would "
                    + "read as an option. Give the name or question without the leading dash.");
        }
        if (value.length() > MAX_TEXT_CHARS) {
            throw new IllegalArgumentException("\"" + field + "\" is longer than " + MAX_TEXT_CHARS
                    + " characters. Ask a shorter question.");
        }
        if (CONTROL.matcher(value).find()) {
            throw new IllegalArgumentException("\"" + field + "\" contains a control character. Send plain "
                    + "text on one line.");
        }
        return value;
    }

    /** An optional integer in a range, passed on as an option and its decimal value. */
    private static void number(JsonNode input, String field, int min, int max, List<String> flags) {
        JsonNode node = input.get(field);
        if (node == null || node.isNull()) {
            return;
        }
        Integer value = null;
        if (node.isIntegralNumber() && node.canConvertToInt()) {
            value = node.intValue();
        } else if (node.isTextual() && DIGITS.matcher(node.asText()).matches()) {
            value = Integer.parseInt(node.asText());
        }
        if (value == null || value < min || value > max) {
            throw new IllegalArgumentException("\"" + field + "\" must be a whole number from " + min + " to "
                    + max + ", got " + node + ".");
        }
        flags.add("--" + field);
        flags.add(Integer.toString(value));
    }

    /**
     * The argument vector of one request. The subcommand, the texts, the
     * options, then {@code --graph} with the folder's own graph.
     *
     * @param binary  graphify's absolute path
     * @param request the parsed request
     * @param graph   the resolved graph file
     * @return the vector, never a shell line
     */
    public static List<String> argv(String binary, Request request, Path graph) {
        List<String> argv = new ArrayList<>();
        argv.add(binary);
        argv.add("god_nodes".equals(request.action()) ? "god-nodes" : request.action());
        argv.addAll(request.words());
        argv.addAll(request.flags());
        argv.add("--graph");
        argv.add(graph.toString());
        return List.copyOf(argv);
    }

    // ---- the graph -----------------------------------------------------------

    /** A relative path with forward slashes, as the messages print it on every platform. */
    private static String slashed(Path relative) {
        return relative.toString().replace(File.separatorChar, '/');
    }

    // ---- the real process ----------------------------------------------------

    /**
     * The real runner: no shell, stdin closed, stderr into stdout, only
     * {@link #PASSED_ENVIRONMENT} with the tool PATH, a wall clock timeout
     * and an output cap. A timeout or a cancel stops the process and its
     * children. Output past the cap is
     * read and dropped so the program never blocks on a full pipe.
     *
     * @param timeout  how long one call may run
     * @param capChars how many characters are kept
     * @return the runner
     */
    public static Runner processRunner(Duration timeout, int capChars) {
        return processRunner(timeout, capChars, () -> ToolPath.resolve().path());
    }

    /**
     * The real runner with the PATH it hands graphify given; the seam the
     * tests use to tell that PATH apart from the server's own.
     *
     * @param timeout  how long one call may run
     * @param capChars how many characters are kept
     * @param toolPath the PATH graphify runs with
     * @return the runner
     */
    static Runner processRunner(Duration timeout, int capChars, Supplier<String> toolPath) {
        return (argv, workdir, signal) -> {
            ProcessBuilder builder = new ProcessBuilder(argv)
                    .directory(workdir.toFile())
                    .redirectErrorStream(true)
                    .redirectInput(ProcessBuilder.Redirect.from(new File("/dev/null")));
            Map<String, String> env = builder.environment();
            Map<String, String> passed = new HashMap<>();
            for (String key : PASSED_ENVIRONMENT) {
                String value = env.get(key);
                if (value != null) {
                    passed.put(key, value);
                }
            }
            env.clear();
            env.putAll(passed);
            env.put("PATH", toolPath.get());
            Process process;
            try {
                process = builder.start();
            } catch (IOException e) {
                return new Outcome("could not start " + argv.get(0) + ": " + e.getMessage(), 127, false, false,
                        false);
            }
            StringBuilder kept = new StringBuilder();
            boolean[] cut = {false};
            Thread reader = Thread.ofVirtual().start(() -> {
                char[] buffer = new char[8192];
                try (Reader in = new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8)) {
                    int read;
                    while ((read = in.read(buffer)) >= 0) {
                        synchronized (kept) {
                            int room = capChars - kept.length();
                            if (read > room) {
                                cut[0] = true;
                            }
                            if (room > 0) {
                                kept.append(buffer, 0, Math.min(room, read));
                            }
                        }
                    }
                } catch (IOException ignored) {
                    // the process was stopped; what was read stays
                }
            });
            long deadline = System.nanoTime() + timeout.toNanos();
            boolean ended = false;
            boolean timedOut = false;
            boolean cancelled = false;
            try {
                while (!ended) {
                    if (signal != null && signal.isCancelled()) {
                        cancelled = true;
                        break;
                    }
                    if (System.nanoTime() >= deadline) {
                        timedOut = true;
                        break;
                    }
                    ended = process.waitFor(100, TimeUnit.MILLISECONDS);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                cancelled = true;
            }
            boolean stopped = timedOut || cancelled;
            if (stopped) {
                process.descendants().forEach(ProcessHandle::destroyForcibly);
                process.destroyForcibly();
            }
            try {
                reader.join(Duration.ofSeconds(2));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            String output;
            boolean truncated;
            synchronized (kept) {
                output = kept.toString();
                truncated = cut[0];
            }
            return new Outcome(output, stopped ? -1 : process.exitValue(), timedOut, truncated, cancelled);
        };
    }
}
