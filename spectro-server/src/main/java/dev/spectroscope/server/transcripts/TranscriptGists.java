package dev.spectroscope.server.transcripts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One sentence per transcript, written by a model, kept on disk.
 *
 * <p>The import dialog can say a transcript's size, model and agent counts
 * without opening it. What it cannot say is what the session was ABOUT — the
 * first prompt is often "read the card first" or a pasted stack trace. A gist
 * is that missing line, and it costs a model call, which is why it is a button
 * the operator presses rather than something the dialog does to 300 rows the
 * moment it opens.</p>
 *
 * <p><b>Keyed by the file's state, not its name.</b> The stamp is
 * {@code size:modifiedAt}, the same shape the facts cache keys on. A transcript
 * that has grown since its gist was written is a different transcript, so its
 * gist is stale and the button offers it again. Live sessions grow constantly,
 * so this matters on the newest rows — the ones an operator looks at most.</p>
 *
 * <p><b>The model is stored beside the text</b>, because a gist is a reading and
 * the reader matters. It is also what makes "do them all again" meaningful: the
 * operator switches model and wants the old sentences replaced, not kept.</p>
 *
 * <p>Not the facts cache: that one is in memory and dies with the process, which
 * is right for something a directory walk can rebuild in milliseconds. A gist
 * costs an API call, so it survives a restart or the button is a tax.</p>
 */
final class TranscriptGists {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** One stored reading. */
    record Gist(String text, String model, String stamp, long at) {}

    private final Path file;
    private final Map<String, Gist> byPath = new LinkedHashMap<>();
    private boolean loaded;

    TranscriptGists(Path file) {
        this.file = file;
    }

    /** The default home: beside the rest of the operator's spectro state. */
    static TranscriptGists inHome() {
        return new TranscriptGists(
                Path.of(System.getProperty("user.home"), ".spectro", "transcript-gists.json"));
    }

    /**
     * The stamp a transcript's gist is keyed by.
     *
     * @param transcript the file
     * @return {@code size:modifiedAt}, or {@code "?"} when it cannot be stat'd
     */
    static String stampOf(Path transcript) {
        try {
            return Files.size(transcript) + ":" + Files.getLastModifiedTime(transcript).toMillis();
        } catch (IOException | RuntimeException unreadable) {
            return "?";
        }
    }

    /**
     * The gist for a path, if one was written for THIS state of the file.
     *
     * @param path the store-relative path
     * @param stamp the file's current stamp
     * @return the gist, or null when there is none or the file has changed since
     */
    synchronized Gist current(String path, String stamp) {
        load();
        Gist g = byPath.get(path);
        return g != null && g.stamp().equals(stamp) ? g : null;
    }

    /** Everything stored, stale entries included — the caller decides. */
    synchronized Map<String, Gist> all() {
        load();
        return Map.copyOf(byPath);
    }

    /**
     * Stores one gist, replacing whatever that path had.
     *
     * @param path the store-relative path
     * @param gist the reading
     */
    synchronized void put(String path, Gist gist) {
        load();
        byPath.put(path, gist);
        save();
    }

    /** Forgets every stored gist — what "do them all again" writes first, so a
     *  half-finished re-run cannot leave two models' sentences side by side. */
    synchronized void clear() {
        load();
        byPath.clear();
        save();
    }

    private void load() {
        if (loaded) {
            return;
        }
        loaded = true; // once, whatever happens: an unreadable store is an empty one
        if (!Files.isRegularFile(file)) {
            return;
        }
        try {
            JsonNode root = MAPPER.readTree(Files.readString(file, StandardCharsets.UTF_8));
            if (!root.isObject()) {
                return;
            }
            root.fields().forEachRemaining(entry -> {
                JsonNode v = entry.getValue();
                String text = v.path("text").asText(null);
                if (text != null && !text.isBlank()) {
                    byPath.put(entry.getKey(), new Gist(text, v.path("model").asText(""),
                            v.path("stamp").asText("?"), v.path("at").asLong(0L)));
                }
            });
        } catch (IOException | RuntimeException unreadable) {
            // A corrupt store must not stop the dialog from opening. The next
            // press rewrites it.
            byPath.clear();
        }
    }

    private void save() {
        try {
            Files.createDirectories(file.getParent());
            ObjectNode root = MAPPER.createObjectNode();
            byPath.forEach((path, g) -> {
                ObjectNode node = root.putObject(path);
                node.put("text", g.text());
                node.put("model", g.model());
                node.put("stamp", g.stamp());
                node.put("at", g.at());
            });
            // Atomic: a half-written store read on the next boot would lose
            // every gist the operator paid for.
            Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
            Files.writeString(tmp, MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(root),
                    StandardCharsets.UTF_8);
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException | RuntimeException writeFailed) {
            // The gists stay in memory for this process; the next press retries.
        }
    }
}
