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

    private static Walk refusedWhole(Path start, String rel, String why) {
        return new Walk(start, List.of(), List.of(rel + ": " + why), 0);
    }

    private static String slashed(Path rel) {
        String s = rel.toString();
        String sep = rel.getFileSystem().getSeparator();
        return "/".equals(sep) ? s : s.replace(sep, "/");
    }
}
