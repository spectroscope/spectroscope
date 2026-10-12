package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.playbook.Finding;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.PlaybookValidator;
import dev.spectroscope.core.playbook.SafeWalk;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.channels.Channels;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * A playbook as one file (card 524): the export of a registered folder as a ZIP, and the import of
 * the entries a browser read from such a ZIP into an empty folder.
 *
 * <p>The export reads every file {@link SafeWalk} lists into memory first and checks it against
 * the rules of the import, so a folder the import would refuse is refused here too, and the bytes
 * sent are the bytes checked. Entries sit under one folder named after the playbook id, in the
 * walk's order, each with the same fixed time, so the same folder gives the same bytes.
 *
 * <p>The import checks every path and every size before a byte reaches the disk, reads
 * {@code playbook.json} from memory, then writes the files into a staged folder beside the
 * target, checks the staged copy as the loader would, and moves it onto the empty target with one
 * atomic move. A refusal at any step leaves the target as it was and removes the staged folder.
 * Nothing is installed: hooks, agents and commands reach the harness only through the install
 * confirmation of card 485.
 */
final class PlaybookBundle {

    /** The most bytes a bundle carries, the installer's ceiling. */
    static final long MAX_BYTES = PlaybookInstaller.MAX_BYTES;
    /** The most files a bundle carries, the loader's ceiling. */
    static final int MAX_FILES = PlaybookLoader.MAX_FILES;
    /** The largest binary file, allowed only under {@code docs/}. */
    static final long MAX_BINARY_BYTES = 2L * 1024 * 1024;
    /** The only folder a binary file may sit in. */
    static final String BINARY_FOLDER = "docs";
    /** The longest path an entry may name. */
    static final int MAX_PATH_CHARS = 512;
    /** The time every entry of an export carries, so two exports of one folder are the same bytes. */
    static final LocalDateTime ENTRY_TIME = LocalDateTime.of(1980, 1, 1, 0, 0);
    /** Finder writes this file into any folder it shows; it never belongs to a playbook. */
    static final String FINDER_FILE = ".DS_Store";

    private PlaybookBundle() {
    }

    // ---- export ------------------------------------------------------------------------------

    /** What an export answers: the files to send, or why the folder is not sent. */
    sealed interface Export permits Ready, NotReady, Credential {}

    /**
     * A folder that may travel.
     *
     * @param id    the playbook id, the name of the one top folder
     * @param files relative path to bytes, in the walk's order
     */
    record Ready(String id, Map<String, byte[]> files) implements Export {}

    /**
     * A folder that may not travel.
     *
     * @param findings one per reason
     */
    record NotReady(List<Finding> findings) implements Export {}

    /**
     * A folder whose hooks file carries a credential in a hook command (card 538).
     *
     * @param findings one per command, each naming the line and the rule
     */
    record Credential(List<Finding> findings) implements Export {}

    /**
     * Reads the registered folder {@code root} for an export and checks it against the rules of
     * the import.
     *
     * @param root the real path of a registered folder
     * @return the files, or the findings that stop the export
     * @throws IOException when the folder cannot be walked or a file cannot be read
     */
    static Export prepare(Path root) throws IOException {
        SafeWalk.Walk walk = SafeWalk.walk(root, root);
        List<Finding> findings = new ArrayList<>();
        for (String line : walk.refused()) {
            int at = line.lastIndexOf(": ");
            findings.add(at < 0 ? new Finding(line, "refused") : new Finding(line.substring(0, at), line.substring(at + 2)));
        }
        List<String> rels = walk.files().stream().filter(rel -> !isFinderFile(rel)).toList();
        if (rels.size() > MAX_FILES) {
            findings.add(new Finding("", "the folder holds more than " + MAX_FILES + " files"));
            return new NotReady(findings);
        }
        Map<String, byte[]> files = new LinkedHashMap<>();
        long total = 0;
        for (String rel : rels) {
            if (!pathOk(rel)) {
                findings.add(new Finding(rel, "a name the import refuses; names start with a letter or a digit and "
                        + "hold only letters, digits, '_' and '-', a file name may add extensions after a dot"));
                continue;
            }
            if (tooDeep(rel)) {
                findings.add(new Finding(rel, "deeper than " + PlaybookLoader.WALK_DEPTH
                        + " levels; the app reads a playbook to " + PlaybookLoader.WALK_DEPTH + " levels only"));
                continue;
            }
            byte[] bytes = readNoFollow(root, rel);
            if (bytes == null) {
                findings.add(new Finding(rel, "a symbolic link"));
                continue;
            }
            total += bytes.length;
            if (total > MAX_BYTES) {
                findings.add(new Finding("", "the folder holds more than 24 MB"));
                return new NotReady(findings);
            }
            String binary = binaryProblem(rel, bytes);
            if (binary != null) {
                findings.add(new Finding(rel, binary));
                continue;
            }
            files.put(rel, bytes);
        }
        List<Finding> credentials = credentials(files);
        if (!credentials.isEmpty()) {
            return new Credential(credentials);
        }
        byte[] json = files.get(PlaybookFolders.PLAYBOOK_FILE);
        if (json == null) {
            findings.add(new Finding(PlaybookFolders.PLAYBOOK_FILE, "missing"));
            return new NotReady(findings);
        }
        Playbook p = check(root, new String(json, StandardCharsets.UTF_8), findings);
        if (!findings.isEmpty()) {
            return new NotReady(findings);
        }
        if (!PlaybookController.BUNDLE_ID.matcher(p.id()).matches()) {
            return new NotReady(List.of(new Finding("id", "not an id a file may be named after")));
        }
        return new Ready(p.id(), files);
    }

