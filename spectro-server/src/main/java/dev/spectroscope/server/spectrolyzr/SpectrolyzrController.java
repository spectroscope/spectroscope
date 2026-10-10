package dev.spectroscope.server.spectrolyzr;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.server.playbooks.PlaybookFolders;
import dev.spectroscope.server.starter.FolderWriter;
import dev.spectroscope.server.web.LocalOrigin;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The Spectrolyzr routes: the catalog the wizard offers, a preview of the
 * files one set of choices renders, and the generate route that writes them.
 *
 * <p>Generate wears the same fence as the scaffold route: {@code consumes=json}
 * forces the preflight a cross-origin page cannot pass,
 * {@link LocalOrigin#isLocalOrigin} blocks a DNS-rebound hostname and
 * {@link LocalOrigin#originIsLoopbackOrAbsent} closes the Origin gap; a failed
 * check is a blank 404. Both folders are planned (contained, never overwritten)
 * before the first byte is written, the project is written before the
 * playbook, and only then is the playbook folder registered and pinned to the
 * project. Catalog and preview write nothing and need no fence.
 */
@RestController
public class SpectrolyzrController {

    static final String RESOURCE_ROOT = "spectrolyzr";
    private static final String PROJECT = "project";
    private static final String PLAYBOOK = "playbook";

    private final Manifest manifest;
    private final PlaybookFolders folders;

    public SpectrolyzrController() {
        this(shipped(), PlaybookFolders.inHome());
    }

    SpectrolyzrController(Manifest manifest, PlaybookFolders folders) {
        this.manifest = manifest;
        this.folders = folders;
    }

    private static Manifest shipped() {
        ManifestReader.Read read = ManifestReader.read(RESOURCE_ROOT);
        if (read.manifest() == null || !read.problems().isEmpty()) {
            throw new IllegalStateException("The Spectrolyzr manifest is broken: " + read.problems());
        }
        return read.manifest();
    }

    /** {@code GET /api/spectrolyzr}: the archetypes, languages and add-ons, in manifest order. */
    @GetMapping("/api/spectrolyzr")
    public ResponseEntity<?> catalog() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("archetypes", manifest.archetypes().stream()
                .map(a -> choice(a.id(), a.name(), a.description())).toList());
        out.put("languages", manifest.languages().stream()
                .map(l -> Map.<String, Object>of("id", l.id(), "name", l.name())).toList());
        out.put("addons", manifest.addons().stream()
                .map(a -> choice(a.id(), a.name(), a.description())).toList());
        return ResponseEntity.ok(out);
    }

    /**
     * {@code GET /api/spectrolyzr/preview}: the files one set of choices renders,
     * each with its reason, and the test and check commands. An unknown value is
     * a 400 naming its field; nothing falls back to a default.
     */
    @GetMapping("/api/spectrolyzr/preview")
    public ResponseEntity<?> preview(@RequestParam(value = "archetype", required = false) String archetype,
                                     @RequestParam(value = "language", required = false) String language,
                                     @RequestParam(value = "addons", required = false) String addons,
                                     @RequestParam(value = "name", required = false) String name) {
        List<String> chosen = new ArrayList<>();
        if (addons != null) {
            for (String id : addons.split(",")) {
                if (!id.isBlank()) {
                    chosen.add(id.strip());
                }
            }
        }
        Choices choices = new Choices(archetype, language, chosen, name);
        List<RenderedFile> files;
        try {
            files = Spectrolyzr.render(manifest, choices);
        } catch (ChoiceException refused) {
            return refusal(refused.field(), refused.getMessage());
        } catch (IllegalStateException broken) {
            return ResponseEntity.status(500).body(Map.of("message", broken.getMessage()));
        }
        Manifest.Language lang = language(language);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("files", files.stream().map(SpectrolyzrController::fileView).toList());
        out.put("commands", Map.of("test", lang.commands().get("test"),
                "check", lang.commands().get(chosen.contains(Spectrolyzr.QUALITY_GATE) ? "gate" : "test")));
        return ResponseEntity.ok(out);
    }

    /**
     * {@code POST /api/spectrolyzr/generate} with {@code archetype, language,
     * addons, name, dir, playbookDir}: writes the project and, with the
     * playbook add-on, the playbook folder, and pins the latter to the former.
     *
     * @return 200 {@code {project:{dir,written}, playbook:{dir,written}|null, pinned}};
     *         400 {@code {message, field}}; 409 {@code {message, conflicts:{project,playbook}}}
     *         with nothing written; 500 {@code {message, written:{project,playbook}}}; a blank 404 outside the local origin
     */
    @PostMapping(value = "/api/spectrolyzr/generate", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> generate(@RequestBody JsonNode body, HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request) || !LocalOrigin.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.notFound().build();
        }
        List<String> chosen = new ArrayList<>();
        JsonNode addons = body.path("addons");
        if (!addons.isMissingNode() && !addons.isNull()) {
            if (!addons.isArray()) {
                return refusal("addons", "The add-ons must be a list of ids.");
            }
            addons.forEach(item -> chosen.add(item.asText("")));
        }
        Choices choices = new Choices(text(body, "archetype"), text(body, "language"), chosen, text(body, "name"));
        List<RenderedFile> files;
        try {
            files = Spectrolyzr.render(manifest, choices);
        } catch (ChoiceException refused) {
            return refusal(refused.field(), refused.getMessage());
        } catch (IllegalStateException broken) {
            return ResponseEntity.status(500).body(Map.of("message", broken.getMessage()));
        }
        Map<String, String> projectFiles = rootFiles(files, PROJECT);
        Map<String, String> playbookFiles = rootFiles(files, PLAYBOOK);
        boolean withPlaybook = !playbookFiles.isEmpty();

        Path dir;
        try {
            dir = absolute(text(body, "dir"), "dir", "A project folder ('dir') is required.");
        } catch (FieldException refused) {
            return refusal(refused.field, refused.getMessage());
        }
        Path playbookDir = null;
        if (withPlaybook) {
            try {
                playbookDir = absolute(text(body, "playbookDir"), "playbookDir",
                        "A playbook folder ('playbookDir') is required with the playbook add-on.");
            } catch (FieldException refused) {
                return refusal(refused.field, refused.getMessage());
            }
            if (overlaps(dir, playbookDir)) {
                return refusal("playbookDir", "The playbook folder must be a separate folder: neither the project "
                        + "folder, nor inside it, nor around it.");
            }
        }

        FolderWriter.Planned projectPlan = FolderWriter.plan(dir, projectFiles, true);
        FolderWriter.Planned playbookPlan = withPlaybook ? FolderWriter.plan(playbookDir, playbookFiles, true) : null;
        ResponseEntity<?> unusable = unusable(projectPlan, "dir", dir);
        if (unusable == null && playbookPlan != null) {
            unusable = unusable(playbookPlan, "playbookDir", playbookDir);
        }
        if (unusable != null) {
            return unusable;
        }
        List<String> projectConflicts = conflicts(projectPlan);
        List<String> playbookConflicts = playbookPlan == null ? List.of() : conflicts(playbookPlan);
        if (!projectConflicts.isEmpty() || !playbookConflicts.isEmpty()) {
            return ResponseEntity.status(409).body(Map.of(
                    "message", "Some files already exist in the folders. Nothing was written.",
                    "conflicts", Map.of(PROJECT, projectConflicts, PLAYBOOK, playbookConflicts)));
        }

        FolderWriter.Result projectResult = FolderWriter.write((FolderWriter.Ready) projectPlan);
        if (!(projectResult instanceof FolderWriter.Written projectWritten)) {
            return failed(projectResult, PROJECT, List.of(), List.of());
        }
        FolderWriter.Written playbookWritten = null;
        if (playbookPlan != null) {
            FolderWriter.Result playbookResult = FolderWriter.write((FolderWriter.Ready) playbookPlan);
            if (!(playbookResult instanceof FolderWriter.Written written)) {
                return failed(playbookResult, PLAYBOOK, projectWritten.written(), List.of());
            }
            playbookWritten = written;
            try {
                folders.register(Path.of(written.dir()));
                folders.pin(Path.of(projectWritten.dir()), Path.of(written.dir()));
            } catch (IllegalArgumentException | UncheckedIOException failure) {
                return ResponseEntity.status(500).body(Map.of(
                        "message", "The files were written, but the playbook folder could not be pinned: "
                                + failure.getMessage(),
                        "written", Map.of(PROJECT, projectWritten.written(), PLAYBOOK, written.written())));
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put(PROJECT, Map.of("dir", projectWritten.dir(), "written", projectWritten.written()));
        out.put(PLAYBOOK, playbookWritten == null ? null
                : Map.of("dir", playbookWritten.dir(), "written", playbookWritten.written()));
        out.put("pinned", playbookWritten != null);
        return ResponseEntity.ok(out);
    }

    // ------------------------------------------------------------ helpers

    private Manifest.Language language(String id) {
        return manifest.languages().stream().filter(l -> l.id().equals(id)).findFirst().orElseThrow();
    }

    private static Map<String, Object> choice(String id, Manifest.Text name, Manifest.Text description) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id);
        out.put("name", text(name));
        out.put("description", text(description));
        return out;
    }

    private static Map<String, String> text(Manifest.Text text) {
        return Map.of("en", text.en(), "de", text.de());
    }

    private static Map<String, Object> fileView(RenderedFile file) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("root", file.root());
        out.put("path", file.path());
        out.put("why", text(file.why()));
        out.put("size", file.content().getBytes(StandardCharsets.UTF_8).length);
        out.put("content", file.content());
        return out;
    }

    private static Map<String, String> rootFiles(List<RenderedFile> files, String root) {
        Map<String, String> out = new LinkedHashMap<>();
        for (RenderedFile file : files) {
            if (file.root().equals(root)) {
                out.put(file.path(), file.content());
            }
        }
        return out;
    }

    private static String text(JsonNode body, String field) {
        JsonNode node = body == null ? null : body.get(field);
        return node == null || node.isNull() ? null : node.asText("").strip();
    }

    private static ResponseEntity<Map<String, String>> refusal(String field, String message) {
        return ResponseEntity.badRequest().body(Map.of("message", message, "field", field));
    }

    private static final class FieldException extends Exception {
        private final String field;

        FieldException(String field, String message) {
            super(message);
            this.field = field;
        }
    }

    private static Path absolute(String text, String field, String missing) throws FieldException {
        if (text == null || text.isEmpty()) {
            throw new FieldException(field, missing);
        }
        Path path;
        try {
            path = Path.of(text);
        } catch (InvalidPathException invalid) {
            throw new FieldException(field, "Not a valid folder path: " + text);
        }
        if (!path.isAbsolute()) {
            throw new FieldException(field, "The folder must be an absolute path: " + text);
        }
        return path.normalize();
    }

    /** Equal, nested either way, lexically or through the real path of the nearest existing ancestor. */
    private static boolean overlaps(Path dir, Path playbookDir) {
        return nested(dir, playbookDir) || nested(resolved(dir), resolved(playbookDir));
    }

    private static boolean nested(Path a, Path b) {
        return a.startsWith(b) || b.startsWith(a);
    }

    private static Path resolved(Path path) {
        Path existing = path;
        while (existing != null && !Files.exists(existing, LinkOption.NOFOLLOW_LINKS)) {
            existing = existing.getParent();
        }
        if (existing == null) {
            return path;
        }
        try {
            return existing.toRealPath().resolve(existing.relativize(path)).normalize();
        } catch (IOException unreadable) {
            return path;
        }
    }

    /** A 400 for a plan that refused for a reason other than existing files, else null. */
    private static ResponseEntity<?> unusable(FolderWriter.Planned planned, String field, Path dir) {
        if (!(planned instanceof FolderWriter.Refused refused)) {
            return null;
        }
        return switch (refused.result()) {
            case FolderWriter.NotAFolder n -> refusal(field,
                    "Not a folder, or its parent folder does not exist: " + dir);
            case FolderWriter.Escape e -> refusal(field, "Refusing a path outside the folder: " + e.key());
            default -> null;
        };
    }

    private static List<String> conflicts(FolderWriter.Planned planned) {
        return planned instanceof FolderWriter.Refused refused
                && refused.result() instanceof FolderWriter.Conflicts c ? c.conflicts() : List.of();
    }

    private static ResponseEntity<?> failed(FolderWriter.Result result, String root, List<String> projectWritten,
                                            List<String> playbookWritten) {
        Map<String, List<String>> before = new LinkedHashMap<>();
        before.put(PROJECT, projectWritten);
        before.put(PLAYBOOK, playbookWritten);
        if (result instanceof FolderWriter.Conflicts c) {
            before.put(root, c.written());
            Map<String, List<String>> conflicts = new LinkedHashMap<>();
            conflicts.put(PROJECT, root.equals(PROJECT) ? c.conflicts() : List.of());
            conflicts.put(PLAYBOOK, root.equals(PLAYBOOK) ? c.conflicts() : List.of());
            return ResponseEntity.status(409).body(Map.of(
                    "message", "A file appeared in the folder while writing. The files under written were written before it.",
                    "conflicts", conflicts, "written", before));
        }
        String message = result instanceof FolderWriter.Failed f ? f.message() : String.valueOf(result);
        if (result instanceof FolderWriter.Failed f) {
            before.put(root, f.written());
        }
        return ResponseEntity.status(500).body(Map.of(
                "message", "Failed to write the " + root + ": " + message, "written", before));
    }
}
