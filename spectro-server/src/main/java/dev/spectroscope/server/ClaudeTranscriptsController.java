package dev.spectroscope.server;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * Read-only browser for the Claude Code transcript store under
 * {@code ~/.claude/projects}. The folder is invisible in Finder, so the web
 * import dialog cannot reach it through a file chooser — these two endpoints
 * list the *.jsonl transcripts and hand one over for the import path.
 *
 * Strictly sandboxed: only files inside the base directory, only .jsonl, the
 * requested path is resolved canonically before it is read (no traversal, no
 * symlink escape — request parameters are untrusted input).
 */
@RestController
@CrossOrigin(origins = "*")
public class ClaudeTranscriptsController {

    /**
     * One transcript in the listing; path is relative to the base.
     *
     * @param path the base-relative path — what the content endpoint takes back
     * @param project the first path segment, i.e. the Claude Code project folder
     * @param file the bare file name
     * @param size file size in bytes (0 when the file vanished mid-listing)
     * @param modifiedAt last-modified epoch millis — the listing sorts by this
     */
    public record TranscriptInfo(String path, String project, String file, long size, long modifiedAt) {}

    private static final int MAX_LISTED = 300;
    private static final long MAX_CONTENT_BYTES = 64L * 1024 * 1024;

    private final Path base;

    /** Spring wiring: the real transcript store under {@code ~/.claude/projects}. */
    public ClaudeTranscriptsController() {
        this(Path.of(System.getProperty("user.home"), ".claude", "projects"));
    }

    /**
     * Seam for tests: point the controller at a throwaway base directory.
     *
     * @param base the directory to treat as the sandboxed transcript store
     */
    ClaudeTranscriptsController(Path base) {
        this.base = base;
    }

    /**
     * All *.jsonl transcripts under the base, newest first, capped.
     *
     * @return the transcript descriptors — an absent or unreadable store answers
     *         an empty list, never an error (browsing must not break the dialog)
     */
    @GetMapping("/api/claude/transcripts")
    public List<TranscriptInfo> transcripts() {
        if (!Files.isDirectory(base)) {
            return List.of();
        }
        try (Stream<Path> walk = Files.walk(base, 4)) {
            return walk
                    .filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().endsWith(".jsonl"))
                    .map(this::describe)
                    .sorted(Comparator.comparingLong(TranscriptInfo::modifiedAt).reversed())
                    .limit(MAX_LISTED)
                    .toList();
        } catch (IOException unreadable) {
            return List.of();
        }
    }

    /**
     * One transcript's raw JSONL — the client runs it through detectAndLoad.
     *
     * @param rel the base-relative path from the listing — canonicalized and
     *            checked against the real base before any read
     * @return 200 with the UTF-8 body; 400 for a non-.jsonl name, 404 for
     *         anything outside the base or missing, 413 above the 64 MB cap
     */
    @GetMapping("/api/claude/transcripts/content")
    public ResponseEntity<String> content(@RequestParam("path") String rel) {
        if (!rel.endsWith(".jsonl")) {
            return ResponseEntity.badRequest().build();
        }
        try {
            Path requested = base.resolve(rel).normalize();
            // Canonical check: the REAL location must stay inside the REAL base.
            Path real = requested.toRealPath();
            if (!real.startsWith(base.toRealPath()) || !Files.isRegularFile(real)) {
                return ResponseEntity.notFound().build();
            }
            if (Files.size(real) > MAX_CONTENT_BYTES) {
                return ResponseEntity.status(413).build();
            }
            return ResponseEntity.ok()
                    .contentType(new MediaType(MediaType.TEXT_PLAIN, StandardCharsets.UTF_8))
                    .body(Files.readString(real, StandardCharsets.UTF_8));
        } catch (IOException missing) {
            return ResponseEntity.notFound().build();
        }
    }

    /**
     * Builds one listing row — stat failures degrade to zeros rather than
     * dropping the file from the list.
     *
     * @param file the absolute transcript path under the base
     * @return the descriptor with base-relative path, project folder and stat data
     */
    private TranscriptInfo describe(Path file) {
        Path rel = base.relativize(file);
        String project = rel.getNameCount() > 1 ? rel.getName(0).toString() : "";
        long size;
        long modified;
        try {
            size = Files.size(file);
            modified = Files.getLastModifiedTime(file).toMillis();
        } catch (IOException gone) {
            size = 0;
            modified = 0;
        }
        return new TranscriptInfo(
                rel.toString(), project, file.getFileName().toString(), size, modified);
    }
}