    /**
     * Writes the files as one ZIP, each under {@code <id>/}, with the fixed entry time.
     *
     * @param ready what {@link #prepare} answered
     * @param out   the response stream; left open for the caller
     * @throws IOException when the stream breaks
     */
    static void write(Ready ready, OutputStream out) throws IOException {
        ZipOutputStream zip = new ZipOutputStream(out, StandardCharsets.UTF_8);
        for (Map.Entry<String, byte[]> file : ready.files().entrySet()) {
            ZipEntry entry = new ZipEntry(ready.id() + "/" + file.getKey());
            entry.setTimeLocal(ENTRY_TIME);
            zip.putNextEntry(entry);
            zip.write(file.getValue());
            zip.closeEntry();
        }
        zip.finish();
    }

    // ---- import ------------------------------------------------------------------------------

    /**
     * Writes a bundle into the empty folder {@code dirText} and registers it.
     *
     * @param folders  the known folders, where a written folder is registered
     * @param dirText  the target folder as the client named it
     * @param entries  the entries, each {@code {path, text}} or {@code {path, base64}}
     * @return the real path of the written folder, or a refusal
     * @throws IOException when the staged write or the move fails for a reason that is no refusal
     */
    static Outcome importInto(PlaybookFolders folders, String dirText, JsonNode entries) throws IOException {
        if (dirText.isEmpty()) {
            return refused(400, "bad-request", "A target folder ('dir') is required.");
        }
        if (entries == null || !entries.isArray() || entries.isEmpty()) {
            return refused(400, "bad-request", "The bundle has no entries.");
        }
        if (entries.size() > MAX_FILES) {
            return refused(413, "too-many-files", "The bundle holds more than " + MAX_FILES + " files.");
        }
        Map<String, byte[]> files = new LinkedHashMap<>();
        Set<String> folded = new HashSet<>();
        long total = 0;
        for (JsonNode entry : entries) {
            String rel = entry.path("path").isTextual() ? entry.path("path").asText() : null;
            if (rel == null) {
                return refused(400, "bad-request", "Every entry needs a 'path'.");
            }
            if (!pathOk(rel)) {
                return refused(400, "path", "Refusing the path '" + printable(rel) + "': a path is relative, uses '/', "
                        + "has no empty, '.' or '..' part, and every name starts with a letter or a digit and holds "
                        + "only letters, digits, '_' and '-', a file name may add extensions after a dot.");
            }
            if (tooDeep(rel)) {
                return refused(400, "too-deep", "The entry '" + rel + "' lies deeper than " + PlaybookLoader.WALK_DEPTH
                        + " levels. The app reads a playbook to " + PlaybookLoader.WALK_DEPTH + " levels only.");
            }
            if (!folded.add(rel.toLowerCase(Locale.ROOT))) {
                return refused(400, "duplicate", "Two entries name the file '" + rel + "'.");
            }
            byte[] bytes;
            if (entry.path("text").isTextual()) {
                bytes = entry.path("text").asText().getBytes(StandardCharsets.UTF_8);
                if (PlaybookFiles.textOf(bytes) == null) {
                    return refused(415, "binary", "The entry '" + rel + "' is sent as text but holds a NUL byte.");
                }
            } else if (entry.path("base64").isTextual()) {
                if (!underBinaryFolder(rel)) {
                    return refused(400, "binary", "The binary file '" + rel + "' is outside docs/. A bundle carries "
                            + "binary files only under docs/.");
                }
                try {
                    bytes = Base64.getDecoder().decode(entry.path("base64").asText());
                } catch (IllegalArgumentException notBase64) {
                    return refused(400, "bad-request", "The entry '" + rel + "' is not valid base64.");
                }
                if (bytes.length > MAX_BINARY_BYTES) {
                    return refused(413, "too-large", "The binary file '" + rel + "' is larger than 2 MB.");
                }
            } else {
                return refused(400, "bad-request", "The entry '" + rel + "' carries neither 'text' nor 'base64'.");
            }
            total += bytes.length;
            if (total > MAX_BYTES) {
                return refused(413, "too-large", "The bundle holds more than 24 MB.");
            }
            files.put(rel, bytes);
        }
        for (String rel : files.keySet()) {
            String[] segments = rel.split("/");
            StringBuilder folder = new StringBuilder();
            for (int i = 0; i < segments.length - 1; i++) {
                folder.append(i == 0 ? "" : "/").append(segments[i]);
                if (folded.contains(folder.toString().toLowerCase(Locale.ROOT))) {
                    return refused(400, "duplicate", "The path '" + folder + "' is both a file and a folder.");
                }
            }
        }
        List<Finding> credentials = credentials(files);
        if (!credentials.isEmpty()) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("reason", "token");
            body.put("message", credentialSentence(credentials, "Nothing was written."));
            body.put("findings", credentials);
            return new Outcome(422, body, null);
        }
        byte[] json = files.get(PlaybookFolders.PLAYBOOK_FILE);
        if (json == null) {
            return refused(400, "no-playbook", "The bundle has no playbook.json in its top folder.");
        }
        if (json.length > PlaybookLoader.MAX_BYTES) {
            return refused(413, "too-large", "The playbook.json of the bundle is larger than 1 MB.");
        }
        PlaybookReader.Read read = PlaybookReader.read(new String(json, StandardCharsets.UTF_8));
        if (read.playbook() == null) {
            return findings(read.findings());
        }

