package dev.spectroscope.core.launch;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * A {@code .claude/launch.json} as this product reads it — Claude Code's file,
 * unedited (card 202).
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
 * @param version the file's own {@code version} value, verbatim and unjudged, or
 *                null when it carries none
 * @param entries the configurations, in file order
 * @param skipped how many entries were dropped for carrying no addressable name
 */
public record LaunchFile(String version, List<LaunchEntry> entries, int skipped) {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Where the file lives, relative to the project root — Claude Code's location. */
    public static final String LOCATION = ".claude/launch.json";

    /** The keys this reader uses; everything else in an entry is recorded and ignored. */
    private static final Set<String> KNOWN_KEYS =
            Set.of("name", "port", "runtimeExecutable", "runtimeArgs", "url");

    /** Defensive copy of the entry list. */
    public LaunchFile {
        entries = entries == null ? List.of() : List.copyOf(entries);
    }

    /**
     * Reads the launch file of one project root.
     *
     * @param projectRoot the folder the agent is working in
     * @return the parsed file, or empty when the project carries none
     * @throws IllegalArgumentException when the file exists but is not this format
     */
    public static Optional<LaunchFile> readFrom(Path projectRoot) {
        Path path = projectRoot.resolve(LOCATION);
        if (!Files.isRegularFile(path)) {
            return Optional.empty();
        }
        String text;
        try {
            text = Files.readString(path, StandardCharsets.UTF_8);
        } catch (IOException unreadable) {
            throw new IllegalArgumentException(
                    path + " could not be read: " + unreadable.getMessage());
        }
        return Optional.of(parse(text));
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
        return new LaunchFile(version, entries, skipped);
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
