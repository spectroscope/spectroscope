package dev.spectroscope.server;

import org.springframework.http.MediaType;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.WorkspaceResolver;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

/**
 * Phase 5: the workspace panel's backend — a read-only, sandboxed view of the
 * agent's working directory. {@code GET /api/files} returns the cwd tree
 * (hidden files and build/dependency directories skipped, capped);
 * {@code GET /api/file} serves one file for the preview pane.
 *
 * <p>Sandbox rules, same maxim as the tools ("tool inputs are model output and
 * therefore untrusted" — and URL parameters are user/model input too): the
 * requested path must resolve canonically INSIDE the working directory, hidden
 * or ignored segments are refused, and every served document carries a CSP
 * sandbox header, so an HTML file previews in an opaque origin — its scripts
 * run isolated and can never reach the spectroscope UI or its socket.</p>
 */
@RestController
@CrossOrigin(origins = "*")
public class WorkspaceController {

    /**
     * One tree node; path is relative to the workspace root, '/'-separated.
     *
     * @param name the bare file or directory name
     * @param path the root-relative path — what {@code GET /api/file} takes back
     * @param dir {@code true} for a directory node
     * @param size file size in bytes; 0 for directories and unreadable files
     * @param children the child nodes of a directory, empty for files
     */
    public record FileNode(String name, String path, boolean dir, long size, List<FileNode> children) {}

    /**
     * The tree plus its honesty flag — a capped listing says so.
     *
     * @param root the display name of the workspace root directory
     * @param truncated {@code true} when the entry budget ran out — the tree is incomplete
     * @param entries the top-level nodes, directories first, names case-insensitive
     */
    public record FilesResponse(String root, boolean truncated, List<FileNode> entries) {}

    private static final Set<String> IGNORED_DIRS =
            Set.of(".git", "build", "node_modules", "target", "dist", "out");
    private static final int MAX_DEPTH = 8;
    private static final int MAX_ENTRIES = 2000;
    private static final long MAX_TEXT_BYTES = 2L * 1024 * 1024;
    private static final long MAX_IMAGE_BYTES = 25L * 1024 * 1024;
    /** Every preview document renders in an opaque origin; scripts run isolated. */
    private static final String CSP_SANDBOX = "sandbox allow-scripts";

    private final Path root;

    /** Supplies the configured workspace (or null) — a fresh config read per
     *  request in production, injectable for tests. */
    private final java.util.function.Supplier<String> configuredWorkspace;

    /** Spring wiring: the parameterless root is the server process's working
     *  directory; session lookups read the live config's workspace key. */
    public WorkspaceController() {
        this(Path.of(System.getProperty("user.dir")),
                () -> SpectroConfig.load(SpectroConfig.Overrides.none()).workspace());
    }

    /**
     * Seam for tests: sandbox the controller into a throwaway root.
     *
     * @param root the directory to serve as workspace root — normalized to absolute
     */
    WorkspaceController(Path root) {
        this(root, () -> null);
    }

    /**
     * Full seam: root AND the configured-workspace supplier.
     *
     * @param root the parameterless root
     * @param configuredWorkspace supplies the config's workspace key (nullable)
     */
    WorkspaceController(Path root, java.util.function.Supplier<String> configuredWorkspace) {
        this.root = root.toAbsolutePath().normalize();
        this.configuredWorkspace = configuredWorkspace;
    }

    // ---- the tree -------------------------------------------------------------

    /**
     * {@code GET /api/files}: the whole workspace tree in one response — hidden
     * and ignored directories skipped, capped by depth and entry budget.
     *
     * @return the tree under the root plus the honest truncated flag
     */
    @GetMapping("/api/files")
    public ResponseEntity<FilesResponse> files(
            @RequestParam(value = "session", required = false) String session) {
        Path base;
        try {
            base = rootFor(session);
        } catch (IllegalArgumentException badId) {
            return ResponseEntity.badRequest().build();
        }
        if (!Files.isDirectory(base)) {
            return ResponseEntity.notFound().build(); // no workspace folder (yet)
        }
        int[] budget = {MAX_ENTRIES};
        List<FileNode> entries = list(base, "", 0, budget);
        return ResponseEntity.ok(new FilesResponse(
                base.getFileName() == null ? base.toString() : base.getFileName().toString(),
                budget[0] <= 0, entries));
    }

