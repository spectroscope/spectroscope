package dev.spectroscope.server.settings;

import dev.spectroscope.core.skills.Skill;
import dev.spectroscope.core.skills.SkillLibrary;
import dev.spectroscope.server.web.LocalOrigin;

import jakarta.servlet.http.HttpServletRequest;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * The settings page's skill manager (card 90): list the skills of both roots
 * (user {@code ~/.spectro/skills} and project {@code <cwd>/.spectro/skills}) —
 * including DISABLED ones the loader hides — toggle a {@code .disabled} marker,
 * and delete a user-root skill (the seeding ledger keeps it from returning).
 * Every route wears the full local fence: skills change what the agent can do,
 * no foreign page may read or write them. Changes apply to NEW sessions (the
 * library loads per connection); the UI says so honestly.
 *
 * <p>Card 182 added the install verb and, with it, a second level: a marketplace
 * copy lands at {@code <root>/<pack>/<skill>} and the agent sees it as
 * {@code <pack>:<skill>}. Every route here therefore comes in a one-segment and
 * a two-segment form, and a listing row carries the folder segments next to the
 * name — the display name now contains a colon, which is not a path.
 */
@RestController
public class SkillsController {

    /** Seams: the two roots (real: user home + process cwd). */
    private final Path userRoot;
    private final Path projectRoot;

    /** The shelf behind the install verb (card 182) — vendored, never fetched. */
    private final SkillCatalogue catalogue;

    /** Where a set remove parks the folders it takes out until all of them are
     *  out (card 410); a sibling of the skills root, like the install staging. */
    static final String REMOVE_HOLDING_DIR = ".skill-remove";

    /** Spring wiring — the same roots SkillLibrary.defaultRoots resolves. */
    public SkillsController() {
        this(Path.of(System.getProperty("user.home"), ".spectro", "skills"),
                dev.spectroscope.core.config.SpectroDir
                        .in(Path.of(System.getProperty("user.dir"))).resolve("skills"));
    }

    public SkillsController(Path userRoot, Path projectRoot) {
        this(userRoot, projectRoot, new SkillCatalogue());
    }

    /** The seam the half-failed set install tests use to break one copy. */
    SkillsController(Path userRoot, Path projectRoot, SkillCatalogue catalogue) {
        this.userRoot = userRoot;
        this.projectRoot = projectRoot;
        this.catalogue = catalogue;
    }

    private static boolean fenced(HttpServletRequest request) {
        return LocalOrigin.isLocalOrigin(request)
                && LocalOrigin.originIsLoopbackOrAbsent(request);
    }

