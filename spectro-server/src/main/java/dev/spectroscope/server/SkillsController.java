package dev.spectroscope.server;

import dev.spectroscope.core.skills.Skill;
import dev.spectroscope.core.skills.SkillLibrary;

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
 */
@RestController
public class SkillsController {

    /** Seams: the two roots (real: user home + process cwd). */
    private final Path userRoot;
    private final Path projectRoot;

    /** Spring wiring — the same roots SkillLibrary.defaultRoots resolves. */
    public SkillsController() {
        this(Path.of(System.getProperty("user.home"), ".spectro", "skills"),
                Path.of(System.getProperty("user.dir"), ".spectro", "skills"));
    }

    SkillsController(Path userRoot, Path projectRoot) {
        this.userRoot = userRoot;
        this.projectRoot = projectRoot;
    }

    private static boolean fenced(HttpServletRequest request) {
        return FleetController.isLocalOrigin(request)
                && FleetController.originIsLoopbackOrAbsent(request);
    }

    /** All skills of both roots, disabled ones included.
     *  @param request the servlet request, for the fence
     *  @return 404 for foreign callers; else {skills:[{name,description,source,disabled}]} */
    @GetMapping("/api/skills")
    public ResponseEntity<Map<String, Object>> list(HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.status(404).build();
        }
        List<Map<String, Object>> skills = new ArrayList<>();
        scan(userRoot, "user", skills);
        scan(projectRoot, "project", skills);
        skills.sort(Comparator.comparing(s -> String.valueOf(s.get("name"))));
        return ResponseEntity.ok(Map.of("skills", skills));
    }

    private static void scan(Path root, String source, List<Map<String, Object>> out) {
        if (!Files.isDirectory(root)) {
            return;
        }
        try (Stream<Path> entries = Files.list(root)) {
            entries.filter(Files::isDirectory).sorted().forEach(dir -> {
                Path skillFile = dir.resolve("SKILL.md");
                if (!Files.isRegularFile(skillFile)) {
                    return;
                }
                try {
                    Skill skill = SkillLibrary.parse(skillFile, dir.getFileName().toString());
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("name", dir.getFileName().toString());
                    row.put("description", skill.description());
                    row.put("source", source);
                    row.put("disabled", Files.exists(dir.resolve(".disabled")));
                    out.add(row);
                } catch (IOException | RuntimeException broken) {
                    // a broken skill still shows, so the manager can delete it
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("name", dir.getFileName().toString());
                    row.put("description", "(broken SKILL.md)");
                    row.put("source", source);
                    row.put("disabled", Files.exists(dir.resolve(".disabled")));
                    out.add(row);
                }
            });
        } catch (IOException unreadable) {
            // an unreadable root simply lists nothing
        }
    }

    /** Flip the {@code .disabled} marker on a skill (whichever root carries it;
     *  the user root wins when both do).
     *  @param name the skill folder name
     *  @param body {@code {disabled: boolean}}
     *  @param request the servlet request, for the fence
     *  @return 404 foreign/unknown; else the new {disabled} state */
    @PostMapping("/api/skills/{name}/disabled")
    public ResponseEntity<Map<String, Object>> setDisabled(@PathVariable("name") String name,
            @RequestBody Map<String, Object> body, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.status(404).build();
        }
        Path dir = locate(name);
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
            return ResponseEntity.ok(Map.of("name", name, "disabled", disabled));
        } catch (IOException failure) {
            return ResponseEntity.status(500).body(Map.of("error", failure.getMessage()));
        }
    }

    /** Delete a USER-root skill for good (the seeding ledger keeps it away).
     *  Project-root skills are the repo's business and refuse readably.
     *  @param name the skill folder name
     *  @param request the servlet request, for the fence
     *  @return 404 foreign/unknown; 409 for a project skill; 200 {deleted} */
    @DeleteMapping("/api/skills/{name}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable("name") String name,
            HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.status(404).build();
        }
        Path safeUser = child(userRoot, name);
        if (safeUser != null && Files.isDirectory(safeUser)) {
            try (Stream<Path> walk = Files.walk(safeUser)) {
                List<Path> files = walk.sorted(Comparator.reverseOrder()).toList();
                for (Path p : files) {
                    Files.delete(p);
                }
                return ResponseEntity.ok(Map.of("deleted", name));
            } catch (IOException failure) {
                return ResponseEntity.status(500).body(Map.of("error", failure.getMessage()));
            }
        }
        Path safeProject = child(projectRoot, name);
        if (safeProject != null && Files.isDirectory(safeProject)) {
            return ResponseEntity.status(409)
                    .body(Map.of("error", "a project skill belongs to the repo — remove it there"));
        }
        return ResponseEntity.status(404).build();
    }

    /** The skill dir for a name — user root first; null when unknown. */
    private Path locate(String name) {
        Path user = child(userRoot, name);
        if (user != null && Files.isDirectory(user)) {
            return user;
        }
        Path project = child(projectRoot, name);
        return project != null && Files.isDirectory(project) ? project : null;
    }

    /** Resolves a child and REFUSES traversal — the name must stay inside the root. */
    private static Path child(Path root, String name) {
        Path resolved = root.resolve(name).normalize();
        return resolved.startsWith(root.normalize()) && !resolved.equals(root.normalize())
                ? resolved : null;
    }
}