    /**
     * The tree/content root for a request: without a session parameter, the
     * boot root (unchanged behaviour); with one, THAT session's workspace —
     * a per-session pin (the folder the user picked, shared state with the
     * socket side) wins, else the config/auto rules via
     * {@link WorkspaceResolver#locate} (no directory is ever created by a
     * GET). The id shape is guarded exactly like the sessions DELETE.
     *
     * @param session the session id from the query, or null/blank for the boot root
     * @return the directory to serve
     * @throws IllegalArgumentException for a malformed session id (answered as 400)
     */
    private Path rootFor(String session) {
        if (session == null || session.isBlank()) {
            return root;
        }
        if (!session.matches("[A-Za-z0-9][A-Za-z0-9-]*")) {
            throw new IllegalArgumentException("malformed session id");
        }
        String pinned = SessionWorkspaces.pinned(session);
        return WorkspaceResolver.locate(pinned != null ? pinned : configuredWorkspace.get(), session);
    }

    /**
     * Depth-first directory walk under the shared entry budget — directories
     * first, names case-insensitive, unreadable directories degrade to empty.
     *
     * @param dir the directory to list
     * @param relPrefix the root-relative path of {@code dir} ("" at the root)
     * @param depth current recursion depth — beyond MAX_DEPTH the walk stops
     * @param budget single-element countdown shared across the whole walk — once
     *               spent, every remaining branch is cut
     * @return the child nodes of {@code dir}, possibly cut short by the caps
     */
    private List<FileNode> list(Path dir, String relPrefix, int depth, int[] budget) {
        if (depth > MAX_DEPTH || budget[0] <= 0) {
            return List.of();
        }
        List<Path> children;
        try (var stream = Files.list(dir)) {
            children = new ArrayList<>(stream.toList());
        } catch (IOException unreadable) {
            return List.of();
        }
        children.sort(Comparator
                .comparing((Path p) -> !Files.isDirectory(p))
                .thenComparing(p -> p.getFileName().toString(), String.CASE_INSENSITIVE_ORDER));
        List<FileNode> out = new ArrayList<>();
        for (Path child : children) {
            String name = child.getFileName().toString();
            if (skipped(name)) {
                continue;
            }
            if (budget[0]-- <= 0) {
                break;
            }
            String rel = relPrefix.isEmpty() ? name : relPrefix + "/" + name;
            if (Files.isDirectory(child)) {
                out.add(new FileNode(name, rel, true, 0, list(child, rel, depth + 1, budget)));
            } else {
                long size;
                try {
                    size = Files.size(child);
                } catch (IOException gone) {
                    size = 0;
                }
                out.add(new FileNode(name, rel, false, size, List.of()));
            }
        }
        return out;
    }

    /**
     * The hide rule shared by tree AND content: dot-files and build/dependency
     * directories never leave the server (the .env with the API key answers 404).
     *
     * @param name one bare path segment to test
     * @return {@code true} when the segment must not be exposed
     */
    private static boolean skipped(String name) {
        return name.startsWith(".") || IGNORED_DIRS.contains(name);
    }

    // ---- one file for the preview ----------------------------------------------

