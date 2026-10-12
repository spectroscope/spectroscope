package dev.spectroscope.core.playbook;

import java.io.IOException;
import java.nio.file.FileVisitOption;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumSet;
import java.util.List;

import static java.nio.charset.StandardCharsets.UTF_8;

/**
 * Walks a content folder of a playbook without following symbolic links.
 *
 * <p>A symbolic link, a file that is neither regular nor a directory, and a start whose real path
 * leaves the base folder are refusals; a refused entry is never entered and never listed in
 * {@code files}. {@link ContentHash#tree} refuses to hash a walk that carries a refusal.
 */
public final class SafeWalk {

    /**
     * The result of one walk.
     *
     * @param root    the folder the {@code files} are relative to: the start, or the start's parent
     *                when the start is a regular file
     * @param files   paths relative to {@code root} with {@code /} separators, sorted by their UTF-8
     *                bytes compared unsigned
     * @param refused one line per refusal, {@code "<rel>: <why>"}
     * @param bytes   the sum of the sizes of the listed files
     */
    public record Walk(Path root, List<String> files, List<String> refused, long bytes) {
        public Walk {
            files = List.copyOf(files);
            refused = List.copyOf(refused);
        }
    }

    private SafeWalk() {
    }

    /**
     * Walks {@code start} without following links. {@code start} must resolve inside {@code base}
     * through real paths; otherwise the whole start is one refusal and nothing is listed.
     */
    public static Walk walk(Path base, Path start) throws IOException {
        Path realBase = base.toRealPath();
        String startRel = slashed(base.relativize(start).normalize());
        BasicFileAttributes startAttrs = Files.readAttributes(start, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (startAttrs.isSymbolicLink()) {
            return refusedWhole(start, startRel, "a symbolic link");
        }
        if (!start.toRealPath().startsWith(realBase)) {
            return refusedWhole(start, startRel, "reached through a link that leaves the playbook folder");
        }
        if (startAttrs.isRegularFile()) {
            Path name = start.getFileName();
            return new Walk(start.getParent(), List.of(name.toString()), List.of(), startAttrs.size());
        }
        if (!startAttrs.isDirectory()) {
            return refusedWhole(start, startRel, "not a regular file");
        }

        List<String> files = new ArrayList<>();
        List<String> refused = new ArrayList<>();
        long[] bytes = {0};
        Files.walkFileTree(start, EnumSet.noneOf(FileVisitOption.class), Integer.MAX_VALUE, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                String rel = slashed(start.relativize(file));
                if (attrs.isSymbolicLink()) {
                    refused.add(rel + ": a symbolic link");
                } else if (attrs.isRegularFile()) {
                    files.add(rel);
                    bytes[0] += attrs.size();
                } else {
                    refused.add(rel + ": not a regular file");
                }
                return FileVisitResult.CONTINUE;
            }
        });
        files.sort((a, b) -> Arrays.compareUnsigned(a.getBytes(UTF_8), b.getBytes(UTF_8)));
        refused.sort((a, b) -> Arrays.compareUnsigned(a.getBytes(UTF_8), b.getBytes(UTF_8)));
        return new Walk(start, files, refused, bytes[0]);
    }

    /**
     * One entry of a {@link Tree}.
     *
     * @param rel  the path relative to the walked folder, with {@code /} separators
     * @param dir  true for a folder
     * @param size the size in bytes of a file, 0 for a folder
     */
    public record Entry(String rel, boolean dir, long size) {}

    /**
     * The bounded listing of a whole folder.
     *
     * @param root    the walked folder, a real path
     * @param entries the folders and regular files found, in walk order
     * @param refused one line per refusal, {@code "<rel>: <why>"}, sorted
     * @param files   the regular files counted; one more than the cap when the cap was passed
     * @param bytes   the sum of the sizes of the listed files
     * @param capped  true when there were more files than the cap allows
     * @param deeper  the folders at the depth limit that hold something that was not listed, in walk order
     */
    public record Tree(Path root, List<Entry> entries, List<String> refused, int files, long bytes,
                       boolean capped, List<String> deeper) {
        public Tree {
            entries = List.copyOf(entries);
            refused = List.copyOf(refused);
            deeper = List.copyOf(deeper);
        }

        /** True when the listing is not the whole folder. */
        public boolean truncated() {
            return capped || !deeper.isEmpty();
        }
    }

    /**
     * Lists the whole folder {@code base} to {@code maxDepth} without following a link, with the
     * rules of {@link #walk}: a symbolic link or a file that is neither regular nor a folder is a
     * refusal and never an entry, and a linked folder is never entered. A folder at the depth limit
     * is listed but not entered. The walk stops once it has seen one file more than
     * {@code maxFiles}; that file is counted but not listed.
     *
     * @param base     the folder to list; its real path is the root of the listing
     * @param maxDepth the deepest level listed, the base's children being level 1
     * @param maxFiles the most files listed
     */
    public static Tree tree(Path base, int maxDepth, int maxFiles) throws IOException {
        Path root = base.toRealPath();
        List<Entry> entries = new ArrayList<>();
        List<String> refused = new ArrayList<>();
        int[] files = {0};
        long[] bytes = {0};
        boolean[] capped = {false};
        List<String> deeper = new ArrayList<>();
        Files.walkFileTree(root, EnumSet.noneOf(FileVisitOption.class), maxDepth, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                if (!dir.equals(root)) {
                    entries.add(new Entry(slashed(root.relativize(dir)), true, 0));
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                String rel = slashed(root.relativize(file));
                if (attrs.isSymbolicLink()) {
                    refused.add(rel + ": a symbolic link");
                } else if (attrs.isDirectory()) {
                    entries.add(new Entry(rel, true, 0));
                    if (!empty(file)) {
                        deeper.add(rel);
                    }
                } else if (attrs.isRegularFile()) {
                    files[0]++;
                    if (files[0] > maxFiles) {
                        capped[0] = true;
                        return FileVisitResult.TERMINATE;
                    }
                    entries.add(new Entry(rel, false, attrs.size()));
                    bytes[0] += attrs.size();
                } else {
                    refused.add(rel + ": not a regular file");
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFileFailed(Path file, IOException failure) {
                refused.add(slashed(root.relativize(file)) + ": unreadable");
                return FileVisitResult.CONTINUE;
            }
        });
        refused.sort((a, b) -> Arrays.compareUnsigned(a.getBytes(UTF_8), b.getBytes(UTF_8)));
        return new Tree(root, entries, refused, files[0], bytes[0], capped[0], deeper);
    }

    private static boolean empty(Path dir) {
        try (var listing = Files.list(dir)) {
            return listing.findAny().isEmpty();
        } catch (IOException | java.io.UncheckedIOException unreadable) {
            return false;
        }
    }

    private static Walk refusedWhole(Path start, String rel, String why) {
        return new Walk(start, List.of(), List.of(rel + ": " + why), 0);
    }

    private static String slashed(Path rel) {
        String s = rel.toString();
        String sep = rel.getFileSystem().getSeparator();
        return "/".equals(sep) ? s : s.replace(sep, "/");
    }
}
