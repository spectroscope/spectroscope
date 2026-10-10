package dev.spectroscope.core.playbook.run;

import java.io.IOException;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/** Finds the files a document location names, and the one a step wrote. */
public final class DocumentLocator {

    private static final Pattern PLACEHOLDER = Pattern.compile("\\{([A-Za-z_][A-Za-z0-9_]*)}");

    private DocumentLocator() {
    }

    /** @param location the document's location pattern; @param vars the playbook's vars; @return a glob */
    public static String glob(String location, Map<String, String> vars) {
        StringBuilder out = new StringBuilder();
        Matcher m = PLACEHOLDER.matcher(location);
        int last = 0;
        while (m.find()) {
            out.append(location, last, m.start());
            String value = vars.get(m.group(1));
            out.append(value != null ? value : "*");
            last = m.end();
        }
        out.append(location.substring(last));
        return out.toString();
    }

    /**
     * @param workspace the session's working folder
     * @param glob      a workspace relative glob
     * @return every regular file it matches, with its modification time in millis
     * @throws IOException when the folder cannot be walked
     */
    public static Map<Path, Long> snapshot(Path workspace, String glob) throws IOException {
        Map<Path, Long> out = new LinkedHashMap<>();
        if (!glob.contains("*")) {
            Path file = workspace.resolve(glob).normalize();
            if (file.startsWith(workspace) && Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
                out.put(file, Files.getLastModifiedTime(file).toMillis());
            }
            return out;
        }
        String[] segments = glob.split("/");
        int fixed = 0;
        while (fixed < segments.length && !segments[fixed].contains("*")) {
            fixed++;
        }
        Path base = workspace;
        for (int i = 0; i < fixed; i++) {
            base = base.resolve(segments[i]);
        }
        base = base.normalize();
        if (!base.startsWith(workspace) || !Files.isDirectory(base)) {
            return out;
        }
        PathMatcher matcher = FileSystems.getDefault().getPathMatcher("glob:" + glob);
        try (Stream<Path> files = Files.walk(base, segments.length - fixed)) {
            for (Path f : (Iterable<Path>) files::iterator) {
                if (Files.isRegularFile(f, LinkOption.NOFOLLOW_LINKS) && matcher.matches(workspace.relativize(f))) {
                    out.put(f, Files.getLastModifiedTime(f).toMillis());
                }
            }
        }
        return out;
    }

    /** @return the newest file that is new in {@code after} or newer than in {@code before}; null when none */
    public static Path changed(Map<Path, Long> before, Map<Path, Long> after) {
        Path best = null;
        long bestAt = Long.MIN_VALUE;
        for (Map.Entry<Path, Long> e : after.entrySet()) {
            Long was = before.get(e.getKey());
            if ((was == null || e.getValue() > was) && e.getValue() > bestAt) {
                best = e.getKey();
                bestAt = e.getValue();
            }
        }
        return best;
    }

    /** @return the newest file of the map, or null when it is empty */
    public static Path newest(Map<Path, Long> files) {
        return files.entrySet().stream().max(Map.Entry.comparingByValue()).map(Map.Entry::getKey).orElse(null);
    }
}
