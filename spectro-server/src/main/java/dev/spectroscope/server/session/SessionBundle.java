package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.wire.BrowserWireRecorder;
import dev.spectroscope.core.wire.LlmWireRecorder;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * The files of one session bundle (card 473): the session file, its llm wire,
 * its browser wire and its child session files, as one zip whose entries are
 * the files on disk byte for byte.
 *
 * <p>Layout: {@code <id>.jsonl}, {@code <id>.llm.jsonl},
 * {@code <id>.browser.jsonl} at the top, child sessions under
 * {@code children/<child-id>.jsonl}. A file that is not on disk is left out,
 * so the entry list is also the import's list of what was found.</p>
 *
 * <p>The session file is caller-shaped text: an imported or edited line can
 * name anything. So a name from the reference fields of its {@code run_start}
 * is used only when it is a plain basename of the expected shape, and the
 * file it resolves to must lie directly in the recorder's own folder. A wire
 * the reference leaves unnamed (a browser wire written after the first run,
 * or a session from before the fields) is found by the id convention.
 * Nothing else is ever read.</p>
 */
final class SessionBundle {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The id shape the store and both recorders mint: never a path, never a dot. */
    static final Pattern SESSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]*");

    private static final Pattern LLM_NAME = Pattern.compile("([A-Za-z0-9][A-Za-z0-9-]*)\\.llm\\.jsonl");
    private static final Pattern BROWSER_NAME = Pattern.compile("([A-Za-z0-9][A-Za-z0-9-]*)\\.browser\\.jsonl");

    /**
     * One entry of the zip.
     *
     * @param name the entry name inside the zip
     * @param file the file whose bytes the entry carries
     */
    record Entry(String name, Path file) {
    }

    private SessionBundle() {
    }

    /**
     * What the bundle of one session carries, in zip order.
     *
     * @param id a session id that already passed the shape check
     * @return the entries whose files exist; the session file is always first
     * @throws IOException when the session file cannot be read
     */
    static List<Entry> entriesFor(String id) throws IOException {
        Path session = SessionStore.sessionFile(id);
        List<Entry> entries = new ArrayList<>();
        entries.add(new Entry(id + ".jsonl", session));
        JsonNode ref = referenceOf(session);
        Path llm = wireFile(ref, "llmWire", LLM_NAME, LlmWireRecorder::fileFor, id);
        if (llm != null) {
            entries.add(new Entry(llm.getFileName().toString(), llm));
        }
        Path browser = wireFile(ref, "browserWire", BROWSER_NAME, BrowserWireRecorder::fileFor, id);
        if (browser != null) {
            entries.add(new Entry(browser.getFileName().toString(), browser));
        }
        Set<String> children = new LinkedHashSet<>();
        if (ref != null && ref.path("children").isArray()) {
            for (JsonNode child : ref.path("children")) {
                String cid = child.asText("");
                if (SESSION_ID.matcher(cid).matches() && !cid.equals(id)) {
                    children.add(cid);
                }
            }
        }
        for (String cid : children) {
            Path file = SessionStore.sessionFile(cid);
            if (Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) && inFolder(file, SessionStore.SESSIONS_DIR)) {
                entries.add(new Entry("children/" + cid + ".jsonl", file));
            }
        }
        return entries;
    }

    /**
     * Writes the entries as one zip.
     *
     * @param entries what {@link #entriesFor} answered
     * @param out     the response stream; left open for the caller
     * @throws IOException when a file cannot be read or the stream breaks
     */
    static void write(List<Entry> entries, OutputStream out) throws IOException {
        ZipOutputStream zip = new ZipOutputStream(out, StandardCharsets.UTF_8);
        for (Entry entry : entries) {
            zip.putNextEntry(new ZipEntry(entry.name()));
            Files.copy(entry.file(), zip);
            zip.closeEntry();
        }
        zip.finish();
    }

    /**
     * The session's file reference (card 473): the {@code llmWire},
     * {@code browserWire} and {@code children} fields of its main agent's
     * {@code run_start} lines, or null for a session written before them.
     * The first name of each wire wins and the child lists are joined, since
     * a later run_start names only a wire that appeared after the first one.
     *
     * @param session the session file
     * @return an object with the merged fields, or null
     * @throws IOException when the file cannot be read
     */
    private static JsonNode referenceOf(Path session) throws IOException {
        com.fasterxml.jackson.databind.node.ObjectNode ref = null;
        try (BufferedReader reader = Files.newBufferedReader(session, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (!line.contains("\"run_start\"") || !line.contains("\"children\"")) {
                    continue;
                }
                JsonNode node;
                try {
                    node = JSON.readTree(line);
                } catch (IOException torn) {
                    continue; // not a line this reader can use
                }
                if (node == null || !"run_start".equals(node.path("type").asText())
                        || node.hasNonNull("parentId") || !node.path("children").isArray()) {
                    continue;
                }
                if (ref == null) {
                    ref = JSON.createObjectNode();
                    ref.putArray("children");
                }
                for (String field : List.of("llmWire", "browserWire")) {
                    if (!ref.has(field) && node.path(field).isTextual()) {
                        ref.put(field, node.path(field).asText());
                    }
                }
                ((com.fasterxml.jackson.databind.node.ArrayNode) ref.path("children"))
                        .addAll((com.fasterxml.jackson.databind.node.ArrayNode) node.path("children"));
            }
        }
        return ref;
    }

    /**
     * The wire file a reference names, or the id convention's file when the
     * session names none. A name of the wrong shape names nothing.
     *
     * @param ref     the reference line, or null
     * @param field   which field of the line names the wire
     * @param shape   the file name shape, with the session id as group 1
     * @param fileFor the recorder's one path rule
     * @param id      the session id, for the convention
     * @return the existing wire file inside the recorder's folder, or null
     */
    private static Path wireFile(JsonNode ref, String field, Pattern shape,
                                 Function<String, Path> fileFor, String id) {
        String base = id;
        if (ref != null && ref.has(field)) {
            Matcher named = shape.matcher(ref.path(field).asText(""));
            if (!named.matches()) {
                return null;
            }
            base = named.group(1);
        }
        Path file = fileFor.apply(base);
        Path folder = fileFor.apply("x").getParent();
        return Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) && inFolder(file, folder) ? file : null;
    }

    /**
     * Whether a file lies directly in a folder, after normalizing both.
     *
     * @param file   the candidate
     * @param folder the folder it must be a direct child of
     * @return true for a direct child
     */
    private static boolean inFolder(Path file, Path folder) {
        Path parent = file.toAbsolutePath().normalize().getParent();
        return parent != null && parent.equals(folder.toAbsolutePath().normalize());
    }
}
