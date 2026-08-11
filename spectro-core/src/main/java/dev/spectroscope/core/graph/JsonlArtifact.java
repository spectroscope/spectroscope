package dev.spectroscope.core.graph;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Collection;
import java.util.Map;
import java.util.function.Consumer;

/**
 * One JSONL file with a fixed vocabulary, which it enforces.
 *
 * <p>A record whose {@code type} the file does not own is DROPPED and counted.
 * The counter matters as much as the refusal: a silently ignored record and a
 * correctly empty file look identical afterwards, and the whole point of the
 * split is that a miswired sink cannot move a caller's corpus into the file
 * people attach to bug reports.</p>
 *
 * <p>Append mode, one flush per line. A process that dies mid-run loses its last
 * line and never its history, which is the property somebody tailing the file
 * wants exactly when it matters.</p>
 */
public abstract class JsonlArtifact implements Consumer<Map<String, Object>>, AutoCloseable {

    private final Path path;
    private final Writer writer;
    private int refused;

    /**
     * @param path where to append
     * @throws IOException when the file cannot be opened
     */
    protected JsonlArtifact(Path path) throws IOException {
        this.path = path;
        Path parent = path.getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        this.writer = new BufferedWriter(new java.io.OutputStreamWriter(
                Files.newOutputStream(path, StandardOpenOption.CREATE, StandardOpenOption.APPEND),
                StandardCharsets.UTF_8));
    }

    /** @return the record types this file owns; everything else is refused */
    protected abstract Collection<String> accepted();

    /**
     * Writes one record, or refuses it.
     *
     * @param record the record; its key order is preserved apart from the
     *               {@code type}-first and {@code ts}-last guarantee
     */
    @Override
    public final void accept(Map<String, Object> record) {
        if (record == null || !(record.get("type") instanceof String type)
                || !accepted().contains(type)) {
            refused++;
            return;
        }
        try {
            writer.write(GraphJson.line(GraphJson.ordered(record, System.currentTimeMillis())));
            writer.write('\n');
            writer.flush();
        } catch (IOException failure) {
            throw new UncheckedIOException(failure);
        }
    }

    /** @return how many records this file turned away */
    public final int refused() {
        return refused;
    }

    /** @return the file being appended to */
    public final Path path() {
        return path;
    }

    /**
     * @throws IOException when the underlying file cannot be closed
     */
    @Override
    public void close() throws IOException {
        writer.close();
    }
}
