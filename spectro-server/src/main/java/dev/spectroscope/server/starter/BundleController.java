package dev.spectroscope.server.starter;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.server.web.LocalOrigin;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The starter-bundle endpoints. Newcomers list the bundles, fetch one as a
 * copy-paste file set, or scaffold it straight into a folder they picked (via
 * the same native picker as the workspace, {@code /api/pick-workspace}).
 *
 * <p>No {@code @CrossOrigin}: the scaffold endpoint writes files, so it stays
 * same-origin only (like {@link dev.spectroscope.server.settings.SettingsController}) —
 * a foreign page cannot make the local server write to disk. The write wears
 * the complete write-endpoint template: {@code consumes=json} forces the
 * preflight a cross-origin page cannot pass, {@link LocalOrigin#isLocalOrigin}
 * blocks a DNS-rebound hostname (which IS same-origin, so preflight alone would
 * miss it), and {@link LocalOrigin#originIsLoopbackOrAbsent} closes the
 * Origin gap — the exact bar the key writer and the settings PUTs carry.
 */
@RestController
public class BundleController {

    /** GET /api/bundles — the catalog for the picker. */
    @GetMapping("/api/bundles")
    public Map<String, Object> list() {
        List<Map<String, Object>> items = StarterBundles.list().stream()
                .map(b -> Map.<String, Object>of(
                        "id", b.id(), "name", b.name(), "description", b.description(), "fleet", b.fleet()))
                .toList();
        return Map.of("bundles", items,
                "buildTools", List.of("gradle", "maven", "python", "bash"),
                "version", StarterBundles.VERSION);
    }

    /** GET /api/bundles/{id}?build=gradle — the rendered file set (copy-paste). */
    @GetMapping("/api/bundles/{id}")
    public ResponseEntity<?> get(@PathVariable String id,
                                 @RequestParam(value = "build", required = false) String build) {
        StarterBundles.BuildTool tool = StarterBundles.BuildTool.of(build);
        Map<String, String> files = StarterBundles.files(id, tool);
        if (files == null) {
            return ResponseEntity.status(404).body(Map.of("message", "Unknown bundle: " + id));
        }
        return ResponseEntity.ok(Map.of("id", id, "buildTool", tool.name().toLowerCase(), "files", files));
    }

    /**
     * POST /api/bundles/{id}/scaffold {dir, build} — write the bundle's files
     * into {@code dir}. Read-only-safe by construction: it writes ONLY the
     * bundle's own relative files, into a folder the user picked, and refuses to
     * overwrite anything that already exists (409 with the conflicting paths).
     *
     * @return 200 {written, dir}; 400 missing/not-a-directory dir; 404 unknown
     *         bundle; 409 files already present; 500 on an I/O failure
     */
    @PostMapping(value = "/api/bundles/{id}/scaffold", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> scaffold(@PathVariable String id, @RequestBody JsonNode body,
                                      HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request) || !LocalOrigin.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.notFound().build(); // blank 404, like the fleet writes
        }
        String dirText = body.path("dir").asText("").strip();
        if (dirText.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("message", "A target folder ('dir') is required."));
        }
        Map<String, String> files = StarterBundles.files(id, StarterBundles.BuildTool.of(body.path("build").asText(null)));
        if (files == null) {
            return ResponseEntity.status(404).body(Map.of("message", "Unknown bundle: " + id));
        }
        Path dir = Path.of(dirText);
        if (!Files.isDirectory(dir)) {
            return ResponseEntity.badRequest().body(Map.of("message", "Not a folder: " + dirText));
        }
        Path root = dir.toAbsolutePath().normalize();

        // First pass: resolve every target, reject any path escaping the folder,
        // and refuse to overwrite an existing file — nothing is written yet.
        Map<Path, String> targets = new java.util.LinkedHashMap<>();
        List<String> conflicts = new ArrayList<>();
        for (Map.Entry<String, String> entry : files.entrySet()) {
            Path target = root.resolve(entry.getKey()).normalize();
            if (!target.startsWith(root)) {
                return ResponseEntity.badRequest().body(Map.of("message", "Refusing a path outside the folder: " + entry.getKey()));
            }
            if (Files.exists(target)) {
                conflicts.add(entry.getKey());
            }
            targets.put(target, entry.getValue());
        }
        if (!conflicts.isEmpty()) {
            return ResponseEntity.status(409).body(Map.of(
                    "message", "Some files already exist in the folder — nothing was written.",
                    "conflicts", conflicts));
        }

        // Second pass: write. (A partial failure is reported honestly.)
        List<String> written = new ArrayList<>();
        try {
            for (Map.Entry<Path, String> entry : targets.entrySet()) {
                Files.createDirectories(entry.getKey().getParent());
                Files.writeString(entry.getKey(), entry.getValue(), StandardCharsets.UTF_8);
                written.add(root.relativize(entry.getKey()).toString());
            }
        } catch (IOException failure) {
            return ResponseEntity.status(500).body(Map.of(
                    "message", "Failed to write the bundle: " + failure.getMessage(), "written", written));
        }
        return ResponseEntity.ok(Map.of("dir", root.toString(), "written", written));
    }
}