    /** All skills of both roots, disabled ones included, plus the catalogue shelf.
     *  @param request the servlet request, for the fence
     *  @return 404 for foreign callers; else {skills:[…], catalogue:[…]} */
    @GetMapping("/api/skills")
    public ResponseEntity<Map<String, Object>> list(HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.status(404).build();
        }
        List<Map<String, Object>> skills = new ArrayList<>();
        scan(userRoot, "user", skills);
        scan(projectRoot, "project", skills);
        skills.sort(Comparator.comparing(s -> String.valueOf(s.get("name"))));
        return ResponseEntity.ok(Map.of("skills", skills, "catalogue", catalogueRows()));
    }

    /** The shelf, with {@code installed} recomputed per request — the index itself
     *  is built once, since the catalogue rides inside the artifact and cannot move. */
    private List<Map<String, Object>> catalogueRows() {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (SkillCatalogue.Entry entry : SkillCatalogue.index()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", entry.id());
            row.put("name", entry.name());
            row.put("pack", entry.pack());
            row.put("description", entry.description());
            row.put("licence", entry.licence());
            row.put("repo", entry.repo());
            row.put("commit", entry.commit());
            row.put("files", entry.files());
            row.put("bytes", entry.bytes());
            String root = occupied(entry.pack(), entry.name());
            row.put("installed", root != null);
            // Card 410: which root carries it. A set remove and a row's off
            // switch may only take out a user-root copy; the project's is the
            // repo's business, the same line the single DELETE draws.
            row.put("root", root);
            rows.add(row);
        }
        return rows;
    }

    /**
     * Copy one catalogue skill into the user root (card 182). The body names an
     * opaque catalogue id; it is matched against the enumerated index by string
     * equality and never resolved as a path, so the destination is the pack and
     * leaf name the index already carries.
     *
     * <p>It lands NAMESPACED, at {@code <root>/<pack>/<skill>}, and the loader
     * advertises it as {@code <pack>:<skill>}. That is the whole reason this
     * verb does not have to refuse anything: a catalogue {@code brainstorming}
     * and a locally written one are different folders and different names, so
     * one cannot overwrite or shadow the other. The only 409 left is a second
     * install of the same skill, where the folder on disk may carry the user's
     * edits and a {@code .disabled} marker and neither survives a copy over the
     * top.</p>
     *
     * @param body    {@code {skill: "<pack>/<name>"}}
     * @param request the servlet request, for the fence
     * @return 404 foreign or unknown; 400 no id; 409 already installed; 413 too large; 200 with the facts
     */
    @PostMapping(value = "/api/skills/install", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> install(@RequestBody Map<String, Object> body,
            HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.status(404).build();
        }
        if (!(body.get("skill") instanceof String id) || id.isBlank()) {
            return ResponseEntity.status(400).body(Map.of("message", "A catalogue id ('skill') is required."));
        }
        SkillCatalogue.Entry entry = SkillCatalogue.find(id).orElse(null);
        if (entry == null) {
            return ResponseEntity.status(404).body(Map.of("message", "Unknown catalogue skill: " + id));
        }
        Path target = child(child(userRoot, entry.pack()), entry.name());
        if (target == null) {
            // The index only ever holds plain segment names, so this is
            // unreachable today; it stays because the guard, not the shelf, is
            // what makes the destination safe.
            return ResponseEntity.status(404).body(Map.of("message", "Unknown catalogue skill: " + id));
        }
        String taken = occupied(entry.pack(), entry.name());
        if (taken != null) {
            return ResponseEntity.status(409).body(Map.of(
                    "message", "user".equals(taken)
                            ? "Already installed — delete it first to install it again."
                            : "The project already carries this skill; it would win anyway.",
                    "name", qualified(entry.pack(), entry.name()), "root", taken));
        }
        // The staging directory is a sibling of the skills root, never inside it:
        // the loader now reads one level deeper, so a half-built copy under the
        // root would be picked up as a pack while it is still being written.
        SkillCatalogue.InstallResult result =
                catalogue.install(entry, target, userRoot.resolveSibling(SkillCatalogue.STAGING_DIR));
        return switch (result.status()) {
            case INSTALLED -> ResponseEntity.ok(result.facts());
            case TAKEN -> ResponseEntity.status(409).body(Map.of(
                    "message", result.message(),
                    "name", qualified(entry.pack(), entry.name()), "root", "user"));
            case TOO_LARGE -> {
                Map<String, Object> refusal = new LinkedHashMap<>(result.facts());
                refusal.put("message", result.message());
                yield ResponseEntity.status(413).body(refusal);
            }
            case FAILED -> ResponseEntity.status(500).body(Map.of("error", result.message()));
        };
    }

    /**
     * Copy several catalogue skills into the user root in one request, all or
     * nothing (card 410: a pack's install button). Every id is checked before
     * anything is written; one unknown or already carried id refuses the whole
     * set, and the answer names each refused id with the facts a single
     * install's refusal carries. A copy that fails after others landed takes
     * those back. A copy that will not delete stays, and the answer is then a
     * 500 that names it under {@code leftover}.
     *
     * @param body    {@code {skills: ["<pack>/<name>", ...]}}
     * @param request the servlet request, for the fence
     * @return 404 foreign; 400 no list; 409 a refused id (nothing written); 413 or 500 a failed
     *         copy (nothing left written); 500 with {@code leftover} a failed copy whose take-back
     *         left those ids installed; 200 {@code {installed: [facts...]}}
     */
    @PostMapping(value = "/api/skills/install-set", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> installSet(@RequestBody Map<String, Object> body,
            HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.status(404).build();
        }
        List<String> ids = ids(body);
        if (ids == null) {
            return ResponseEntity.status(400).body(Map.of("message", "A list of catalogue ids ('skills') is required."));
        }
        List<Map<String, Object>> refused = new ArrayList<>();
        List<SkillCatalogue.Entry> entries = new ArrayList<>();
        for (String id : ids) {
            SkillCatalogue.Entry entry = SkillCatalogue.find(id).orElse(null);
            if (entry == null || child(child(userRoot, entry.pack()), entry.name()) == null) {
                refused.add(refusal(id, 404, "Unknown catalogue skill: " + id, null, null));
                continue;
            }
            String taken = occupied(entry.pack(), entry.name());
            if (taken != null) {
                refused.add(refusal(id, 409, "user".equals(taken)
                                ? "Already installed. Delete it first to install it again."
                                : "The project already carries this skill; it would win anyway.",
                        qualified(entry.pack(), entry.name()), taken));
                continue;
            }
            entries.add(entry);
        }
        if (!refused.isEmpty()) {
            return ResponseEntity.status(409).body(Map.of(
                    "message", "Nothing was installed: " + refused.size() + " of " + ids.size() + " refused.",
                    "refused", refused));
        }
        List<Path> written = new ArrayList<>();
        List<Map<String, Object>> installed = new ArrayList<>();
        for (SkillCatalogue.Entry entry : entries) {
            Path target = child(child(userRoot, entry.pack()), entry.name());
            SkillCatalogue.InstallResult result =
                    catalogue.install(entry, target, userRoot.resolveSibling(SkillCatalogue.STAGING_DIR));
            if (result.status() != SkillCatalogue.Status.INSTALLED) {
                // written.get(n) is the copy of entries.get(n): both grow in step until here.
                List<String> leftover = new ArrayList<>();
                for (int back = 0; back < written.size(); back++) {
                    if (deleteTree(written.get(back))) {
                        deleteIfEmpty(written.get(back).getParent());
                    } else {
                        leftover.add(entries.get(back).id());
                    }
                }
                int status = switch (result.status()) {
                    case TAKEN -> 409;
                    case TOO_LARGE -> 413;
                    default -> 500;
                };
                List<Map<String, Object>> failed = List.of(refusal(entry.id(), status, result.message(),
                        qualified(entry.pack(), entry.name()), status == 409 ? "user" : null));
                if (leftover.isEmpty()) {
                    return ResponseEntity.status(status).body(Map.of(
                            "message", "Nothing was installed: " + entry.id() + " failed.",
                            "refused", failed));
                }
                // A copy that would not delete is still in the user root, where
                // the loader reads it, so the answer names it.
                return ResponseEntity.status(500).body(Map.of(
                        "message", entry.id() + " failed, and " + leftover.size()
                                + " copied before it could not be taken back: " + String.join(", ", leftover) + ".",
                        "refused", failed,
                        "leftover", leftover));
            }
            written.add(target);
            Map<String, Object> facts = new LinkedHashMap<>(result.facts());
            facts.put("skill", entry.id());
            installed.add(facts);
        }
        return ResponseEntity.ok(Map.of("installed", installed));
    }

    /**
     * Take several catalogue skills out of the user root in one request, all or
     * nothing (card 410: a pack's remove button). Every id must name a catalogue
     * skill the user root carries; one that is missing, or only in the project
     * root, refuses the whole set. The folders are first moved aside into a
     * holding folder beside the root, and only deleted once every one of them
     * is out, so a move that fails halfway puts the earlier ones back. One that
     * will not go back stays in the holding folder, and the answer is then a 500
     * that names it under {@code leftover} and the folder under {@code holding}.
     *
     * @param body    {@code {skills: ["<pack>/<name>", ...]}}
     * @param request the servlet request, for the fence
     * @return 404 foreign; 400 no list; 409 a refused id (nothing removed); 500 a failed move
     *         (nothing left removed); 500 with {@code leftover} and {@code holding} a failed move
     *         whose put-back left those ids out of the root; 200 {@code {removed: [ids]}}
     */
    @PostMapping(value = "/api/skills/remove-set", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> removeSet(@RequestBody Map<String, Object> body,
            HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.status(404).build();
        }
        List<String> ids = ids(body);
        if (ids == null) {
            return ResponseEntity.status(400).body(Map.of("message", "A list of catalogue ids ('skills') is required."));
        }
        List<Map<String, Object>> refused = new ArrayList<>();
        List<Path> targets = new ArrayList<>();
        for (String id : ids) {
            SkillCatalogue.Entry entry = SkillCatalogue.find(id).orElse(null);
            Path user = entry == null ? null : child(child(userRoot, entry.pack()), entry.name());
            if (user != null && Files.isDirectory(user)) {
                targets.add(user);
            } else if (entry != null && "project".equals(occupied(entry.pack(), entry.name()))) {
                refused.add(refusal(id, 409, "A project skill belongs to the repo; remove it there.",
                        qualified(entry.pack(), entry.name()), "project"));
            } else {
                refused.add(refusal(id, 404, "Not installed: " + id, null, null));
            }
        }
        if (!refused.isEmpty()) {
            return ResponseEntity.status(409).body(Map.of(
                    "message", "Nothing was removed: " + refused.size() + " of " + ids.size() + " refused.",
                    "refused", refused));
        }
        Path holdingRoot = userRoot.resolveSibling(REMOVE_HOLDING_DIR);
        Path holding = holdingRoot.resolve(String.valueOf(System.nanoTime()));
        List<Path> moved = new ArrayList<>();
        for (int i = 0; i < targets.size(); i++) {
            try {
                Files.createDirectories(holding);
                move(targets.get(i), holding.resolve(String.valueOf(i)));
                moved.add(targets.get(i));
            } catch (IOException | RuntimeException failure) {
                // moved.get(n) is targets.get(n), and targets.get(n) is the folder of ids.get(n).
                List<String> leftover = new ArrayList<>();
                for (int back = moved.size() - 1; back >= 0; back--) {
                    try {
                        move(holding.resolve(String.valueOf(back)), moved.get(back));
                    } catch (IOException | RuntimeException stuck) {
                        leftover.add(0, ids.get(back));
                    }
                }
                deleteIfEmpty(holding);
                deleteIfEmpty(holdingRoot);
                List<Map<String, Object>> failed = List.of(refusal(ids.get(i), 500,
                        String.valueOf(failure.getMessage()), null, null));
                if (leftover.isEmpty()) {
                    return ResponseEntity.status(500).body(Map.of(
                            "message", "Nothing was removed: " + ids.get(i) + " could not be moved.",
                            "refused", failed));
                }
                // A folder that would not go back is out of the root and waits
                // in the holding folder, which stays; the answer names both.
                return ResponseEntity.status(500).body(Map.of(
                        "message", ids.get(i) + " could not be moved, and " + leftover.size()
                                + " moved before it could not be put back: " + String.join(", ", leftover)
                                + ". They wait in " + holding + ".",
                        "refused", failed,
                        "leftover", leftover,
                        "holding", holding.toString()));
            }
        }
        // A holding folder that will not delete stays beside the root. The
        // loader does not read there, and the skills are out of the root.
        deleteTree(holding);
        deleteIfEmpty(holdingRoot);
        for (Path target : targets) {
            deleteIfEmpty(target.getParent());
        }
        return ResponseEntity.ok(Map.of("removed", ids));
    }

    /** The one move a set remove makes, out to the holding folder and back; the
     *  seam its failure tests break. */
    void move(Path from, Path to) throws IOException {
        Files.move(from, to);
    }

    /** The set's ids, de-duplicated in order; null when the body carries no usable list. */
    private static List<String> ids(Map<String, Object> body) {
        if (!(body.get("skills") instanceof List<?> raw) || raw.isEmpty()) {
            return null;
        }
        java.util.LinkedHashSet<String> ids = new java.util.LinkedHashSet<>();
        for (Object id : raw) {
            if (!(id instanceof String text) || text.isBlank()) {
                return null;
            }
            ids.add(text);
        }
        return List.copyOf(ids);
    }

    /** One refused id of a set, in the shape a single install's refusal already has. */
    private static Map<String, Object> refusal(String id, int status, String message, String name, String root) {
        Map<String, Object> refusal = new LinkedHashMap<>();
        refusal.put("skill", id);
        refusal.put("status", status);
        refusal.put("message", message);
        if (name != null) {
            refusal.put("name", name);
        }
        if (root != null) {
            refusal.put("root", root);
        }
        return refusal;
    }

    /** Which root already carries this exact pack/skill folder — "user", "project", or null. */
    private String occupied(String pack, String name) {
        Path user = child(child(userRoot, pack), name);
        if (user != null && Files.exists(user)) {
            return "user";
        }
        Path project = child(child(projectRoot, pack), name);
        return project != null && Files.exists(project) ? "project" : null;
    }

    /** The name as the model reads it: {@code <pack>:<skill>}, or bare at the top level. */
    private static String qualified(String pack, String name) {
        return pack == null ? name : pack + SkillLibrary.NAMESPACE_SEPARATOR + name;
    }

    /**
     * Lists a root the way the loader reads it: top-level skills, then the skills
     * of every pack. Each row carries the folder segments the action routes need
     * ({@code pack} + {@code folder}) alongside the qualified {@code name} the
     * agent sees — the two are no longer the same string, and a UI that built a
     * URL out of the display name would miss the pack.
     */
    private static void scan(Path root, String source, List<Map<String, Object>> out) {
        for (Path dir : childDirectories(root)) {
            if (Files.isRegularFile(dir.resolve("SKILL.md"))) {
                out.add(row(dir, null, source));
            } else {
                for (Path skill : childDirectories(dir)) {
                    if (Files.isRegularFile(skill.resolve("SKILL.md"))) {
                        out.add(row(skill, dir.getFileName().toString(), source));
                    }
                }
            }
        }
    }

    /** Direct subdirectories, sorted; an absent or unreadable directory yields none. */
    private static List<Path> childDirectories(Path dir) {
        if (!Files.isDirectory(dir)) {
            return List.of();
        }
        try (Stream<Path> entries = Files.list(dir)) {
            return entries.filter(Files::isDirectory).sorted().toList();
        } catch (IOException unreadable) {
            return List.of();
        }
    }

    /** One listing row. A broken SKILL.md still shows, so the manager can delete it. */
    private static Map<String, Object> row(Path dir, String pack, String source) {
        String folder = dir.getFileName().toString();
        String description;
        try {
            description = SkillLibrary.parse(dir.resolve("SKILL.md"), folder).description();
        } catch (IOException | RuntimeException broken) {
            description = "(broken SKILL.md)";
        }
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("name", qualified(pack, folder));
        row.put("folder", folder);
        row.put("pack", pack);
        row.put("description", description);
        row.put("source", source);
        row.put("disabled", Files.exists(dir.resolve(".disabled")));
        return row;
    }

    /** Flip the {@code .disabled} marker on a skill (whichever root carries it;
     *  the user root wins when both do). The two-segment form addresses a skill
     *  inside a pack — the pack is a real directory, so it is a real path segment
     *  rather than a colon smuggled through one.
     *  @param pack the pack folder, absent for a top-level skill
     *  @param name the skill folder name
     *  @param body {@code {disabled: boolean}}
     *  @param request the servlet request, for the fence
     *  @return 404 foreign/unknown; else the new {disabled} state */
    @PostMapping({"/api/skills/{name}/disabled", "/api/skills/{pack}/{name}/disabled"})
    public ResponseEntity<Map<String, Object>> setDisabled(
            @PathVariable(name = "pack", required = false) String pack,
            @PathVariable("name") String name,
            @RequestBody Map<String, Object> body, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.status(404).build();
        }
        Path dir = locate(pack, name);
        if (dir == null) {
            return ResponseEntity.status(404).build();
        }
        boolean disabled = Boolean.TRUE.equals(body.get("disabled"));
        try {
            Path marker = dir.resolve(".disabled");
            if (disabled) {
                Files.writeString(marker, "");
            } else {
                Files.deleteIfExists(marker);
            }
            return ResponseEntity.ok(Map.of("name", qualified(pack, name), "disabled", disabled));
        } catch (IOException failure) {
            return ResponseEntity.status(500).body(Map.of("error", failure.getMessage()));
        }
    }

    /** Delete a USER-root skill for good (the seeding ledger keeps it away).
     *  Project-root skills are the repo's business and refuse readably.
     *  @param pack the pack folder, absent for a top-level skill
     *  @param name the skill folder name
     *  @param request the servlet request, for the fence
     *  @return 404 foreign/unknown; 409 for a project skill; 200 {deleted} */
    @DeleteMapping({"/api/skills/{name}", "/api/skills/{pack}/{name}"})
    public ResponseEntity<Map<String, Object>> delete(
            @PathVariable(name = "pack", required = false) String pack,
            @PathVariable("name") String name, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.status(404).build();
        }
        Path safeUser = child(child(userRoot, pack), name);
        if (safeUser != null && Files.isDirectory(safeUser)) {
            try (Stream<Path> walk = Files.walk(safeUser)) {
                List<Path> files = walk.sorted(Comparator.reverseOrder()).toList();
                for (Path p : files) {
                    Files.delete(p);
                }
                // An emptied pack folder is litter: the loader ignores it, the
                // listing shows nothing, and the next install would find a
                // directory it did not put there.
                if (pack != null) {
                    deleteIfEmpty(safeUser.getParent());
                }
                return ResponseEntity.ok(Map.of("deleted", qualified(pack, name)));
            } catch (IOException failure) {
                return ResponseEntity.status(500).body(Map.of("error", failure.getMessage()));
            }
        }
        Path safeProject = child(child(projectRoot, pack), name);
        if (safeProject != null && Files.isDirectory(safeProject)) {
            return ResponseEntity.status(409)
                    .body(Map.of("error", "a project skill belongs to the repo — remove it there"));
        }
        return ResponseEntity.status(404).build();
    }

    /** Deletes a folder and everything in it; a folder that is not there is fine.
     *  @param root the folder
     *  @return whether the folder is gone afterwards */
    private static boolean deleteTree(Path root) {
        if (!Files.exists(root)) {
            return true;
        }
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(p);
            }
        } catch (IOException | java.io.UncheckedIOException stays) {
            return false;
        }
        return !Files.exists(root);
    }

    private static void deleteIfEmpty(Path dir) {
        try (Stream<Path> rest = Files.list(dir)) {
            if (rest.findAny().isEmpty()) {
                Files.deleteIfExists(dir);
            }
        } catch (IOException stillBusy) {
            // a pack that still holds skills stays, which is the point
        }
    }

    /** The skill dir for a pack/name — user root first; null when unknown. */
    private Path locate(String pack, String name) {
        Path user = child(child(userRoot, pack), name);
        if (user != null && Files.isDirectory(user)) {
            return user;
        }
        Path project = child(child(projectRoot, pack), name);
        return project != null && Files.isDirectory(project) ? project : null;
    }

    /** Resolves a child and REFUSES traversal — the name must stay inside the root.
     *  A null root (a refused parent segment) stays null, so a two-segment path is
     *  only as safe as both of its segments. A null NAME means "this level", which
     *  is how the pack-less routes reuse the nested lookup. */
    private static Path child(Path root, String name) {
        if (root == null) {
            return null;
        }
        if (name == null) {
            return root;
        }
        Path resolved = root.resolve(name).normalize();
        return resolved.startsWith(root.normalize()) && !resolved.equals(root.normalize())
                ? resolved : null;
    }
}
