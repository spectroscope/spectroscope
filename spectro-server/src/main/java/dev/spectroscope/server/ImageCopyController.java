package dev.spectroscope.server;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.WorkspaceResolver;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * Copies a generated image from the global content-addressed store
 * ({@code ~/.spectro/images/<sha256>.<ext>}) into a session's workspace — the
 * gallery's "copy to workspace" button. Defense in depth like every workspace
 * endpoint: the image name must be exactly a store name (64 hex + image
 * extension), the session id is shape-guarded, the target name is a single
 * sanitized file name (no separators, no leading dot), and an existing target
 * answers 409 instead of overwriting.
 */
@RestController
public class ImageCopyController {

    /** Exactly a content-addressed store name — anything else never touches the disk. */
    private static final Pattern IMAGE_FILE = Pattern.compile("[0-9a-f]{64}\\.(png|jpg|webp)");

    /** Same session-id shape guard as the sessions DELETE and the files endpoints. */
    private static final Pattern SESSION_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9-]*");

    /** One plain file name: starts alphanumeric, no separators, no traversal. */
    private static final Pattern SAFE_NAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._ -]{0,127}");

    private final Path imagesDir;
    private final Supplier<String> configuredWorkspace;

    /** Production wiring: the user-home image store + the config's workspace key. */
    public ImageCopyController() {
        this(Path.of(System.getProperty("user.home"), ".spectro", "images"),
                () -> SpectroConfig.load(SpectroConfig.Overrides.none()).workspace());
    }

    /**
     * Seam for tests.
     *
     * @param imagesDir the image store to copy from
     * @param configuredWorkspace supplies the config's workspace key (nullable)
     */
    ImageCopyController(Path imagesDir, Supplier<String> configuredWorkspace) {
        this.imagesDir = imagesDir;
        this.configuredWorkspace = configuredWorkspace;
    }

    /**
     * The copy request.
     *
     * @param file the store name ({@code <sha256>.<ext>}) of the image to copy
     * @param session the session whose workspace receives the copy
     * @param name the target file name, or null/blank to keep the store name
     */
    record CopyRequest(String file, String session, String name) {}

    /**
     * {@code POST /api/images/copy-to-workspace}: copies one stored image into
     * the session's workspace under the requested (or original) name.
     *
     * @param request the copy request
     * @return 200 {@code {path}} on success, 400 for malformed inputs, 404 for
     *         an unknown image or workspace, 409 when the target exists
     */
    @PostMapping("/api/images/copy-to-workspace")
    public ResponseEntity<?> copy(@RequestBody CopyRequest request) {
        if (request.file() == null || !IMAGE_FILE.matcher(request.file()).matches()) {
            return ResponseEntity.badRequest().body(Map.of("message", "Not a stored image name."));
        }
        if (request.session() == null || !SESSION_ID.matcher(request.session()).matches()) {
            return ResponseEntity.badRequest().body(Map.of("message", "Malformed session id."));
        }
        Path source = imagesDir.resolve(request.file());
        if (!Files.isRegularFile(source)) {
            return ResponseEntity.notFound().build();
        }
        String pinned = SessionWorkspaces.pinned(request.session());
        Path workspace = WorkspaceResolver.locate(
                pinned != null ? pinned : configuredWorkspace.get(), request.session());
        if (!Files.isDirectory(workspace)) {
            return ResponseEntity.status(404).body(Map.of("message", "Workspace not found."));
        }
        String targetName = targetName(request.name(), request.file());
        if (targetName == null) {
            return ResponseEntity.badRequest().body(Map.of("message", "Invalid target file name."));
        }
        Path target = workspace.resolve(targetName).normalize();
        if (!workspace.equals(target.getParent())) {
            return ResponseEntity.badRequest().body(Map.of("message", "Invalid target file name."));
        }
        if (Files.exists(target)) {
            return ResponseEntity.status(409)
                    .body(Map.of("message", "A file named \"" + targetName + "\" already exists."));
        }
        try {
            Files.copy(source, target);
        } catch (IOException copyFailed) {
            return ResponseEntity.status(500)
                    .body(Map.of("message", "Copy failed: " + copyFailed.getMessage()));
        }
        return ResponseEntity.ok(Map.of("path", targetName));
    }

    /**
     * The sanitized target name: blank keeps the store name; a custom name
     * without an extension inherits the original's (so "strandkatze" becomes
     * "strandkatze.png"). Null when the name cannot be made safe.
     *
     * @param requested the user's name, may be null/blank
     * @param originalFile the store name the extension comes from
     * @return the safe file name, or null to refuse
     */
    static String targetName(String requested, String originalFile) {
        String name = requested == null || requested.isBlank() ? originalFile : requested.strip();
        if (!SAFE_NAME.matcher(name).matches()) {
            return null;
        }
        if (!name.contains(".")) {
            name += originalFile.substring(originalFile.lastIndexOf('.'));
        }
        return name;
    }
}
