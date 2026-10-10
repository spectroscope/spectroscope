package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.playbook.run.PinnedPlaybook;
import dev.spectroscope.core.skills.Skill;
import dev.spectroscope.core.skills.SkillLibrary;
import dev.spectroscope.server.providers.ProviderRegistry;
import dev.spectroscope.server.providers.ProviderRow;
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
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
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
    private final Function<SpectroConfig, List<ProviderRow>> providerRows;

    public PlaybookController() {
        this(PlaybookFolders.inHome(), BUNDLE_ROOT);
    }

    PlaybookController(PlaybookFolders folders, String bundleRoot) {
        this(folders, bundleRoot, config -> ProviderRegistry.shared().rows(config));
    }

    /** Seam for tests: the provider rows the start preview reads, without a request to any provider. */
    PlaybookController(PlaybookFolders folders, String bundleRoot,
                       Function<SpectroConfig, List<ProviderRow>> providerRows) {
        this.folders = folders;
        this.bundleRoot = bundleRoot;
        this.providerRows = providerRows;
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
        Path ws = workspace == null || workspace.isBlank() ? real : Path.of(workspace);
        return ResponseEntity.ok(PlaybookLoader.load(real, ws, SpectroConfig.load(SpectroConfig.Overrides.none())));
    }

    /**
     * {@code GET /api/playbooks/start-preview?dir=&workspace=} : the
     * confirmation of a run (card 482). Fenced like every write, because the
     * hash it returns is what a start frame must repeat. Provider rows come
     * from the registry without a request, and a browser can answer a
     * question, so the preview assumes someone is there to ask.
     *
     * @param dir       a registered playbook folder
     * @param workspace the session's working folder, for installed skills
     * @param request   the servlet request, for the local fence
     * @return 200 with the preview; 400 for a folder that is not registered or cannot be pinned; 404 for a foreign caller
     */
    @GetMapping("/api/playbooks/start-preview")
    public ResponseEntity<PlaybookStartPreview> startPreview(@RequestParam("dir") String dir,
                                                             @RequestParam("workspace") String workspace,
                                                             HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        Path real = registered(dir);
        if (real == null || workspace == null || workspace.isBlank()) {
            return ResponseEntity.badRequest().build();
        }
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none());
        Path ws = Path.of(workspace);
        PlaybookLoader.Loaded loaded = PlaybookLoader.load(real, ws, config);
        PinnedPlaybook pinned = null;
        if (loaded.playbook() != null && loaded.findings().isEmpty()) {
            SkillLibrary skills = SkillLibrary.load(SkillLibrary.defaultRoots(ws));
            try {
                pinned = PinnedPlaybook.pin(real, loaded.playbook(),
                        name -> skills.find(name).map(Skill::body).orElse(null));
            } catch (IOException | RuntimeException unreadable) {
                return ResponseEntity.badRequest().build();
            }
        }
        Map<String, ProviderRow> rows = new LinkedHashMap<>();
        providerRows.apply(config).forEach(r -> rows.put(r.id(), r));
        return ResponseEntity.ok(PlaybookStartPreview.of(loaded, pinned, rows::get, true));
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
