package dev.spectroscope.server.observability;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.wire.BrowserWireRecorder;
import dev.spectroscope.server.web.LocalOrigin;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The read side of the browser record (card 204): the sidecar the
 * {@link BrowserWireRecorder} writes under {@code ~/.spectro/browser-wire/},
 * served three ways — the whole file as a download, a bodiless ledger the replay
 * view scrubs, and one action's two lines on demand. The path rule lives in
 * {@link BrowserWireRecorder#fileFor} alone, so writer and readers can never
 * disagree about where a session's browser record is.
 *
 * <p>Fenced exactly like {@link LlmWireController} next door: the global
 * {@code /api} fence is the floor, and each handler keeps the loopback+Host and
 * Origin checks, because this file carries every address the agent visited and
 * every script it ran. The id becomes a file name, so it wears the same shape
 * check; the cid is a recorder-minted UUID and is checked against exactly that
 * shape.
 *
 * <p><b>Per session, and the id is the whole authority.</b> There is one file per
 * session id and the id can name nothing else — no traversal, no dot, no slash.
 * A caller asking for another session's id therefore gets that session's own
 * record or a 404, and never a mixture; the browser was per session (card 218)
 * and the trace of it stays that way.
 */
@RestController
public class BrowserWireController {

    /** The Spring-instantiated read side; it holds no state of its own. */
    public BrowserWireController() {
    }

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Session ids as the store mints them (yyyyMMdd-HHmmss-uuid8) plus the
     *  test/CLI-friendly general shape: never a path, never a dot. */
    private static final Pattern SESSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]*");

    /** Call ids as the recorder mints them: {@code UUID.randomUUID()}, lowercase
     *  hex; anything else never touches a comparison. */
    private static final Pattern CID = Pattern.compile(
            "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");

    /**
     * The whole sidecar, verbatim: the browser-record twin of the session export.
     *
     * @param id      the session whose browser record is read
     * @param request the servlet request, for the local fence
     * @return 200 with the NDJSON body as a download; 404 for a foreign caller,
     *         a malformed id or a session that never drove a browser
     */
    @GetMapping("/api/sessions/{id}/browser-wire")
    public ResponseEntity<String> download(@PathVariable String id, HttpServletRequest request) {
        Path file = fencedFile(id, request);
        if (file == null) {
            return ResponseEntity.status(404).build();
        }
        try {
            // Recorded page text and model-authored scripts = caller-shaped text.
            // Served as a download with a non-HTML type and nosniff, like the
            // session export, so it can never reach an HTML parsing context here.
            return ResponseEntity.ok()
                    .contentType(new MediaType("application", "x-ndjson", StandardCharsets.UTF_8))
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Content-Disposition",
                            "attachment; filename=\"" + id + ".browser.jsonl\"")
                    .body(Files.readString(file));
        } catch (IOException unreadable) {
            return ResponseEntity.status(404).build();
        }
    }

    /**
     * The bodiless ledger the replay view scrubs: one object per action in file
     * order, the call and its result paired by {@code cid} while STREAMING the
     * file. Arguments and result text are read past and never returned — a
     * scrubber needs to know THAT a screenshot exists and which blob it is, not
     * what the page said.
     *
     * @param id      the session whose browser record is indexed
     * @param request the servlet request, for the local fence
     * @return 200 with the action metadata array; 404 for a foreign caller, a
     *         malformed id or a session that never drove a browser
     */
    @GetMapping("/api/sessions/{id}/browser-wire/index")
    public ResponseEntity<List<Map<String, Object>>> index(@PathVariable String id,
                                                           HttpServletRequest request) {
        Path file = fencedFile(id, request);
        if (file == null) {
            return ResponseEntity.status(404).build();
        }
        // Insertion-ordered by cid: entries appear in call order, and a result
        // landing later (parallel subagents interleave) finds its pair.
        Map<String, Map<String, Object>> entries = new LinkedHashMap<>();
        try (BufferedReader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                JsonNode node;
                try {
                    node = JSON.readTree(line);
                } catch (IOException torn) {
                    continue; // a torn tail line (crash mid-write) is not the ledger's problem
                }
                switch (node.path("type").asText()) {
                    case "browser_call" -> entries.put(node.path("cid").asText(), openEntry(node));
                    case "browser_result" -> {
                        Map<String, Object> entry = entries.get(node.path("cid").asText());
                        if (entry != null) {
                            closeEntry(entry, node);
                        }
                    }
                    default -> { } // the open and ceiling markers carry no action
                }
            }
        } catch (IOException unreadable) {
            return ResponseEntity.status(404).build();
        }
        return ResponseEntity.ok(new ArrayList<>(entries.values()));
    }

    /**
     * One action's two recorded lines, parsed: the drill-in behind a scrubber
     * step. The scan stops as soon as both are found, so an early action in a
     * long run never costs a full read.
     *
     * @param id      the session whose browser record is scanned
     * @param cid     the action id, UUID shape only
     * @param request the servlet request, for the local fence
     * @return 200 with {@code {call, result}} ({@code result} null while the call
     *         is still open); 400 for a cid that is not UUID-shaped; 404 for a
     *         foreign caller, a malformed id, a missing sidecar or an unknown
     *         action
     */
    @GetMapping("/api/sessions/{id}/browser-wire/action/{cid}")
    public ResponseEntity<Map<String, Object>> action(@PathVariable String id,
                                                      @PathVariable String cid,
                                                      HttpServletRequest request) {
        Path file = fencedFile(id, request);
        if (file == null) {
            return ResponseEntity.status(404).build();
        }
        // 400 rather than the sibling's 404, and the difference is deliberate.
        // A cid is COMPARED here and never resolved to a path, so a shape check
        // on it guards nothing a full scan would not also refuse — which made the
        // first version of this check a line no test could tell the presence of.
        // A check nobody can measure is a check nobody maintains. Answering "you
        // asked wrong" separately from "there is nothing here" is both the honest
        // distinction and the one that makes the check provable: it refuses
        // before a single byte of the sidecar is read.
        if (!CID.matcher(cid).matches()) {
            return ResponseEntity.status(400).build();
        }
        JsonNode callLine = null;
        JsonNode resultLine = null;
        try (BufferedReader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null && (callLine == null || resultLine == null)) {
                JsonNode node;
                try {
                    node = JSON.readTree(line);
                } catch (IOException torn) {
                    continue; // same rule as the index: skip a torn tail line
                }
                if (!cid.equals(node.path("cid").asText())) {
                    continue;
                }
                switch (node.path("type").asText()) {
                    case "browser_call" -> callLine = node;
                    case "browser_result" -> resultLine = node;
                    default -> { }
                }
            }
        } catch (IOException unreadable) {
            return ResponseEntity.status(404).build();
        }
        if (callLine == null) {
            return ResponseEntity.status(404).build();
        }
        // LinkedHashMap because the result half may legitimately be null.
        Map<String, Object> pair = new LinkedHashMap<>();
        pair.put("call", callLine);
        pair.put("result", resultLine);
        return ResponseEntity.ok(pair);
    }

    /**
     * The shared front door of all three reads: the sibling session reads'
     * fences, the id shape check, and the ONE path rule.
     *
     * @param id      the untrusted session id from the URL
     * @param request the servlet request the fences inspect
     * @return the existing sidecar file, or null when anything refuses
     */
    private static Path fencedFile(String id, HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request)
                || !LocalOrigin.originIsLoopbackOrAbsent(request)
                || !SESSION_ID.matcher(id).matches()) {
            return null;
        }
        Path file = BrowserWireRecorder.fileFor(id);
        return Files.isRegularFile(file) ? file : null;
    }

    /**
     * Starts a ledger entry from a {@code browser_call} line: who called what,
     * where, and when — result-half fields at their unfinished defaults so every
     * entry carries the full shape.
     *
     * @param node the parsed call line
     * @return the mutable entry the paired result completes
     */
    private static Map<String, Object> openEntry(JsonNode node) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("cid", node.path("cid").asText());
        entry.put("epoch", node.path("epoch").asInt(0));
        entry.put("agentId", textOrNull(node, "agentId"));
        entry.put("callId", textOrNull(node, "callId"));
        entry.put("tool", textOrNull(node, "tool"));
        entry.put("pageUrl", textOrNull(node, "pageUrl"));
        entry.put("ok", null);
        entry.put("resultBytes", 0L);
        entry.put("durationMs", null);
        entry.put("blobPath", null);
        entry.put("sha256", null);
        entry.put("mediaType", null);
        entry.put("width", 0);
        entry.put("height", 0);
        entry.put("ts", node.path("ts").asLong(0));
        entry.put("startedAt", node.path("ts").asLong(0));
        return entry;
    }

    /**
     * Completes an entry from its {@code browser_result} line. The page address
     * is taken from the result when it has one, because that is where the call
     * ENDED — a navigate's whole point is that the two differ.
     *
     * @param entry the entry its call line opened
     * @param node  the parsed result line
     */
    private static void closeEntry(Map<String, Object> entry, JsonNode node) {
        entry.put("ok", node.path("ok").asBoolean(false));
        entry.put("resultBytes", node.path("resultBytes").asLong(0));
        entry.put("durationMs",
                node.hasNonNull("durationMs") ? node.get("durationMs").asLong() : null);
        if (node.hasNonNull("pageUrl")) {
            entry.put("pageUrl", node.get("pageUrl").asText());
        }
        JsonNode image = node.path("image");
        if (image.isObject()) {
            entry.put("blobPath", textOrNull(image, "blobPath"));
            entry.put("sha256", textOrNull(image, "sha256"));
            entry.put("mediaType", textOrNull(image, "mediaType"));
            entry.put("width", image.path("width").asInt(0));
            entry.put("height", image.path("height").asInt(0));
        }
        entry.put("ts", node.path("ts").asLong(0));
    }

    /** A field's text, or null when absent; the ledger never invents "".
     *  @param node the parsed line
     *  @param field the field name
     *  @return the text value or null */
    private static String textOrNull(JsonNode node, String field) {
        return node.hasNonNull(field) ? node.get(field).asText() : null;
    }
}
