package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.server.web.LocalOrigin;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

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
 * The playbook routes: the known folders and the pin per workspace, loading a
 * registered folder, and copying a bundled playbook into a folder the owner
 * picked.
 *
 * <p>Only registered folders load, so the wire cannot make the server read an
 * arbitrary directory. Every write wears the fence of
 * {@link dev.spectroscope.server.starter.BundleController#scaffold}: JSON
 * bodies only, a loopback caller, and a loopback or absent Origin; anything
 * else gets a blank 404.
 */
@RestController
public class PlaybookController {

    /** The classpath folder the shipped playbooks live in, one folder per id. */
    static final String BUNDLE_ROOT = "bundled-playbooks";
    static final Pattern BUNDLE_ID = Pattern.compile("[a-z][a-z0-9-]*");

    private final PlaybookFolders folders;
    private final String bundleRoot;

    public PlaybookController() {
        this(PlaybookFolders.inHome(), BUNDLE_ROOT);
    }

    PlaybookController(PlaybookFolders folders, String bundleRoot) {
        this.folders = folders;
        this.bundleRoot = bundleRoot;
    }

    /** GET /api/playbooks?workspace= : the known folders and the one pinned to the workspace. */
    @GetMapping("/api/playbooks")
    public Map<String, Object> list(@RequestParam(value = "workspace", required = false) String workspace) {
        return state(workspace);
    }

    /** POST /api/playbooks/folders {dir} : registers a folder that holds a playbook.json. */
    @PostMapping(value = "/api/playbooks/folders", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> register(@RequestBody JsonNode body, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        String dir = text(body, "dir");
        if (dir.isEmpty()) {
            return badRequest("A folder ('dir') is required.");
        }
        try {
            folders.register(Path.of(dir));
        } catch (IllegalArgumentException refused) {
            return badRequest(refused.getMessage());
        }
        return ResponseEntity.ok(state(text(body, "workspace")));
    }

    /** PUT /api/playbooks/active {workspace, dir} : pins a registered folder to a workspace. */
    @PutMapping(value = "/api/playbooks/active", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> pin(@RequestBody JsonNode body, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        String workspace = text(body, "workspace");
        String dir = text(body, "dir");
        if (workspace.isEmpty() || dir.isEmpty()) {
            return badRequest("A workspace and a folder ('workspace', 'dir') are required.");
        }
        try {
            folders.pin(Path.of(workspace), Path.of(dir));
        } catch (IllegalArgumentException refused) {
            return badRequest(refused.getMessage());
        }
        return ResponseEntity.ok(state(workspace));
    }

    /** {@code GET /api/playbooks/load?dir=&workspace=} : a registered folder, loaded. */
    @GetMapping("/api/playbooks/load")
    public ResponseEntity<?> load(@RequestParam("dir") String dir,
                                  @RequestParam(value = "workspace", required = false) String workspace) {
        Path real = registered(dir);
        if (real == null) {
            return badRequest("Not a registered playbook folder: " + dir);
        }
        return ResponseEntity.ok(PlaybookLoader.load(real, workspaceOf(workspace, real), config()));
    }

    /** The largest draft body the check reads. */
    static final int MAX_BODY_BYTES = 1024 * 1024;

    /** {@code GET /api/playbooks/draft?dir=&workspace=} : the editor view of a registered folder's file. */
    @GetMapping("/api/playbooks/draft")
    public ResponseEntity<?> getDraft(@RequestParam("dir") String dir,
                                      @RequestParam(value = "workspace", required = false) String workspace) {
        Path real = registered(dir);
        if (real == null) {
            return badRequest("unknown folder");
        }
        return ResponseEntity.ok(EditorView.ofDisk(real, workspaceOf(workspace, real), config()));
    }

    /**
     * {@code POST /api/playbooks/draft?dir=&workspace=} with the draft as the body : the editor view of the
     * body, checked as a load would check it. Writes nothing. The fence answers first, then the size, then
     * the folder.
     */
    @PostMapping(value = "/api/playbooks/draft", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> postDraft(@RequestParam("dir") String dir,
                                       @RequestParam(value = "workspace", required = false) String workspace,
                                       @RequestBody String body, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BODY_BYTES) {
            return ResponseEntity.status(413).body(Map.of("message", "The draft is larger than 1 MB."));
        }
        Path real = registered(dir);
        if (real == null) {
            return badRequest("unknown folder");
        }
        byte[] disk;
        try {
            Path file = real.resolve(PlaybookFolders.PLAYBOOK_FILE);
            disk = Files.isRegularFile(file) && Files.size(file) <= PlaybookLoader.MAX_BYTES
                    ? Files.readAllBytes(file) : new byte[0];
        } catch (IOException unreadable) {
            disk = new byte[0];
        }
        return ResponseEntity.ok(EditorView.of(real, body, disk, workspaceOf(workspace, real), config()));
    }

    /**
     * POST /api/playbooks/bundled/{id}/copy {dir} : writes a shipped playbook
     * into the folder and registers it. Like the scaffold, it resolves every
     * target first, refuses a path outside the folder, and writes nothing when
     * any target exists (409 with the paths).
     */
    @PostMapping(value = "/api/playbooks/bundled/{id}/copy", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> copy(@PathVariable String id, @RequestBody JsonNode body, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        Map<String, Resource> files = BUNDLE_ID.matcher(id).matches() ? bundled(id) : Map.of();
        if (files.isEmpty()) {
            return ResponseEntity.status(404).body(Map.of("message", "Unknown bundled playbook: " + id));
        }
        String dirText = text(body, "dir");
        if (dirText.isEmpty()) {
            return badRequest("A target folder ('dir') is required.");
        }
        Path dir = Path.of(dirText);
        if (!Files.isDirectory(dir)) {
            return badRequest("Not a folder: " + dirText);
        }
        Path root;
        try {
            root = dir.toRealPath();
        } catch (IOException e) {
            return badRequest("Not a folder: " + dirText);
        }

        Map<Path, Resource> targets = new LinkedHashMap<>();
        List<String> conflicts = new ArrayList<>();
        for (Map.Entry<String, Resource> entry : files.entrySet()) {
            Path target = root.resolve(entry.getKey()).normalize();
            if (!target.startsWith(root)) {
                return badRequest("Refusing a path outside the folder: " + entry.getKey());
            }
            if (Files.exists(target)) {
                conflicts.add(entry.getKey());
            }
            targets.put(target, entry.getValue());
        }
        if (!conflicts.isEmpty()) {
            return ResponseEntity.status(409).body(Map.of(
                    "message", "Some files already exist in the folder; nothing was written.",
                    "conflicts", conflicts));
        }

        List<String> written = new ArrayList<>();
        try {
            for (Map.Entry<Path, Resource> entry : targets.entrySet()) {
                Files.createDirectories(entry.getKey().getParent());
                try (var in = entry.getValue().getInputStream()) {
                    Files.write(entry.getKey(), in.readAllBytes());
                }
                written.add(root.relativize(entry.getKey()).toString());
            }
        } catch (IOException failure) {
            return ResponseEntity.status(500).body(Map.of(
                    "message", "Failed to write the playbook: " + failure.getMessage(), "written", written));
        }
        try {
            folders.register(root);
        } catch (IllegalArgumentException refused) {
            return ResponseEntity.status(500).body(Map.of(
                    "message", "Copied, but the folder could not be registered: " + refused.getMessage(),
                    "written", written));
        }
        return ResponseEntity.ok(Map.of("dir", root.toString(), "written", written));
    }

    /** The shipped playbook {@code id} as path below its folder to resource; empty when there is none. */
    Map<String, Resource> bundled(String id) {
        String anchor = bundleRoot + "/" + id + "/";
        Map<String, Resource> files = new LinkedHashMap<>();
        Resource[] found;
        try {
            found = new PathMatchingResourcePatternResolver().getResources("classpath*:" + anchor + "**");
        } catch (IOException unreadable) {
            return Map.of();
        }
        for (Resource resource : found) {
            String url;
            try {
                url = String.valueOf(resource.getURL());
            } catch (IOException unreadable) {
                continue;
            }
            if (url.endsWith("/") || !resource.isReadable()) {
                continue; // a directory comes back as a non-readable resource
            }
            int at = url.lastIndexOf(anchor);
            if (at < 0) {
                continue; // never guessed, only skipped
            }
            String rel = url.substring(at + anchor.length());
            if (!rel.isEmpty()) {
                files.put(rel, resource);
            }
        }
        return files;
    }

    private Map<String, Object> state(String workspace) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("folders", folders.read().folders());
        Path active = workspace == null || workspace.isBlank() ? null : folders.activeFor(Path.of(workspace));
        out.put("active", active == null ? null : active.toString());
        return out;
    }

    /** The real path of {@code dir} when it is a registered folder, else null. */
    private Path registered(String dir) {
        if (dir == null || dir.isBlank()) {
            return null;
        }
        try {
            Path real = Path.of(dir).toRealPath();
            return folders.read().folders().contains(real.toString()) ? real : null;
        } catch (IOException | RuntimeException missing) {
            return null;
        }
    }

    private static Path workspaceOf(String workspace, Path folder) {
        return workspace == null || workspace.isBlank() ? folder : Path.of(workspace);
    }

    private static SpectroConfig config() {
        return SpectroConfig.load(SpectroConfig.Overrides.none());
    }

    private static boolean fenced(HttpServletRequest request) {
        return LocalOrigin.isLocalOrigin(request) && LocalOrigin.originIsLoopbackOrAbsent(request);
    }

    private static String text(JsonNode body, String field) {
        return body == null ? "" : body.path(field).asText("").strip();
    }

    private static ResponseEntity<Map<String, String>> badRequest(String message) {
        return ResponseEntity.badRequest().body(Map.of("message", message));
    }
}
