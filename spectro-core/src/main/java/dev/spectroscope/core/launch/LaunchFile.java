package dev.spectroscope.core.launch;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * A launch file as this product reads it — {@code .spectro/launch.json} when the
 * project carries one, otherwise Claude Code's own {@code .claude/launch.json},
 * unedited (cards 202 and 350).
 *
 * <h2>Two locations, one parser, and a precedence that is stated</h2>
 *
 * <p>The owner separated reading from writing on 2026-08-31: read theirs, write
 * ours. That does not reverse card 202 — a repository set up for Claude Code
 * still just works, with no second config file and no dialect — it only gives
 * the product somewhere of its own to put a file it has authored. {@link
 * #LOCATIONS} is that order, and it is the single place it is written down.
 *
 * <p><b>"One parser" is a claim about the product, and the repository has one
 * other reader.</b> {@code cockpit/serve.py} reads this format for the developer
 * dashboard, which is a standalone Python page with no JVM to call into; it
 * follows the same order and {@code cockpit/test_serve.py} pins that it does.
 * Both are listed by the repository-wide scan in {@code
 * ClaudeFolderStaysTheirsDriftTest}, so a third reader is a decision rather than
 * an accident. That scan finds the quoted key {@code "configurations"} rather
 * than readers as such, and says so in its own name: a reader that builds the
 * key at runtime or spells it in single quotes is not one it can see.
 *
 * <p><b>The first location that EXISTS answers, whole.</b> Not the first that
 * parses, and not a merge of the two. Falling through from a broken file of ours
 * to a working file of theirs would hand an operator somebody else's
 * configurations under his own filename, which is the worst of the three
 * available behaviours: he edited one file and played another. Merging is worse
 * still — two entries called {@code dev} are two answers to one question, and a
 * merge has to pick one per key while looking like it picked neither. So one
 * file wins and {@link #shadowed()} names the ones it passed over, because the
 * failure this card was cut to prevent is two files disagreeing in silence.
 *
 * <p><b>The format was measured, not remembered.</b> Every readable
 * {@code .claude/launch.json} under the operator's home was parsed on
 * 2026-08-13 with the walk written into {@code LaunchFormatCorpusTest}: 15
 * files, 58 entries. All 15 carry a top-level {@code version}, always
 * {@code "0.0.1"}. Every entry carries {@code name}, {@code runtimeExecutable},
 * {@code runtimeArgs} and {@code port}; one carries {@code autoPort}, which this
 * reader does not use; none carries the {@code url}-with-no-command shape, which
 * the format nevertheless allows and which criterion 2 has to answer for.
 *
 * <p><b>So the reader is deliberately forgiving in one direction and strict in
 * the other.</b> A {@code version} it does not know and an entry key it does not
 * use are IGNORED, because the compatibility goal is the point of the card: a
 * file Claude Code runs must load here without edits, and a key added to that
 * format next month must not turn a working repository into a broken one. What
 * is refused is a file that is not this format at all — not JSON, no
 * {@code configurations} array — because guessing there would hand the agent a
 * silently empty list and no reason for it.
 *
 * <p>An entry without a usable {@code name} is dropped rather than failing the
 * file, and {@link #skipped()} counts the drops so a listing can say so instead
 * of quietly showing fewer configurations than the file holds.
 *
 * @param version  the file's own {@code version} value, verbatim and unjudged, or
 *                 null when it carries none
 * @param entries  the configurations, in file order
 * @param skipped  how many entries were dropped for carrying no addressable name
 * @param location which of {@link #LOCATIONS} this was read from, or null when it
 *                 came from {@link #parse(String)} and belongs to no project
 * @param shadowed the locations that also carry a file and were passed over,
 *                 in {@link #LOCATIONS} order — empty in every ordinary project
 */
public record LaunchFile(String version, List<LaunchEntry> entries, int skipped,
                        String location, List<String> shadowed) {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Where the product writes, and the first place it looks. Card 350. */
    public static final String OURS = SpectroDir.project("launch.json");

    /** Claude Code's location, read unedited and never written (card 202). */
    public static final String THEIRS = ".claude/launch.json";

    /**
     * Every location a launch file is read from, in the order it is looked for.
     * The first that exists answers; see the class documentation for why that is
     * not "the first that parses" and not a merge.
     */
    public static final List<String> LOCATIONS = List.of(OURS, THEIRS);

    /** Whose each location is, for the sentence below. */
    private static final Map<String, String> WHOSE = Map.of(
            OURS, "spectroscope's own",
            THEIRS, "Claude Code's, read unedited");

    /**
     * The locations as a sentence, for the messages a reader gets when a project
     * carries none of them.
     *
     * <p>Folded over {@link #LOCATIONS} rather than typed out, and in that
     * order: the sentence tells an operator where to put a file, so a sentence
     * that named them in a different order from the one the reader searches
     * would be worse than no sentence. Reversing the list turns three tests red,
     * this one included — which is the point of folding rather than typing.
     */
    public static final String LOCATIONS_SENTENCE = LOCATIONS.stream()
            .map(location -> location + " (" + WHOSE.get(location) + ")")
            .collect(java.util.stream.Collectors.joining(" or "));

    /** The keys this reader uses; everything else in an entry is recorded and ignored. */
    private static final Set<String> KNOWN_KEYS =
            Set.of("name", "port", "runtimeExecutable", "runtimeArgs", "url");

    /** Defensive copies, so a caller cannot mutate a file after it was read. */
    public LaunchFile {
        entries = entries == null ? List.of() : List.copyOf(entries);
        shadowed = shadowed == null ? List.of() : List.copyOf(shadowed);
    }

    /**
     * Reads the launch file of one project root.
     *
     * @param projectRoot the folder the agent is working in
     * @return the parsed file, or empty when the project carries none
     * @throws IllegalArgumentException when the file exists but is not this format
     */
    public static Optional<LaunchFile> readFrom(Path projectRoot) {
        String found = null;
        List<String> shadowed = new ArrayList<>();
        for (String location : LOCATIONS) {
            if (!Files.isRegularFile(projectRoot.resolve(location))) {
                continue;
            }
            if (found == null) {
                found = location;
            } else {
                shadowed.add(location);
            }
        }
        if (found == null) {
            return Optional.empty();
        }
        Path path = projectRoot.resolve(found);
        String text;
        try {
            text = Files.readString(path, StandardCharsets.UTF_8);
        } catch (IOException unreadable) {
            throw new IllegalArgumentException(
                    path + " could not be read: " + unreadable.getMessage());
        }
        LaunchFile parsed;
        try {
            parsed = parse(text);
        } catch (IllegalArgumentException notALaunchFile) {
            // The location has to be in the sentence. With two of them, "it is
            // not JSON" alone leaves the reader guessing which file to open —
            // and the one that failed is not necessarily the one he last edited.
            throw new IllegalArgumentException(
                    found + " could not be read: " + notALaunchFile.getMessage());
        }
        return Optional.of(new LaunchFile(parsed.version(), parsed.entries(), parsed.skipped(),
                found, List.copyOf(shadowed)));
    }

    /**
     * Parses one launch file.
     *
     * @param json the file's text
     * @return the configurations it carries
     * @throws IllegalArgumentException when the text is not a launch file
     */
    public static LaunchFile parse(String json) {
        JsonNode root;
        try {
            root = JSON.readTree(json);
        } catch (IOException notJson) {
            // The parser's own message carries the offending text; the sentence
            // this becomes reaches the model, so only the first line goes in.
            String why = String.valueOf(notJson.getMessage()).split("\n", 2)[0];
            throw new IllegalArgumentException("it is not JSON: " + why);
        }
        if (root == null || !root.isObject()) {
            throw new IllegalArgumentException("it is not a JSON object");
        }
        JsonNode configurations = root.path("configurations");
        if (!configurations.isArray()) {
            throw new IllegalArgumentException("it carries no \"configurations\" array");
        }
        // Read as text whatever it is: the measured corpus says "0.0.1" today,
        // and a version this build has never seen must not stop the file loading.
        String version = root.path("version").isValueNode()
                ? root.path("version").asText() : null;
        List<LaunchEntry> entries = new ArrayList<>();
        int skipped = 0;
        for (JsonNode node : configurations) {
            LaunchEntry entry = readEntry(node);
            if (entry == null) {
                skipped++;
            } else {
                entries.add(entry);
            }
        }
        // parse() answers about TEXT, so it knows no location and shadows nothing;
        // readFrom() is what turns the answer into one about a project.
        return new LaunchFile(version, entries, skipped, null, List.of());
    }

    /** One entry, or null when it carries no name to address it by. */
    private static LaunchEntry readEntry(JsonNode node) {
        if (!node.isObject()) {
            return null;
        }
        String name = node.path("name").isTextual() ? node.path("name").asText().strip() : "";
        if (name.isEmpty()) {
            return null;
        }
        Integer port = node.path("port").isInt() ? node.path("port").asInt() : null;
        String executable = node.path("runtimeExecutable").isTextual()
                ? node.path("runtimeExecutable").asText().strip() : null;
        List<String> args = new ArrayList<>();
        JsonNode argsNode = node.path("runtimeArgs");
        if (argsNode.isArray()) {
            argsNode.forEach(arg -> args.add(arg.isTextual() ? arg.asText() : arg.toString()));
        }
        String url = node.path("url").isTextual() ? node.path("url").asText().strip() : null;
        Set<String> unknown = new LinkedHashSet<>();
        node.fieldNames().forEachRemaining(key -> {
            if (!KNOWN_KEYS.contains(key)) {
                unknown.add(key);
            }
        });
        return new LaunchEntry(name, port,
                executable == null || executable.isEmpty() ? null : executable,
                args, url == null || url.isEmpty() ? null : url, List.copyOf(unknown));
    }

    /**
     * The entry of that name.
     *
     * @param name the configuration name, as the file spells it
     * @return the entry, or empty when the file carries no such name
     */
    public Optional<LaunchEntry> find(String name) {
        if (name == null) {
            return Optional.empty();
        }
        String wanted = name.strip();
        return entries.stream().filter(entry -> entry.name().equals(wanted)).findFirst();
    }

    /**
     * Every configuration name the file offers, in file order.
     *
     * @return the names
     */
    public List<String> names() {
        return entries.stream().map(LaunchEntry::name).toList();
    }
}
