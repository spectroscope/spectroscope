package dev.spectroscope.server;

import jakarta.servlet.http.HttpServletRequest;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The doctor page's live server log (card 85): the rolling
 * {@code ~/.spectro/logs/spectroscope.log} the shared logback.xml writes,
 * served as a tail plus cheap incremental deltas — the client polls with the
 * returned byte offset and receives only what was appended since. Wears the
 * full local fence ({@link FleetController#isLocalOrigin} + Origin check):
 * the log names workspaces, model hosts and prompts-in-errors, none of which
 * a foreign page may read. No {@code @CrossOrigin} — the UI is same-origin.
 */
@RestController
public class LogsController {

    /** Hard cap per response — the newest bytes win, it is a tail. */
    static final int MAX_RESPONSE_BYTES = 256 * 1024;

    /** Default/maximum line counts for the no-offset tail request. */
    private static final int DEFAULT_TAIL_LINES = 200;
    private static final int MAX_TAIL_LINES = 1000;

    /** Seam: where the log lives (real: the logback file under the user home). */
    private final Supplier<Path> logFile;

    /** Spring wiring — the shared logback.xml's rolling file. */
    public LogsController() {
        this(() -> Path.of(System.getProperty("user.home"), ".spectro", "logs", "spectroscope.log"));
    }

    /**
     * Seam constructor for tests.
     *
     * @param logFile the log file source
     */
    LogsController(Supplier<Path> logFile) {
        this.logFile = logFile;
    }

    /**
     * Read the log: without {@code offset} the last {@code limit} lines, with
     * {@code offset} the bytes appended since that offset (capped; a shrunk
     * file — logback rotation — resets to a fresh tail).
     *
     * @param offset  the byte offset of the previous poll's end, or null
     * @param limit   tail line count for the no-offset form (clamped)
     * @param request the servlet request, for the local-origin fence
     * @return 404 for a non-local caller, rebound Host or cross-site Origin;
     *         else {content, offset, size} — offset is the next poll's cursor
     */
    @GetMapping("/api/logs")
    public ResponseEntity<Map<String, Object>> logs(
            @RequestParam(value = "offset", required = false) Long offset,
            @RequestParam(value = "limit", required = false, defaultValue = "" + DEFAULT_TAIL_LINES) int limit,
            HttpServletRequest request) {
        if (!FleetController.isLocalOrigin(request)
                || !FleetController.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.status(404).build(); // no fingerprint in the refusal
        }
        Path file = logFile.get();
        try {
            if (!Files.isRegularFile(file)) {
                return ResponseEntity.ok(payload("", 0L)); // fresh install: no log yet
            }
            long size = Files.size(file);
            if (offset == null || offset > size || offset < 0) {
                // First poll or a rotated/truncated file: an honest fresh tail.
                return ResponseEntity.ok(payload(tail(file, size,
                        Math.max(1, Math.min(limit, MAX_TAIL_LINES))), size));
            }
            long from = Math.max(offset, size - MAX_RESPONSE_BYTES); // newest bytes win
            return ResponseEntity.ok(payload(readRange(file, from, size), size));
        } catch (IOException unreadable) {
            // A mid-rotation read can lose the race — the next poll recovers.
            return ResponseEntity.ok(payload("", offset == null ? 0L : offset));
        }
    }

    private static Map<String, Object> payload(String content, long offset) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("content", content);
        out.put("offset", offset);
        return out;
    }

    /** The last {@code lines} lines within the byte cap — read from the end. */
    private static String tail(Path file, long size, int lines) throws IOException {
        long from = Math.max(0, size - MAX_RESPONSE_BYTES);
        String chunk = readRange(file, from, size);
        int seen = 0;
        for (int at = chunk.length() - 1; at >= 0; at--) {
            if (chunk.charAt(at) == '\n' && at < chunk.length() - 1 && ++seen == lines) {
                return chunk.substring(at + 1);
            }
        }
        return chunk;
    }

    /** Reads [from, to) as UTF-8, capped to {@link #MAX_RESPONSE_BYTES}. */
    private static String readRange(Path file, long from, long to) throws IOException {
        int length = (int) Math.min(to - from, MAX_RESPONSE_BYTES);
        if (length <= 0) {
            return "";
        }
        try (RandomAccessFile raf = new RandomAccessFile(file.toFile(), "r")) {
            raf.seek(from);
            byte[] bytes = new byte[length];
            raf.readFully(bytes);
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }
}
