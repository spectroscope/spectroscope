package dev.spectroscope.mcp.notes;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * The notes "database": a directory with <b>one file per note</b> (default
 * {@code ~/.spectro/notes}, overridable by the first CLI arg). {@link #list()}
 * reads every note file into a {@link Note}; {@link #add(String)} writes a new
 * file with a stable, collision-free name.
 *
 * <p>The point of the MCP example is that a server is "just a program that
 * answers tools/call" — so the store is deliberately plain {@code java.nio},
 * no database, no index.
 */
public final class NotesStore {

    private final Path dir;

    /**
     * Creates a store over a directory — nothing is read or created until the
     * first list/add call.
     *
     * @param dir the notes directory; it may not exist yet
     */
    public NotesStore(Path dir) {
        this.dir = dir;
    }

    /**
     * A single note: its file name (the id shown in search results) and text.
     *
     * @param file the note's file name — the id search hits refer back to
     * @param text the note body, stripped of surrounding whitespace
     */
    public record Note(String file, String text) {
    }

    /** The directory backing this store. */
    public Path dir() {
        return dir;
    }

    /**
     * All notes in the directory, ordered by file name for a stable listing.
     * A missing directory reads as empty (nothing to search yet, not an error).
     */
    public List<Note> list() {
        if (!Files.isDirectory(dir)) {
            return List.of();
        }
        try (Stream<Path> files = Files.list(dir)) {
            List<Note> notes = new ArrayList<>();
            files.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().endsWith(".txt"))
                    .sorted(Comparator.comparing(p -> p.getFileName().toString()))
                    .forEach(p -> notes.add(readNote(p)));
            return notes;
        } catch (IOException e) {
            throw new UncheckedIOException("cannot list notes in " + dir, e);
        }
    }

    /**
     * Reads one note file into its record — a note that exists but cannot be
     * read is a real error and surfaces unchecked, not an empty result.
     *
     * @param p the note file to read
     */
    private Note readNote(Path p) {
        try {
            String text = Files.readString(p, StandardCharsets.UTF_8);
            return new Note(p.getFileName().toString(), text.strip());
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read note " + p, e);
        }
    }

    /**
     * Writes {@code text} as a new note file and returns the created file name.
     * The name is {@code note-<nnnn>-<hash8>.txt}, but the actual file is created
     * with {@link Files#createFile} so a name that already exists never overwrites
     * an existing note: on collision (identical content computes the same hash, and
     * a directory-scan race can reuse an index) the counter is bumped and a fresh
     * name retried, so <b>two identical texts land in two distinct files</b>.
     *
     * @param text the note body; {@code null} reads as empty, surrounding whitespace is stripped
     * @return the created file name — the id future search hits will show
     */
    public String add(String text) {
        String body = text == null ? "" : text.strip();
        try {
            Files.createDirectories(dir);
        } catch (IOException e) {
            throw new UncheckedIOException("cannot create notes dir " + dir, e);
        }
        int index = nextIndex();
        int hash = hash8(body);
        // Retry on FileAlreadyExists (identical content -> identical name, or a
        // racing writer that grabbed our index) by advancing the counter.
        for (int attempt = 0; attempt < 10_000; attempt++) {
            String name = String.format("note-%04d-%08x.txt", index + attempt, hash);
            Path target = dir.resolve(name);
            try {
                Files.createFile(target);
                Files.writeString(target, body, StandardCharsets.UTF_8);
                return name;
            } catch (FileAlreadyExistsException collision) {
                // Name taken — advance the index and try the next one.
            } catch (IOException e) {
                throw new UncheckedIOException("cannot write note " + target, e);
            }
        }
        throw new IllegalStateException("could not allocate a free note name in " + dir);
    }

    /**
     * One past the highest existing {@code note-<nnnn>} index (0 for an empty dir).
     * A starting point for the collision-free scan in {@link #add(String)}; the
     * counter does not depend on wall-clock time.
     */
    private int nextIndex() {
        if (!Files.isDirectory(dir)) {
            return 0;
        }
        try (Stream<Path> files = Files.list(dir)) {
            return files.map(p -> p.getFileName().toString())
                    .filter(n -> n.startsWith("note-"))
                    .map(NotesStore::indexOf)
                    .filter(i -> i >= 0)
                    .max(Integer::compareTo)
                    .map(i -> i + 1)
                    .orElse(0);
        } catch (IOException e) {
            throw new UncheckedIOException("cannot scan notes dir " + dir, e);
        }
    }

    /**
     * Parses the counter out of a note file name — {@code note-0007-…} yields 7;
     * anything unparseable yields -1 and is ignored by the scan.
     *
     * @param fileName a directory entry name starting with {@code note-}
     */
    private static int indexOf(String fileName) {
        // note-0007-deadbeef.txt -> 7
        String rest = fileName.substring("note-".length());
        int dash = rest.indexOf('-');
        String digits = dash >= 0 ? rest.substring(0, dash) : rest;
        try {
            return Integer.parseInt(digits);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /**
     * A short content fingerprint for the file name — the text's own hashCode,
     * with 0 remapped to 1 so no note ever gets an all-zero suffix.
     *
     * @param body the note text to fingerprint
     */
    private static int hash8(String body) {
        int h = body.hashCode();
        return h == 0 ? 1 : h; // avoid an all-zero suffix for empty content
    }
}
