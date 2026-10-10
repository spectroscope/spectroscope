package dev.spectroscope.server.starter;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Writes a map of relative files into a folder in two passes and never
 * overwrites. Pass one ({@link #plan}) resolves every key, refuses a key that
 * leaves the folder lexically or through a symbolic link, and refuses when any
 * target already exists; nothing is written. Pass two ({@link #write}) creates
 * the root when allowed and opens every file with
 * {@link StandardOpenOption#CREATE_NEW}, so a file that appears between the
 * passes is reported as a conflict and kept.
 */
public final class FolderWriter {

    private FolderWriter() {
    }

    /** The outcome of pass one. */
    public sealed interface Planned permits Ready, Refused {
    }

    /**
     * Pass one found nothing to refuse.
     *
     * @param root        the real path of the root (of its nearest existing
     *                    ancestor plus the missing name when the root is created)
     * @param displayRoot the absolute normalized root, as callers report it
     * @param targets     every target under {@code displayRoot} with its content,
     *                    in the order of the input map
     * @param createRoot  whether pass two creates {@code displayRoot} first
     */
    public record Ready(Path root, Path displayRoot, Map<Path, String> targets, boolean createRoot)
            implements Planned {
    }

    /**
     * Pass one refused.
     *
     * @param result why
     */
    public record Refused(Result result) implements Planned {
    }

    /** The answer of a write. */
    public sealed interface Result permits Written, Conflicts, Escape, NotAFolder, Failed {
    }

    /**
     * Every file was written.
     *
     * @param dir     the absolute normalized root
     * @param written the relative paths, in write order
     */
    public record Written(String dir, List<String> written) implements Result {
    }

    /**
     * Targets already exist.
     *
     * @param conflicts the relative paths that exist
     * @param written   what was written before the conflict; empty when pass one refused
     */
    public record Conflicts(List<String> conflicts, List<String> written) implements Result {
    }

    /**
     * A key leaves the folder.
     *
     * @param key the key as given
     */
    public record Escape(String key) implements Result {
    }

    /**
     * The target folder is missing or not a folder.
     *
     * @param dir the folder as given
     */
    public record NotAFolder(String dir) implements Result {
    }

    /**
     * An I/O failure in pass two.
     *
     * @param message the failure's message
     * @param written what was written before the failure
     */
    public record Failed(String message, List<String> written) implements Result {
    }

    /**
     * Pass one: resolve, contain (lexical and real path of the nearest existing
     * ancestor), refuse existing targets.
     *
     * @param dir               the target folder
     * @param files             relative path to content
     * @param createMissingRoot allow a missing {@code dir} whose parent is an existing folder
     * @return {@link Ready}, or {@link Refused} with {@link NotAFolder}, {@link Escape} or {@link Conflicts}
     */
    public static Planned plan(Path dir, Map<String, String> files, boolean createMissingRoot) {
        Path displayRoot = dir.toAbsolutePath().normalize();
        boolean createRoot = false;
        if (!Files.isDirectory(displayRoot)) {
            Path parent = displayRoot.getParent();
            boolean missing = !Files.exists(displayRoot, LinkOption.NOFOLLOW_LINKS);
            if (!createMissingRoot || !missing || parent == null || !Files.isDirectory(parent)) {
                return new Refused(new NotAFolder(dir.toString()));
            }
            createRoot = true;
        }
        Path realRoot;
        try {
            realRoot = realOf(displayRoot);
        } catch (IOException failure) {
            return new Refused(new NotAFolder(dir.toString()));
        }

        Map<Path, String> targets = new LinkedHashMap<>();
        List<String> conflicts = new ArrayList<>();
        for (Map.Entry<String, String> entry : files.entrySet()) {
            Path target = displayRoot.resolve(entry.getKey()).normalize();
            if (!target.startsWith(displayRoot) || target.equals(displayRoot)) {
                return new Refused(new Escape(entry.getKey()));
            }
            try {
                if (!realOf(target.getParent()).startsWith(realRoot)) {
                    return new Refused(new Escape(entry.getKey()));
                }
            } catch (IOException failure) {
                return new Refused(new Escape(entry.getKey()));
            }
            if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                conflicts.add(entry.getKey());
            }
            targets.put(target, entry.getValue());
        }
        if (!conflicts.isEmpty()) {
            return new Refused(new Conflicts(List.copyOf(conflicts), List.of()));
        }
        return new Ready(realRoot, displayRoot, targets, createRoot);
    }

    /**
     * Pass two: create the root when allowed, then write every file with CREATE_NEW.
     *
     * @param ready the plan from pass one
     * @return {@link Written}, {@link Conflicts} for a file that appeared after
     *         pass one, or {@link Failed} on any other I/O failure
     */
    public static Result write(Ready ready) {
        Path displayRoot = ready.displayRoot();
        List<String> written = new ArrayList<>();
        try {
            if (ready.createRoot()) {
                Files.createDirectory(displayRoot);
            }
            for (Map.Entry<Path, String> entry : ready.targets().entrySet()) {
                Path target = entry.getKey();
                String relative = displayRoot.relativize(target).toString();
                Files.createDirectories(target.getParent());
                OutputStream out;
                try {
                    out = Files.newOutputStream(target, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
                } catch (FileAlreadyExistsException exists) {
                    return new Conflicts(List.of(relative), List.copyOf(written));
                }
                try (out) {
                    out.write(entry.getValue().getBytes(StandardCharsets.UTF_8));
                }
                written.add(relative);
            }
        } catch (IOException failure) {
            return new Failed(failure.getMessage(), List.copyOf(written));
        }
        return new Written(displayRoot.toString(), List.copyOf(written));
    }

    /**
     * The real path of the nearest existing ancestor of {@code path}, with the
     * missing names below it appended. {@code path} must be absolute and normalized.
     */
    private static Path realOf(Path path) throws IOException {
        Path existing = path;
        while (existing != null && !Files.exists(existing, LinkOption.NOFOLLOW_LINKS)) {
            existing = existing.getParent();
        }
        if (existing == null) {
            throw new IOException("No existing ancestor: " + path);
        }
        return existing.toRealPath().resolve(existing.relativize(path));
    }
}
