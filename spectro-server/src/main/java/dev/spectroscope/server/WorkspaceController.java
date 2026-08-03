package dev.spectroscope.server;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

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
 * agent's working directory. {@code GET /api/files} returns the tree of the
 * requesting SESSION's workspace (hidden files and build/dependency
 * directories skipped, capped); {@code GET /api/file} serves one file for the
 * preview pane. Both require a session that has actually resolved a workspace
 * and answer 409 otherwise, see {@link #rootFor}.
 *
 * <p>Sandbox rules, same maxim as the tools ("tool inputs are model output and
 * therefore untrusted" — and URL parameters are user/model input too): the
 * requested path must resolve canonically INSIDE the working directory, hidden
 * or ignored segments are refused, and every served document carries a CSP
 * sandbox header, so an HTML file previews in an opaque origin — its scripts
 * run isolated and can never reach the spectroscope UI or its socket.</p>
 *
 * <p>Canonically means through {@code toRealPath} on both sides, not
 * {@code normalize}. Normalizing is a string operation that never touches the
 * filesystem, so a symlink named like an ordinary file used to walk straight
 * out of the workspace and the read followed it. Both endpoints now compare the
 * REAL location against the REAL root, the way the transcript store does.</p>
 *
 * <p>Both endpoints wear the local-origin fence (card 74). They answer with the
 * operator's own files, and a DNS-rebound page reaches loopback with the
 * attacker's Host, which is the half JavaScript cannot forge.</p>
 */
@RestController
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

    /** The 409 body: the pane must tell "no folder yet" apart from a dead server.
     *
     * @param reason a stable machine-readable token, never a sentence to render
     */
    public record NoWorkspace(String reason) {}

    /** Signals "this request has no workspace behind it", answered as 409. */
    private static final class NoWorkspaceResolved extends RuntimeException {
        NoWorkspaceResolved(String reason) {
            super(reason);
        }
    }

    // ---- the tree -------------------------------------------------------------

    /**
     * {@code GET /api/files}: the whole workspace tree in one response — hidden
     * and ignored directories skipped, capped by depth and entry budget.
     *
     * @param session the session whose workspace is asked for
     * @param request the servlet request, for the local-origin fence
     * @return 404 for a non-local caller or a rebound Host; else the tree under
     *         the root plus the honest truncated flag
     */
    @GetMapping("/api/files")
    public ResponseEntity<?> files(
            @RequestParam(value = "session", required = false) String session,
            HttpServletRequest request) {
        if (!FleetController.isLocalOrigin(request)) {
            return ResponseEntity.status(404).build(); // no fingerprint in the refusal
        }
        Path base;
        try {
            base = rootFor(session);
        } catch (IllegalArgumentException badId) {
            return ResponseEntity.badRequest().build();
        } catch (NoWorkspaceResolved none) {
            return ResponseEntity.status(409).body(new NoWorkspace(none.getMessage()));
        }
        if (!Files.isDirectory(base)) {
            return ResponseEntity.notFound().build(); // no workspace folder (yet)
        }
        Path realBase;
        try {
            realBase = base.toRealPath();
        } catch (IOException gone) {
            return ResponseEntity.notFound().build();
        }
        int[] budget = {MAX_ENTRIES};
        List<FileNode> entries = list(base, "", 0, budget, realBase);
        return ResponseEntity.ok(new FilesResponse(
                base.getFileName() == null ? base.toString() : base.getFileName().toString(),
                budget[0] <= 0, entries));
    }

    /**
     * The tree/content root for a request: THAT session's resolved workspace,
     * and nothing else. The id shape is guarded exactly like the sessions
     * DELETE.
     *
     * <p>There is deliberately no fallback. A sessionless request used to be
     * answered with {@code System.getProperty("user.dir")}, which on a
     * developer machine is the product's own checkout: an unfenced listing of
     * the server's working directory that nobody designed and the UI only ever
     * reached by accident, before the first run, when it had no session id yet.
     * A request with no session behind it has no workspace, and says so.</p>
     *
     * <p>Nor is the configured workspace consulted directly. {@code locate()}
     * short-circuits on a configured path and never looks at the session id, so
     * ANY id, including one that never existed, used to come back with the
     * configured folder as though it were that session's. The socket records
     * every workspace it resolves; this reads that record.</p>
     *
     * @param session the session id from the query
     * @return the directory to serve
     * @throws IllegalArgumentException for a malformed session id (answered as 400)
     * @throws NoWorkspaceResolved when no workspace belongs to this request (409)
     */
    private Path rootFor(String session) {
        if (session == null || session.isBlank()) {
            throw new NoWorkspaceResolved("no-workspace-for-request");
        }
        if (!session.matches("[A-Za-z0-9][A-Za-z0-9-]*")) {
            throw new IllegalArgumentException("malformed session id");
        }
        String resolved = SessionWorkspaces.resolvedPath(session);
        if (resolved == null) {
            throw new NoWorkspaceResolved("no-workspace-for-session");
        }
        return Path.of(resolved).toAbsolutePath().normalize();
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
     * @param realBase the canonical workspace root, so a link out of the tree is
     *                 left out of the listing instead of naming files the
     *                 content endpoint then refuses
     * @return the child nodes of {@code dir}, possibly cut short by the caps
     */
    private List<FileNode> list(Path dir, String relPrefix, int depth, int[] budget, Path realBase) {
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
            if (Files.isSymbolicLink(child) && !insideRealBase(child, realBase)) {
                continue; // a link out of the workspace is not part of the workspace
            }
            if (budget[0]-- <= 0) {
                break;
            }
            String rel = relPrefix.isEmpty() ? name : relPrefix + "/" + name;
            if (Files.isDirectory(child)) {
                out.add(new FileNode(name, rel, true, 0, list(child, rel, depth + 1, budget, realBase)));
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
     * @param session the session whose workspace is asked for
     * @param request the servlet request, for the local-origin fence
     * @return 200 with typed bytes; 404 for a non-local caller or a rebound
     *         Host, and for anything outside, hidden, ignored or missing; 413
     *         over the size caps; 415 for binary content
     */
    @GetMapping("/api/file")
    public ResponseEntity<byte[]> file(@RequestParam("path") String rel,
            @RequestParam(value = "session", required = false) String session,
            HttpServletRequest request) {
        if (!FleetController.isLocalOrigin(request)) {
            return ResponseEntity.status(404).build(); // no fingerprint in the refusal
        }
        Path base;
        try {
            base = rootFor(session);
        } catch (IllegalArgumentException badId) {
            return ResponseEntity.badRequest().build();
        } catch (NoWorkspaceResolved none) {
            return ResponseEntity.status(409).body(none.getMessage().getBytes(StandardCharsets.UTF_8));
        }
        Path realBase;
        Path requested;
        try {
            realBase = base.toRealPath();
            requested = resolveInside(realBase, rel);
        } catch (IOException outside) {
            return ResponseEntity.notFound().build();
        }
        // Defense in depth: what the tree hides, the content endpoint refuses.
        for (Path segment : realBase.relativize(requested)) {
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
     * <p>The comparison is between REAL paths. It used to be
     * {@code normalize()} plus a {@code startsWith} on the string, which is
     * lexical: {@code normalize} resolves {@code ..} in the text and never asks
     * the filesystem anything, while every read below follows links. A file
     * named {@code notes.txt} pointing at {@code ~/.spectro/.env} therefore
     * passed the check and was served, which is exactly what the hide rule
     * exists to prevent. Both sides are canonicalized because the root itself is
     * often a link (a macOS temp folder lives under {@code /var}, which is a
     * link to {@code /private/var}), so real against normalized would refuse
     * every ordinary read instead.</p>
     *
     * @param realBase the canonical workspace root
     * @param relative the untrusted root-relative path from the request
     * @return the canonical absolute path, proven inside the workspace root —
     *         an escape attempt or a missing file throws instead of returning
     */
    private static Path resolveInside(Path realBase, String relative) throws IOException {
        Path real = realBase.resolve(relative).normalize().toRealPath();
        if (!real.equals(realBase) && !real.startsWith(realBase)) {
            throw new IOException("path is outside the working directory: " + relative);
        }
        return real;
    }

    /**
     * Whether a symlink in the tree still points inside the workspace.
     *
     * @param link the child entry to test
     * @param realBase the canonical workspace root
     * @return {@code false} for a link that leaves the root and for a broken one
     */
    private static boolean insideRealBase(Path link, Path realBase) {
        try {
            return link.toRealPath().startsWith(realBase);
        } catch (IOException brokenOrUnreadable) {
            return false;
        }
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
