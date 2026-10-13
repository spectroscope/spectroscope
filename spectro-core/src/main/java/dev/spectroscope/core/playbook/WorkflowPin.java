package dev.spectroscope.core.playbook;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Card 506: the bytes of a workflow file that a start may run. The start names
 * the hash the playbook module showed; the bytes run only when they hash to it.
 */
public final class WorkflowPin {

    /** Reads a file's bytes; a seam for the test that swaps the file. */
    @FunctionalInterface
    public interface Bytes {
        /** @param file the file @return its bytes @throws IOException when it cannot be read */
        byte[] read(Path file) throws IOException;
    }

    /**
     * @param bytes the bytes that hashed to the confirmed hash, or null when refused
     * @param changed true when the file is not the one the module listed (a link, or other bytes)
     */
    public record Pinned(byte[] bytes, boolean changed) {
    }

    private WorkflowPin() {
    }

    /**
     * @param folder the playbook folder, a real path
     * @param target the workflow file below it
     * @param hash   the content hash the module showed
     * @return the pinned bytes, or a refusal
     * @throws IOException when the file cannot be read
     */
    public static Pinned pin(Path folder, Path target, String hash) throws IOException {
        return pin(folder, target, hash, file -> {
            try (java.io.InputStream in = Files.newInputStream(file, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                return in.readAllBytes();
            }
        });
    }

    /**
     * Card 554: the bytes of a workflow started by name from the chat, and
     * their content hash.
     *
     * @param bytes the file's bytes
     * @param hash  the content hash of those bytes, the one the playbook module lists for the file
     */
    public record Current(byte[] bytes, String hash) {
    }

    /**
     * Card 554: a workflow started by name from the chat runs at once, with no
     * sheet that showed a hash, so there is nothing to compare against. The
     * file still passes the same walk as a confirmed start (one regular file,
     * no link), it is read once, and the hash of that read is what the run
     * records.
     *
     * @param folder the playbook folder, a real path
     * @param target the workflow file below it
     * @return the bytes and their hash, or null when the target is not one regular file
     * @throws IOException when the file cannot be read
     */
    public static Current current(Path folder, Path target) throws IOException {
        SafeWalk.Walk walk = SafeWalk.walk(folder, target);
        if (walk.files().size() != 1 || !walk.root().resolve(walk.files().get(0)).equals(target)) {
            return null;
        }
        byte[] bytes;
        try (java.io.InputStream in = Files.newInputStream(target, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            bytes = in.readAllBytes();
        }
        return new Current(bytes, ContentHash.entries(java.util.Map.of(walk.files().get(0), bytes)));
    }

    static Pinned pin(Path folder, Path target, String hash, Bytes reader) throws IOException {
        SafeWalk.Walk walk = SafeWalk.walk(folder, target);
        // A refused start lists no file; a directory lists what is inside it, never the target.
        if (walk.files().size() != 1 || !walk.root().resolve(walk.files().get(0)).equals(target)) {
            return new Pinned(null, true);
        }
        // One read: the hash and the parse see the same buffer.
        byte[] bytes = reader.read(target);
        if (!ContentHash.entries(java.util.Map.of(walk.files().get(0), bytes)).equals(hash)) {
            return new Pinned(null, true);
        }
        return new Pinned(bytes, false);
    }
}
