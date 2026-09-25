package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.session.SessionStore;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * Card 445: what the operator says ABOUT a session, kept beside the sessions
 * rather than inside them.
 *
 * <p>The session JSONL is additive-only and a new field there needs the
 * owner's sign-off (card 392), so a session's title and pin live in one small
 * file, {@code ~/.spectro/session-meta.json}, keyed by session id:</p>
 *
 * <pre>
 * { "20260925-101500-ab12cd34": {
 *     "title": "Subagenten und Workflows Review",
 *     "titleSource": "suggested",
 *     "suggestion": "Subagenten und Workflows Review",
 *     "pinned": true } }
 * </pre>
 *
 * <p>{@code title} and {@code titleSource} are what the row shows.
 * {@code suggestion} is the model's last suggestion, kept so that clearing a
 * hand-set title can fall back to it. An entry with nothing left in it is
 * dropped from the file.</p>
 *
 * <p>Every change reads the file, changes one entry and writes the whole
 * file through a temporary file in the same folder and an atomic rename, so a
 * crash leaves either the old file or the new one and never half of one. The
 * methods are synchronized on the store; the server shares one instance
 * ({@link #shared()}) between the REST endpoints and the background title
 * request.</p>
 */
public final class SessionMetaStore {

    /** A title longer than this is cut, at a word gap where there is one. */
    public static final int TITLE_MAX_CHARS = 80;

    /** {@code titleSource} of a title the model suggested. */
    public static final String SUGGESTED = "suggested";

    /** {@code titleSource} of a title the operator typed. */
    public static final String MANUAL = "manual";

    /** Writes the bytes of the next file to a path; a seam for the crash test. */
    interface Writer {
        void write(Path target, byte[] bytes) throws IOException;
    }

    /**
     * One session's entry.
     *
     * @param title       the title the row shows, or null for none
     * @param titleSource {@link #SUGGESTED} or {@link #MANUAL}, null without a title
     * @param suggestion  the model's last suggestion, or null
     * @param pinned      whether the session is pinned
     */
    public record Entry(String title, String titleSource, String suggestion, boolean pinned) {

        boolean isEmpty() {
            return title == null && suggestion == null && !pinned;
        }
    }

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final SessionMetaStore SHARED =
            new SessionMetaStore(SessionStore.SESSIONS_DIR.resolveSibling("session-meta.json"));

    private final Path file;
    private final Writer writer;

    /**
     * The store the server uses: {@code session-meta.json} beside the sessions
     * folder, in the same {@code ~/.spectro}.
     *
     * @return the one shared store
     */
    public static SessionMetaStore shared() {
        return SHARED;
    }

    SessionMetaStore(Path file) {
        this(file, Files::write);
    }

    SessionMetaStore(Path file, Writer writer) {
        this.file = file;
        this.writer = writer;
    }

    /**
     * @return every entry, keyed by session id; empty when the file is missing
     *         or cannot be read
     */
    public synchronized Map<String, Entry> all() {
        return read();
    }

    /**
     * @param id the session id
     * @return that session's entry, or empty when it has none
     */
    public synchronized Optional<Entry> get(String id) {
        return Optional.ofNullable(read().get(id));
    }

    /**
     * The operator's title. A blank one clears the hand-set title: the row
     * then shows the model's suggestion, or the first prompt without one.
     *
     * @param id    the session id
     * @param title what the operator typed
     * @return the entry after the change, empty when nothing is left in it
     */
    public synchronized Optional<Entry> rename(String id, String title) {
        Map<String, Entry> entries = read();
        Entry old = entries.getOrDefault(id, new Entry(null, null, null, false));
        String typed = oneLine(title);
        Entry next = typed.isEmpty()
                ? new Entry(old.suggestion(), old.suggestion() == null ? null : SUGGESTED,
                        old.suggestion(), old.pinned())
                : new Entry(typed, MANUAL, old.suggestion(), old.pinned());
        return put(entries, id, next);
    }

    /**
     * The model's suggestion. It becomes the row's title unless the operator
     * has set one by hand, which a suggestion never overwrites.
     *
     * @param id         the session id
     * @param suggestion the cleaned suggestion
     * @return the entry after the change, empty when nothing is left in it
     */
    public synchronized Optional<Entry> suggest(String id, String suggestion) {
        Map<String, Entry> entries = read();
        Entry old = entries.getOrDefault(id, new Entry(null, null, null, false));
        String offered = oneLine(suggestion);
        if (offered.isEmpty()) {
            return Optional.ofNullable(entries.get(id));
        }
        Entry next = MANUAL.equals(old.titleSource())
                ? new Entry(old.title(), MANUAL, offered, old.pinned())
                : new Entry(offered, SUGGESTED, offered, old.pinned());
        return put(entries, id, next);
    }

    /**
     * Pins or unpins a session. The title is left as it is.
     *
     * @param id     the session id
     * @param pinned the new state
     * @return the entry after the change, empty when nothing is left in it
     */
    public synchronized Optional<Entry> pin(String id, boolean pinned) {
        Map<String, Entry> entries = read();
        Entry old = entries.getOrDefault(id, new Entry(null, null, null, false));
        return put(entries, id, new Entry(old.title(), old.titleSource(), old.suggestion(), pinned));
    }

    /**
     * Drops a session's entry, title and pin together; the delete cascade calls
     * this.
     *
     * @param id the session id
     * @return true when there was an entry to drop
     */
    public synchronized boolean remove(String id) {
        Map<String, Entry> entries = read();
        if (entries.remove(id) == null) {
            return false;
        }
        write(entries);
        return true;
    }

    private Optional<Entry> put(Map<String, Entry> entries, String id, Entry next) {
        if (next.isEmpty()) {
            entries.remove(id);
        } else {
            entries.put(id, next);
        }
        write(entries);
        return next.isEmpty() ? Optional.empty() : Optional.of(next);
    }

    /**
     * One line, single spaces, cut at {@link #TITLE_MAX_CHARS}.
     *
     * @param text any text, may be null
     * @return the text as a title, empty for null or blank
     */
    static String oneLine(String text) {
        if (text == null) {
            return "";
        }
        String line = text.replaceAll("\\s+", " ").trim();
        if (line.length() <= TITLE_MAX_CHARS) {
            return line;
        }
        String cut = line.substring(0, TITLE_MAX_CHARS);
        int gap = cut.lastIndexOf(' ');
        return (gap > TITLE_MAX_CHARS / 2 ? cut.substring(0, gap) : cut).trim();
    }

    private Map<String, Entry> read() {
        Map<String, Entry> entries = new LinkedHashMap<>();
        if (!Files.isRegularFile(file)) {
            return entries;
        }
        JsonNode root;
        try {
            root = JSON.readTree(file.toFile());
        } catch (IOException unreadable) {
            return entries;
        }
        if (root == null || !root.isObject()) {
            return entries;
        }
        root.properties().forEach(field -> {
            JsonNode node = field.getValue();
            if (!node.isObject()) {
                return;
            }
            String title = textOrNull(node, "title");
            String source = textOrNull(node, "titleSource");
            if (title != null && !MANUAL.equals(source)) {
                source = SUGGESTED;
            }
            Entry entry = new Entry(title, title == null ? null : source,
                    textOrNull(node, "suggestion"), node.path("pinned").asBoolean(false));
            if (!entry.isEmpty()) {
                entries.put(field.getKey(), entry);
            }
        });
        return entries;
    }

    private static String textOrNull(JsonNode node, String name) {
        JsonNode value = node.get(name);
        if (value == null || !value.isTextual() || value.asText().isBlank()) {
            return null;
        }
        return value.asText();
    }

    private void write(Map<String, Entry> entries) {
        ObjectNode root = JSON.createObjectNode();
        entries.forEach((id, entry) -> {
            ObjectNode node = root.putObject(id);
            if (entry.title() != null) {
                node.put("title", entry.title());
                node.put("titleSource", entry.titleSource());
            }
            if (entry.suggestion() != null) {
                node.put("suggestion", entry.suggestion());
            }
            if (entry.pinned()) {
                node.put("pinned", true);
            }
        });
        Path scratch = null;
        try {
            Files.createDirectories(file.getParent());
            scratch = Files.createTempFile(file.getParent(), "session-meta", ".tmp");
            writer.write(scratch, JSON.writerWithDefaultPrettyPrinter().writeValueAsBytes(root));
            Files.move(scratch, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException failed) {
            if (scratch != null) {
                try {
                    Files.deleteIfExists(scratch);
                } catch (IOException leftBehind) {
                    // The old file is whole either way; a stray temporary file is not.
                }
            }
            throw new UncheckedIOException("Cannot write " + file, failed);
        }
    }
}
