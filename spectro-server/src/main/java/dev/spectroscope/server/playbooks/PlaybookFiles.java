package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.playbook.Finding;
import dev.spectroscope.core.playbook.PlaybookValidator;
import dev.spectroscope.core.playbook.SafeWalk;
import dev.spectroscope.server.workspace.WorkspaceController.FileNode;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The files of a registered playbook folder as the editor sees them (card 522): a tree, the text of
 * one file, a write of one file and a delete of one file.
 *
 * <p>Every path from the client is a relative path with {@code /} separators. It is split into
 * segments, and a segment that is empty, {@code .} or {@code ..}, a backslash, a NUL or a leading
 * {@code /} hides the request. The segments are then walked from the folder's real path one by
 * one without following links: a link anywhere on the way, or a file where a folder is needed,
 * hides the request too. A hidden request is answered 404 with no body.
 *
 * <p>Only text is read and written: UTF-8, at most {@link #MAX_TEXT_BYTES}, and no NUL byte in the
 * first {@link #SNIFF_BYTES}. The folder keeps the loader's limits of {@link PlaybookLoader#MAX_FILES}
 * files to {@link PlaybookLoader#WALK_DEPTH} levels, and the installer's {@link #MAX_FOLDER_BYTES}.
 * {@code playbook.json} keeps its own route and hash fence; {@code playbook.json}, {@code LICENSE}
 * and {@code PROVENANCE.md} at the root are never deleted. Both rules hold for any spelling of
 * these names, since the file system may ignore case, and for any path that is the same file on
 * disk, such as a hard link.
 */
public final class PlaybookFiles {

    /** The largest file the editor opens or writes. */
    static final long MAX_TEXT_BYTES = 1024L * 1024;
    /** How much of a file is searched for a NUL byte. */
    static final int SNIFF_BYTES = 8192;
    /** The most bytes a playbook folder may hold, the skill catalogue's ceiling. */
    static final long MAX_FOLDER_BYTES = PlaybookFolders.MAX_BYTES;
    /** The files at the root that a delete never removes. */
    static final Set<String> PROTECTED = Set.of(PlaybookFolders.PLAYBOOK_FILE, PlaybookFolders.LICENCE_FILE,
            PlaybookFolders.PROVENANCE_FILE);

    /** A file name: a segment of the loader's rule, then dot separated extensions of the same characters. */
    private static final Pattern FILE_NAME = Pattern.compile(
            PlaybookValidator.PATH_SEGMENT.pattern() + "(?:\\.[\\p{L}\\p{N}_-]+)*");

    /**
     * The tree of a playbook folder.
     *
     * @param root      the folder's name
     * @param truncated true when the folder holds more than the tree lists: more files than the
     *                  loader counts, or a folder deeper than the loader walks
     * @param capped    true when the walk stopped at the loader's file count; what it did not reach is unknown
     * @param deeper    the folders at the loader's depth that hold more than the tree lists
     * @param entries   the top level nodes, folders first, names case-insensitive
     * @param findings  one per link or file that is not regular, never listed as an entry
     */
    public record TreeView(String root, boolean truncated, boolean capped, List<String> deeper,
                           List<FileNode> entries, List<Finding> findings) {}

    /**
     * The text of one file.
     *
     * @param path   the path relative to the folder
     * @param text   the text
     * @param sha256 the sha256 of the bytes on disk, lowercase hex
     * @param size   the size in bytes
     */
    public record TextFile(String path, String text, String sha256, long size) {}

    /**
     * A written file.
     *
     * @param path   the path relative to the folder
     * @param sha256 the sha256 of the bytes now on disk, lowercase hex
     * @param size   the size in bytes
     */
    public record Saved(String path, String sha256, long size) {}

    /** The answer of a read, a write or a delete. */
    public sealed interface Answer permits Done, Refused, Hidden {}

    /** The request was served; {@code body} is the answer. */
    public record Done(Object body) implements Answer {}

    /**
     * The request was refused and nothing was written.
     *
     * @param status   the HTTP status
     * @param reason   a short code the editor maps to a sentence
     * @param message  the reason in a plain English sentence
     * @param diskHash the hash of the file on disk for a 409, {@code ""} when there is no file; else null
     * @param extra    more fields of the body, such as the hooks an import left out; empty for most
     */
    public record Refused(int status, String reason, String message, String diskHash, Map<String, Object> extra)
            implements Answer {
        Refused(int status, String reason, String message) {
            this(status, reason, message, null);
        }

        Refused(int status, String reason, String message, String diskHash) {
            this(status, reason, message, diskHash, Map.of());
        }

        /** The response body. */
        public Map<String, Object> body() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("reason", reason);
            out.put("message", message);
            if (diskHash != null) {
                out.put("diskHash", diskHash);
            }
            out.putAll(extra);
            return out;
        }
    }

    /** The path is not one this route serves; answered 404 with no body. */
    public record Hidden() implements Answer {}

    private static final Hidden HIDDEN = new Hidden();

    private static final Refused BINARY = new Refused(415, "binary",
            "The file is not UTF-8 text. The editor opens text files only.");
    private static final Refused TOO_LARGE = new Refused(413, "too-large",
            "The file is larger than 1 MB. The editor opens text files up to 1 MB.");

    private static final Refused OWN_ROUTE = new Refused(400, "own-route",
            "playbook.json is saved by the playbook editor, which checks it first. It is not written as a plain file.");
    private static final Refused PROTECTED_FILE = new Refused(400, "protected",
            "playbook.json, LICENSE and PROVENANCE.md belong to every playbook and are not removed.");

    private PlaybookFiles() {
    }

    /** Whether {@code segments} names the root file {@code name} in any spelling of its case. */
    private static boolean atRoot(List<String> segments, String name) {
        return segments.size() == 1 && segments.get(0).equalsIgnoreCase(name);
    }

    /** Whether the existing file {@code at} is the root file {@code name} on disk, under any path. */
    private static boolean sameFile(Path root, Located at, String name) throws IOException {
        Path file = root.resolve(name);
        return at.exists() && !at.dir() && Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)
                && Files.isSameFile(at.path(), file);
    }

    /** The tree of the folder {@code root}, a registered folder's real path. */
    public static TreeView tree(Path root) throws IOException {
        SafeWalk.Tree walk = SafeWalk.tree(root, PlaybookLoader.WALK_DEPTH, PlaybookLoader.MAX_FILES);
        Map<String, Draft> byRel = new LinkedHashMap<>();
        Draft top = new Draft("", "", true, 0);
        for (SafeWalk.Entry entry : walk.entries()) {
            int slash = entry.rel().lastIndexOf('/');
            Draft parent = slash < 0 ? top : byRel.get(entry.rel().substring(0, slash));
            if (parent == null) {
                continue; // a walk lists a folder before what it holds, so this never happens
            }
            Draft node = new Draft(entry.rel().substring(slash + 1), entry.rel(), entry.dir(), entry.size());
            parent.children.add(node);
            if (entry.dir()) {
                byRel.put(entry.rel(), node);
            }
        }
        List<Finding> findings = new ArrayList<>();
        for (String line : walk.refused()) {
            int at = line.lastIndexOf(": ");
            findings.add(at < 0 ? new Finding(line, "refused") : new Finding(line.substring(0, at), line.substring(at + 2)));
        }
        return new TreeView(walk.root().getFileName().toString(), walk.truncated(), walk.capped(), walk.deeper(),
                freeze(top.children), findings);
    }

    /** The text of the file {@code rel} in the folder {@code root}. */
    public static Answer read(Path root, String rel) throws IOException {
        List<String> segments = segments(rel);
        Located at = segments == null ? null : locate(root, segments);
        if (at == null || !at.exists() || at.dir() || segments.size() > PlaybookLoader.WALK_DEPTH) {
            return HIDDEN;
        }
        if (at.size() > MAX_TEXT_BYTES) {
            return TOO_LARGE;
        }
        byte[] bytes = readNoFollow(at.path());
        if (bytes == null) {
            return HIDDEN;
        }
        if (bytes.length > MAX_TEXT_BYTES) {
            return TOO_LARGE;
        }
        String text = textOf(bytes);
        if (text == null) {
            return BINARY;
        }
        return new Done(new TextFile(String.join("/", segments), text, EditorView.sha256(bytes), bytes.length));
    }

    /**
     * Writes {@code text} as the file {@code rel} in the folder {@code root}. {@code baseHash} is the
     * sha256 the text was made from, or {@code ""} for a file that must not exist yet. Missing
     * folders on the way are created inside the playbook folder. Nothing is written unless the
     * answer is {@link Done}.
     */
    public static Answer write(Path root, String rel, String text, String baseHash) throws IOException {
        List<String> segments = segments(rel);
        if (segments == null) {
            return HIDDEN;
        }
        if (atRoot(segments, PlaybookFolders.PLAYBOOK_FILE)) {
            return OWN_ROUTE;
        }
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        synchronized (PlaybookFileWriter.class) {
            Located at = locate(root, segments);
            if (at == null) {
                return HIDDEN;
            }
            if (sameFile(root, at, PlaybookFolders.PLAYBOOK_FILE)) {
                return OWN_ROUTE;
            }
            if (at.exists() && at.dir()) {
                return new Refused(400, "folder", "The path names a folder. Only files are written.");
            }
            if (segments.size() > PlaybookLoader.WALK_DEPTH) {
                return new Refused(400, "too-deep",
                        "The path is deeper than the " + PlaybookLoader.WALK_DEPTH + " levels the playbook loader reads.");
            }
            if (!nameOk(segments)) {
                return new Refused(400, "name", "A folder or file name starts with a letter or a digit and holds "
                        + "only letters, digits, '_' and '-'. A file name may add extensions after a dot.");
            }
            if (bytes.length > MAX_TEXT_BYTES) {
                return TOO_LARGE;
            }
            if (text.indexOf('\0') >= 0) {
                return BINARY;
            }
            if (at.exists() && at.size() > MAX_TEXT_BYTES) {
                return TOO_LARGE;
            }
            byte[] disk = at.exists() ? readNoFollow(at.path()) : null;
            if (at.exists() && disk == null) {
                return HIDDEN;
            }
            String diskHash = disk == null ? "" : EditorView.sha256(disk);
            if (!diskHash.equals(baseHash)) {
                return new Refused(409, "changed", "The file changed on disk since it was read.", diskHash);
            }
            SafeWalk.Tree walk = SafeWalk.tree(root, PlaybookLoader.WALK_DEPTH, PlaybookLoader.MAX_FILES);
            int files = walk.files() + (disk == null ? 1 : 0);
            if (walk.capped() || files > PlaybookLoader.MAX_FILES) {
                return new Refused(413, "too-many-files",
                        "The playbook folder would hold more than " + PlaybookLoader.MAX_FILES + " files.");
            }
            long total = walk.bytes() - (disk == null ? 0 : disk.length) + bytes.length;
            if (total > MAX_FOLDER_BYTES) {
                return new Refused(413, "folder-too-large", "The playbook folder would hold more than 24 MB.");
            }
            List<Path> created = createParents(root, segments);
            if (created == null) {
                return HIDDEN;
            }
            try {
                PlaybookFileWriter.writeAtomically(at.path(), bytes);
                if (disk == null) {
                    plainMode(at.path());
                }
            } catch (IOException | RuntimeException failure) {
                for (int i = created.size() - 1; i >= 0; i--) {
                    Files.deleteIfExists(created.get(i));
                }
                throw failure;
            }
            return new Done(new Saved(String.join("/", segments), EditorView.sha256(bytes), bytes.length));
        }
    }

    /** Removes the text file {@code rel} from the folder {@code root}; never a folder or a protected file. */
    public static Answer delete(Path root, String rel) throws IOException {
        List<String> segments = segments(rel);
        if (segments == null) {
            return HIDDEN;
        }
        for (String name : PROTECTED) {
            if (atRoot(segments, name)) {
                return PROTECTED_FILE;
            }
        }
        synchronized (PlaybookFileWriter.class) {
            Located at = locate(root, segments);
            if (at == null || !at.exists() || segments.size() > PlaybookLoader.WALK_DEPTH) {
                return HIDDEN;
            }
            if (at.dir()) {
                return new Refused(400, "folder", "The path names a folder. Only single files are removed.");
            }
            for (String name : PROTECTED) {
                if (sameFile(root, at, name)) {
                    return PROTECTED_FILE;
                }
            }
            if (at.size() > MAX_TEXT_BYTES) {
                return TOO_LARGE;
            }
            byte[] bytes = readNoFollow(at.path());
            if (bytes == null) {
                return HIDDEN;
            }
            if (textOf(bytes) == null) {
                return BINARY;
            }
            Files.delete(at.path());
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("path", String.join("/", segments));
            out.put("deleted", true);
            return new Done(out);
        }
    }

    /** Whether every folder segment of {@code rel} keeps the loader's segment rule and the file name its extension of it. */
    static boolean nameOk(String rel) {
        List<String> segments = segments(rel);
        return segments != null && nameOk(segments);
    }

    private static boolean nameOk(List<String> segments) {
        for (int i = 0; i < segments.size() - 1; i++) {
            if (!PlaybookValidator.PATH_SEGMENT.matcher(segments.get(i)).matches()) {
                return false;
            }
        }
        return FILE_NAME.matcher(segments.get(segments.size() - 1)).matches();
    }

    /** The segments of a relative path, or null when it is not one this class serves. */
    static List<String> segments(String rel) {
        if (rel == null || rel.isEmpty() || rel.startsWith("/") || rel.indexOf('\\') >= 0 || rel.indexOf('\0') >= 0) {
            return null;
        }
        List<String> out = List.of(rel.split("/", -1));
        for (String segment : out) {
            if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment)) {
                return null;
            }
        }
        try {
            if (Path.of(rel).isAbsolute()) {
                return null;
            }
        } catch (RuntimeException notAPath) {
            return null;
        }
        return out;
    }

    /** Where a path lands, found without following a link. */
    private record Located(Path path, boolean exists, boolean dir, long size) {}

    /**
     * Walks {@code segments} from {@code root} one at a time without following links. Null when a
     * link is met, when something other than a folder stands where a folder is needed, or when the
     * result leaves the folder.
     */
    private static Located locate(Path root, List<String> segments) throws IOException {
        Path at = root;
        for (int i = 0; i < segments.size(); i++) {
            at = at.resolve(segments.get(i));
            if (!at.normalize().startsWith(root)) {
                return null;
            }
            BasicFileAttributes attrs;
            try {
                attrs = Files.readAttributes(at, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            } catch (NoSuchFileException absent) {
                Path rest = at;
                for (int j = i + 1; j < segments.size(); j++) {
                    rest = rest.resolve(segments.get(j));
                }
                return rest.normalize().startsWith(root) ? new Located(rest, false, false, 0) : null;
            }
            boolean last = i == segments.size() - 1;
            if (attrs.isSymbolicLink() || (!last && !attrs.isDirectory())
                    || (last && !attrs.isDirectory() && !attrs.isRegularFile())) {
                return null;
            }
            if (last) {
                return new Located(at, true, attrs.isDirectory(), attrs.isDirectory() ? 0 : attrs.size());
            }
        }
        return null;
    }

    /**
     * Creates the missing folders on the way to the file, one at a time, each checked to be a plain
     * folder after it exists. Answers what it created, or null when a link appeared on the way.
     */
    private static List<Path> createParents(Path root, List<String> segments) throws IOException {
        List<Path> created = new ArrayList<>();
        Path at = root;
        for (int i = 0; i < segments.size() - 1; i++) {
            at = at.resolve(segments.get(i));
            if (!Files.exists(at, LinkOption.NOFOLLOW_LINKS)) {
                Files.createDirectory(at);
                created.add(at);
            }
            BasicFileAttributes attrs = Files.readAttributes(at, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (attrs.isSymbolicLink() || !attrs.isDirectory()) {
                for (int j = created.size() - 1; j >= 0; j--) {
                    Files.deleteIfExists(created.get(j));
                }
                return null;
            }
        }
        return created;
    }

    /** The bytes of a regular file, opened without following a link; null when it is a link now. */
    private static byte[] readNoFollow(Path file) throws IOException {
        try (InputStream in = Channels.newInputStream(Files.newByteChannel(file,
                Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)))) {
            return in.readNBytes((int) MAX_TEXT_BYTES + 1);
        } catch (IOException refused) {
            if (Files.isSymbolicLink(file)) {
                return null;
            }
            throw refused;
        }
    }

    /** The UTF-8 text of {@code bytes}, or null when they hold a NUL in the first 8 kB or are not UTF-8. */
    static String textOf(byte[] bytes) {
        int sniff = Math.min(bytes.length, SNIFF_BYTES);
        for (int i = 0; i < sniff; i++) {
            if (bytes[i] == 0) {
                return null;
            }
        }
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException notUtf8) {
            return null;
        }
    }

    /** A new file gets {@code rw-r--r--}; the temp file it came from was owner only. */
    private static void plainMode(Path file) throws IOException {
        if (Files.getFileAttributeView(file, PosixFileAttributeView.class) != null) {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
        }
    }

    /** A mutable node while the tree is built. */
    private static final class Draft {
        private final String name;
        private final String rel;
        private final boolean dir;
        private final long size;
        private final List<Draft> children = new ArrayList<>();

        private Draft(String name, String rel, boolean dir, long size) {
            this.name = name;
            this.rel = rel;
            this.dir = dir;
            this.size = size;
        }
    }

    /** Folders first, then names case-insensitive, as the Files panel lists them. */
    private static final Comparator<Draft> ORDER = Comparator.comparing((Draft d) -> !d.dir)
            .thenComparing(d -> d.name, String.CASE_INSENSITIVE_ORDER)
            .thenComparing(d -> d.name);

    private static List<FileNode> freeze(List<Draft> drafts) {
        List<Draft> sorted = new ArrayList<>(drafts);
        sorted.sort(ORDER);
        List<FileNode> out = new ArrayList<>(sorted.size());
        for (Draft d : sorted) {
            out.add(new FileNode(d.name, d.rel, d.dir, d.size, freeze(d.children)));
        }
        return List.copyOf(out);
    }
}