    /**
     * {@code GET /api/file}: one file for the preview pane. Every answer carries
     * the CSP sandbox header, so an HTML preview renders in an opaque origin.
     *
     * @param rel the root-relative path from the tree — resolved and checked
     *            against the sandbox before any read
     * @return 200 with typed bytes; 404 for anything outside, hidden, ignored or
     *         missing; 413 over the size caps; 415 for binary content
     */
    @GetMapping("/api/file")
    public ResponseEntity<byte[]> file(@RequestParam("path") String rel,
            @RequestParam(value = "session", required = false) String session) {
        Path base;
        try {
            base = rootFor(session);
        } catch (IllegalArgumentException badId) {
            return ResponseEntity.badRequest().build();
        }
        Path requested;
        try {
            requested = resolveInside(base, rel);
        } catch (IOException outside) {
            return ResponseEntity.notFound().build();
        }
        // Defense in depth: what the tree hides, the content endpoint refuses.
        for (Path segment : base.relativize(requested)) {
            if (skipped(segment.toString())) {
                return ResponseEntity.notFound().build();
            }
        }
        if (!Files.isRegularFile(requested)) {
            return ResponseEntity.notFound().build();
        }
        try {
            long size = Files.size(requested);
            String ext = extension(requested);
            MediaType image = imageType(ext);
            if (image != null) {
                if (size > MAX_IMAGE_BYTES) {
                    return ResponseEntity.status(413).build();
                }
                return ResponseEntity.ok()
                        .header("Content-Security-Policy", CSP_SANDBOX)
                        .contentType(image)
                        .body(Files.readAllBytes(requested));
            }
            if (size > MAX_TEXT_BYTES) {
                return ResponseEntity.status(413).build();
            }
            byte[] bytes = Files.readAllBytes(requested);
            if (!looksLikeText(bytes)) {
                return ResponseEntity.status(415).build(); // binary, no preview
            }
            MediaType type = ("html".equals(ext) || "htm".equals(ext))
                    ? MediaType.TEXT_HTML
                    : new MediaType(MediaType.TEXT_PLAIN, StandardCharsets.UTF_8);
            return ResponseEntity.ok()
                    .header("Content-Security-Policy", CSP_SANDBOX)
                    .contentType(type)
                    .body(bytes);
        } catch (IOException unreadable) {
            return ResponseEntity.notFound().build();
        }
    }

    /**
     * The tools' sandbox rule, applied to a URL parameter.
     *
     * @param relative the untrusted root-relative path from the request
     * @return the normalized absolute path, proven inside the workspace root —
     *         an escape attempt throws instead of returning
     */
    private static Path resolveInside(Path base, String relative) throws IOException {
        Path resolved = base.resolve(relative).normalize();
        if (!resolved.equals(base) && !resolved.startsWith(base + File.separator)) {
            throw new IOException("path is outside the working directory: " + relative);
        }
        return resolved;
    }

    /**
     * The lower-cased file extension without the dot — "" when there is none.
     *
     * @param file the file whose name is inspected
     */
    private static String extension(Path file) {
        String name = file.getFileName().toString();
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase();
    }

    /**
     * Maps an extension to its image media type — the fork between the image
     * path and the text path of the preview endpoint.
     *
     * @param ext the lower-cased extension
     * @return the media type for known image extensions, {@code null} for everything else
     */
    private static MediaType imageType(String ext) {
        return switch (ext) {
            case "png" -> MediaType.IMAGE_PNG;
            case "jpg", "jpeg" -> MediaType.IMAGE_JPEG;
            case "gif" -> MediaType.IMAGE_GIF;
            case "webp" -> MediaType.parseMediaType("image/webp");
            case "svg" -> MediaType.parseMediaType("image/svg+xml");
            case "ico" -> MediaType.parseMediaType("image/x-icon");
            default -> null;
        };
    }

    /**
     * Text heuristic: no NUL byte in the first 8 KiB.
     *
     * @param bytes the file content to probe
     * @return {@code true} when the sample reads as text, {@code false} on a NUL byte
     */
    private static boolean looksLikeText(byte[] bytes) {
        int probe = Math.min(bytes.length, 8192);
        for (int i = 0; i < probe; i++) {
            if (bytes[i] == 0) {
                return false;
            }
        }
        return true;
    }
}
