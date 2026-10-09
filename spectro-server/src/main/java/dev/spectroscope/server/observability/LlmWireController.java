package dev.spectroscope.server.observability;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.wire.LlmWireRecorder;
import dev.spectroscope.server.fleet.FleetController;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The read side of the backend-to-LLM record (card 184): the sidecar file the
 * {@link LlmWireRecorder} writes under {@code ~/.spectro/llm-wire/}, served
 * three ways. The whole file as a download, a bodiless index the trace UI can
 * list cheaply, and one exchange's two lines on demand. The path rule lives in
 * {@link LlmWireRecorder#fileFor} alone, so writer and readers can never
 * disagree about where a session's wire record is.
 *
 * <p>Fenced like the session export next door: the global {@code /api} fence
 * is the floor, and each handler keeps the loopback+Host and Origin checks the
 * sibling session reads wear, because the sidecar carries full prompts and
 * responses. The id becomes a file name, so it wears the same shape check as
 * export and delete; the xid is a recorder-minted UUID and is checked against
 * exactly that shape.</p>
 */
@RestController
public class LlmWireController {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Session ids as the store mints them (yyyyMMdd-HHmmss-uuid8) plus the
     *  test/CLI-friendly general shape: never a path, never a dot. */
    private static final Pattern SESSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]*");

    /** Exchange ids as the recorder mints them: {@code UUID.randomUUID()},
     *  lowercase hex; anything else never touches a comparison. */
    private static final Pattern XID = Pattern.compile(
            "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");

    /**
     * The whole sidecar: the wire-record twin of the session export. Decoded
     * leniently: every well-formed line is served as written, and a malformed
     * byte sequence anywhere (a torn tail after a crash, or a line torn
     * mid-file by a second writer) is replaced by U+FFFD instead of turning
     * the whole wire into a 404.
     *
     * @param id      the session whose sidecar is read
     * @param request the servlet request, for the local fence
     * @return 200 with the NDJSON body as a download; 404 for a foreign
     *         caller, a malformed id or a session without a wire record
     */
    @GetMapping("/api/sessions/{id}/llm-wire")
    public ResponseEntity<String> download(@PathVariable String id, HttpServletRequest request) {
        Path file = fencedFile(id, request);
        if (file == null) {
            return ResponseEntity.status(404).build();
        }
        try {
            // Decoded leniently (card 473): a crash can leave half a UTF-8
            // character at the end, a second writer can tear a line in the
            // middle, and the reader skips a line that does not parse anyway.
            // A strict read threw, and the whole wire answered 404.
            String jsonl = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
            // The body is recorded LLM traffic = caller-shaped text. Served as
            // a download with a non-HTML type and nosniff, like the session
            // export, so it can never reach an HTML parsing context here.
            return ResponseEntity.ok()
                    .contentType(new MediaType("application", "x-ndjson", StandardCharsets.UTF_8))
                    .header("X-Content-Type-Options", "nosniff")
                    .header("Content-Disposition", "attachment; filename=\"" + id + ".llm.jsonl\"")
                    .body(jsonl);
        } catch (IOException unreadable) {
            return ResponseEntity.status(404).build();
        }
    }

    /**
     * The bodiless ledger: one object per exchange in request order, request
     * and response lines paired by {@code xid}. {@link LlmWireIndex} reads the
     * file in one pass and skips bodies and stream lines without holding them,
     * because one sidecar can be orders of magnitude bigger than the session
     * it records. Each object carries exactly the {@code llm_exchange} frame's
     * fields; a request still waiting for its response reports {@code status}
     * null.
     *
     * @param id      the session whose sidecar is indexed
     * @param request the servlet request, for the local fence
     * @return 200 with the exchange metadata array; 404 for a foreign caller,
     *         a malformed id, a session without a wire record or a file that
     *         cannot be read
     */
    @GetMapping("/api/sessions/{id}/llm-wire/index")
    public ResponseEntity<List<Map<String, Object>>> index(@PathVariable String id,
                                                           HttpServletRequest request) {
        Path file = fencedFile(id, request);
        if (file == null) {
            return ResponseEntity.status(404).build();
        }
        try {
            return ResponseEntity.ok(LlmWireIndex.read(file));
        } catch (IOException unreadable) {
            return ResponseEntity.status(404).build();
        }
    }

    /**
     * One exchange's two recorded lines, parsed: the drill-in behind an index
     * row. The scan stops as soon as both lines are found, so an early
     * exchange in a huge sidecar never costs a full read.
     *
     * @param id      the session whose sidecar is scanned
     * @param xid     the exchange id, UUID shape only
     * @param request the servlet request, for the local fence
     * @return 200 with {@code {request, response}} (response null while the
     *         exchange is open); 404 for a foreign caller, a malformed id or
     *         xid, a missing sidecar or an unknown exchange
     */
    @GetMapping("/api/sessions/{id}/llm-wire/exchange/{xid}")
    public ResponseEntity<Map<String, Object>> exchange(@PathVariable String id,
                                                        @PathVariable String xid,
                                                        HttpServletRequest request) {
        Path file = fencedFile(id, request);
        if (file == null || !XID.matcher(xid).matches()) {
            return ResponseEntity.status(404).build();
        }
        JsonNode requestLine = null;
        JsonNode responseLine = null;
        try (BufferedReader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null && (requestLine == null || responseLine == null)) {
                JsonNode node;
                try {
                    node = JSON.readTree(line);
                } catch (IOException torn) {
                    continue; // same rule as the index: skip a torn tail line
                }
                if (!xid.equals(node.path("xid").asText())) {
                    continue;
                }
                switch (node.path("type").asText()) {
                    case "llm_request" -> requestLine = node;
                    case "llm_response" -> responseLine = node;
                    default -> { }
                }
            }
        } catch (IOException unreadable) {
            return ResponseEntity.status(404).build();
        }
        if (requestLine == null) {
            return ResponseEntity.status(404).build();
        }
        // LinkedHashMap because the response half may legitimately be null.
        Map<String, Object> pair = new LinkedHashMap<>();
        pair.put("request", requestLine);
        pair.put("response", responseLine);
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
        Path file = LlmWireRecorder.fileFor(id);
        // Card 473: the import's local fallback reads through here, so the
        // file itself must be a wire, not a link that leads out of the folder.
        return Files.isRegularFile(file, java.nio.file.LinkOption.NOFOLLOW_LINKS) ? file : null;
    }
}