        Path target;
        try {
            Path named = Path.of(dirText);
            if (!named.isAbsolute()) {
                return refused(400, "bad-request", "The target folder must be an absolute path.");
            }
            target = named.toRealPath();
        } catch (IOException | RuntimeException missing) {
            return refused(400, "bad-request", "Not a folder: " + dirText);
        }
        if (!Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)) {
            return refused(400, "bad-request", "Not a folder: " + dirText);
        }
        if (!empty(target)) {
            return notEmpty();
        }
        Path parent = target.getParent();
        if (parent == null) {
            return refused(400, "bad-request", "The target folder cannot be the root of the disk.");
        }

        Path staged = parent.resolve("." + target.getFileName() + ".playbook-import-" + System.nanoTime());
        boolean moved = false;
        try {
            Files.createDirectory(staged);
            for (Map.Entry<String, byte[]> file : files.entrySet()) {
                Path destination = staged.resolve(file.getKey()).normalize();
                if (!destination.startsWith(staged)) {
                    return refused(400, "path", "Refusing the path '" + printable(file.getKey()) + "'.");
                }
                Files.createDirectories(destination.getParent());
                Files.write(destination, file.getValue(), StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE,
                        LinkOption.NOFOLLOW_LINKS);
            }
            List<Finding> findings = new ArrayList<>();
            check(staged.toRealPath(), Files.readString(staged.resolve(PlaybookFolders.PLAYBOOK_FILE),
                    StandardCharsets.UTF_8), findings);
            SafeWalk.walk(staged, staged).refused().forEach(line -> findings.add(new Finding(line, "refused")));
            if (!findings.isEmpty()) {
                return findings(findings);
            }
            if (!moveOnto(staged, target)) {
                return notEmpty();
            }
            moved = true;
        } finally {
            if (!moved) {
                deleteTree(staged);
            }
        }
        folders.register(target);
        return new Outcome(200, Map.of(), target);
    }

    /**
     * Moves the staged folder onto the target in one atomic move. A rename onto an empty folder
     * replaces it; onto a folder that holds anything it fails, so a file that arrived between the
     * look and the move stops it.
     *
     * @param staged the staged folder, beside the target
     * @param target the empty target folder
     * @return true when the staged folder is now the target; false when the target was not empty
     * @throws IOException when the move fails for another reason
     */
    static boolean moveOnto(Path staged, Path target) throws IOException {
        if (!empty(target)) {
            return false;
        }
        try {
            Files.move(staged, target, StandardCopyOption.ATOMIC_MOVE);
            return true;
        } catch (FileSystemException taken) {
            if (!empty(target)) {
                return false;
            }
            throw taken;
        }
    }

    // ---- shared rules --------------------------------------------------------------------------

    /**
     * The texts of {@code hooks/hooks.json} among {@code files} that carry a credential shape: every
     * string value and field name, the command and the matcher among them. The file name is compared
     * in any case, since a disk that ignores case reads any spelling of it as the hooks file.
     */
    private static List<Finding> credentials(Map<String, byte[]> files) {
        List<Finding> out = new ArrayList<>();
        files.forEach((rel, bytes) -> {
            if (rel.equalsIgnoreCase(HookTokens.HOOKS_FILE)) {
                out.addAll(HookTokens.findings(rel, new String(bytes, StandardCharsets.UTF_8)));
            }
        });
        return out;
    }

    /**
     * The sentence of a credential refusal: the file, the first line and its rule, and what was not
     * done. The value is never in it.
     */
    static String credentialSentence(List<Finding> credentials, String tail) {
        Finding first = credentials.get(0);
        String more = credentials.size() > 1 ? " (and " + (credentials.size() - 1) + " more)" : "";
        String file = first.path().substring(0, first.path().lastIndexOf(':'));
        return file + " " + first.message() + more + ". A bundle never carries a hooks file in which one of the "
                + "app's key patterns matches. The check knows only these patterns, so other secrets, such as a "
                + "password after a command option, are not found. " + tail;
    }

    /** Reader, validator and the contents check on {@code json} as the folder {@code root}'s file. */
    private static Playbook check(Path root, String json, List<Finding> findings) {
        PlaybookReader.Read read = PlaybookReader.read(json);
        findings.addAll(read.findings());
        Playbook p = read.playbook();
        if (p == null) {
            return null;
        }
        findings.addAll(PlaybookValidator.validate(p));
        findings.addAll(PlaybookLoader.contentsFindings(root, p.contents()));
        return p;
    }

    /** Whether {@code rel} is a path the import writes: the editor's segment and name rules; the depth is {@link #tooDeep}. */
    static boolean pathOk(String rel) {
        return rel != null && rel.length() <= MAX_PATH_CHARS && PlaybookFiles.nameOk(rel);
    }

    /** Whether {@code rel} lies below {@link PlaybookLoader#WALK_DEPTH}, where the loader and the file routes never reach. */
    static boolean tooDeep(String rel) {
        return rel.split("/").length > PlaybookLoader.WALK_DEPTH;
    }

    /** Why the bytes of {@code rel} may not travel, or null when they may. */
    private static String binaryProblem(String rel, byte[] bytes) {
        if (PlaybookFiles.textOf(bytes) != null) {
            return null;
        }
        if (!underBinaryFolder(rel)) {
            return "a binary file outside docs/; a bundle carries binary files only under docs/";
        }
        return bytes.length > MAX_BINARY_BYTES ? "a binary file larger than 2 MB" : null;
    }

    private static boolean underBinaryFolder(String rel) {
        return rel.startsWith(BINARY_FOLDER + "/");
    }

    private static boolean isFinderFile(String rel) {
        return rel.equals(FINDER_FILE) || rel.endsWith("/" + FINDER_FILE);
    }

    /** The bytes of {@code rel} below {@code root}, walked without following a link; null on a link. */
    private static byte[] readNoFollow(Path root, String rel) throws IOException {
        Path at = root;
        String[] segments = rel.split("/");
        for (int i = 0; i < segments.length; i++) {
            at = at.resolve(segments[i]);
            BasicFileAttributes attrs = Files.readAttributes(at, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            boolean last = i == segments.length - 1;
            if (attrs.isSymbolicLink() || (last ? !attrs.isRegularFile() : !attrs.isDirectory())) {
                return null;
            }
        }
        try (InputStream in = Channels.newInputStream(Files.newByteChannel(at,
                Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)))) {
            return in.readNBytes((int) MAX_BYTES + 1);
        }
    }

    private static boolean empty(Path folder) throws IOException {
        try (Stream<Path> list = Files.list(folder)) {
            return list.findAny().isEmpty();
        }
    }

    private static void deleteTree(Path root) {
        if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path path : walk.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        } catch (IOException stubborn) {
            // the staged folder stays; it is hidden and named after the import
        }
    }

    /** A path for a sentence: control characters shown as '?'. */
    private static String printable(String rel) {
        StringBuilder out = new StringBuilder();
        rel.codePoints().forEach(c -> out.appendCodePoint(Character.isISOControl(c) ? '?' : c));
        return out.toString();
    }

    /**
     * How an import ended.
     *
     * @param status  the HTTP status
     * @param body    the refusal's body: {@code reason}, {@code message} and for a 422 {@code findings}
     * @param written the real path of the written and registered folder; null on a refusal
     */
    record Outcome(int status, Map<String, Object> body, Path written) {}

    private static Outcome refused(int status, String reason, String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("reason", reason);
        body.put("message", message);
        return new Outcome(status, body, null);
    }

    private static Outcome notEmpty() {
        return refused(409, "not-empty", "The target folder is not empty. A playbook is imported only into an empty folder.");
    }

    /** The bundle's playbook does not load cleanly; nothing was written. */
    private static Outcome findings(List<Finding> findings) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("reason", "findings");
        body.put("message", "The playbook in the bundle does not load cleanly; nothing was written.");
        body.put("findings", List.copyOf(findings));
        return new Outcome(422, body, null);
    }
}
