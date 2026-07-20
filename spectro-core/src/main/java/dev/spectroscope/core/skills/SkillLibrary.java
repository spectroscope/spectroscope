package dev.spectroscope.core.skills;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.tools.Tool;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Loads skills — folders that contain a SKILL.md — and exposes them with
 * progressive disclosure, modeled on Claude Code skills: only name and
 * description enter the system prompt (cheap, always visible), the full body
 * is fetched on demand through the {@link #useSkillTool() use_skill} tool.
 * Skills extend the agent's behavior with data, not code — the loop is untouched.
 *
 * <p>Layering follows the settings hierarchy: the user layer
 * ({@code ~/.spectro/skills}) is scanned first, the project layer
 * ({@code <cwd>/.spectro/skills}) second, so a project skill with the same name
 * wins. A broken SKILL.md is skipped with a warning — it must not kill the harness.
 */
public final class SkillLibrary {

    private static final Logger LOG = LoggerFactory.getLogger(SkillLibrary.class);

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int DESCRIPTION_FALLBACK_LIMIT = 120;

    /** Insertion order is load order; later roots already replaced earlier entries. */
    private final Map<String, Skill> byName;

    /**
     * Wraps the already-merged map — all construction goes through {@link #load(List)}.
     *
     * @param byName skills keyed by name, later layers already folded in
     */
    private SkillLibrary(Map<String, Skill> byName) {
        this.byName = byName;
    }

    /**
     * The two standard skill roots, lowest precedence first: user layer, then
     * project layer. Neither has to exist — {@link #load(List)} treats an absent
     * root like a missing config file.
     *
     * @param cwd the project directory whose {@code .spectro/skills} forms the project layer
     * @return user root then project root, ready to hand to {@link #load(List)}
     */
    public static List<Path> defaultRoots(Path cwd) {
        return List.of(
                Path.of(System.getProperty("user.home"), ".spectro", "skills"),
                cwd.resolve(".spectro").resolve("skills"));
    }

    /**
     * Scans each root in order for direct subdirectories containing a SKILL.md.
     * Later roots override earlier ones by skill name (project over user, same
     * philosophy as the settings hierarchy). Nonexistent roots are silently fine;
     * an unreadable or broken skill is skipped with one warning line on stderr.
     *
     * @param roots skill roots in precedence order, lowest first
     * @return the merged library — possibly empty, never a failure
     */
    public static SkillLibrary load(List<Path> roots) {
        Map<String, Skill> byName = new LinkedHashMap<>();
        for (Path root : roots) {
            if (!Files.isDirectory(root)) {
                continue; // absent layer — as unremarkable as a missing config file
            }
            try (Stream<Path> entries = Files.list(root)) {
                entries.filter(Files::isDirectory).sorted().forEach(dir -> {
                    Path skillFile = dir.resolve("SKILL.md");
                    if (!Files.isRegularFile(skillFile)) {
                        return; // a folder without SKILL.md is not a skill
                    }
                    try {
                        Skill skill = parse(skillFile, dir.getFileName().toString());
                        byName.put(skill.name(), skill); // later roots win by name
                    } catch (IOException | RuntimeException broken) {
                        LOG.warn("skipping broken skill {}: {}", skillFile, broken.getMessage());
                    }
                });
            } catch (IOException unreadable) {
                LOG.warn("skipping unreadable skill root {}: {}", root, unreadable.getMessage());
            }
        }
        return new SkillLibrary(byName);
    }

    /** All loaded skills, sorted by name for stable prompts and listings. */
    public List<Skill> skills() {
        return byName.values().stream()
                .sorted(Comparator.comparing(Skill::name))
                .toList();
    }

    /**
     * Looks up one skill by its unique name.
     *
     * @param name the skill name as advertised in the system prompt's list
     * @return the skill, or empty when nothing by that name is installed
     */
    public Optional<Skill> find(String name) {
        return Optional.ofNullable(byName.get(name));
    }

    /**
     * The block appended to the system prompt: one cheap bullet per skill.
     * Empty library, empty string — no section header without content.
     */
    public String systemPromptSection() {
        if (byName.isEmpty()) {
            return "";
        }
        String bullets = skills().stream()
                .map(skill -> "- " + skill.name() + ": " + skill.description())
                .collect(Collectors.joining("\n"));
        return "\n\n## Skills\n\n"
                + "Specialized instruction packages are available. When a task matches one,\n"
                + "call the use_skill tool with its name BEFORE starting the work, then follow it.\n\n"
                + bullets;
    }

    /**
     * The on-demand half of progressive disclosure: the model names a skill and
     * receives its full body. Permission-free — it only reads files the user
     * checked into the skill roots, no model-controlled paths are involved.
     *
     * @return the {@code use_skill} tool, ready to register alongside the standard tools
     */
    public Tool useSkillTool() {
        return new Tool() {
            /** Wire name: {@code use_skill}. */
            public String name() { return "use_skill"; }
            /** The model-facing one-liner — points back at the skill list in the system prompt. */
            public String description() {
                return "Returns the full instructions of a named skill. Call it before "
                        + "starting work that matches a skill listed in the system prompt.";
            }
            /** One required string: the skill {@code name}. */
            public JsonNode inputSchema() {
                ObjectNode schema = JSON.createObjectNode();
                schema.put("type", "object");
                ObjectNode properties = JSON.createObjectNode();
                properties.set("name", JSON.createObjectNode().put("type", "string"));
                schema.set("properties", properties);
                schema.set("required", JSON.createArrayNode().add("name"));
                return schema;
            }
            /** Permission-free — it reads only files the user installed under the skill roots. */
            public boolean needsPermission() { return false; }

            /** Resolves the named skill to its full body; unknown names return an "ERROR: " listing what exists. */
            public String execute(JsonNode input, ToolContext context) {
                if (byName.isEmpty()) {
                    return "ERROR: no skills are installed.";
                }
                String requested = input.path("name").asText();
                return find(requested)
                        .map(Skill::body)
                        .orElseGet(() -> "ERROR: unknown skill '" + requested + "'. Available: "
                                + skills().stream().map(Skill::name)
                                        .collect(Collectors.joining(", ")));
            }
        };
    }

    // ---- SKILL.md parsing ----------------------------------------------------------------

    /**
     * Hand-rolled frontmatter parsing: two flat "key: value" lines do not earn a
     * YAML dependency. If the first non-blank line is {@code ---}, key/value pairs
     * are read until the closing fence and the body starts after it; a file without
     * frontmatter is all body. Fallbacks: name from the folder, description from
     * the first non-blank body line (truncated to {@value #DESCRIPTION_FALLBACK_LIMIT} chars).
     *
     * @param skillFile  the SKILL.md being loaded
     * @param folderName name of the containing folder — the skill-name fallback
     * @return the parsed skill with all fallbacks applied
     */
    private static Skill parse(Path skillFile, String folderName) throws IOException {
        String raw = Files.readString(skillFile, StandardCharsets.UTF_8);
        // \R matches \n, \r\n and \r alike — a CRLF-edited SKILL.md parses the same.
        List<String> lines = List.of(raw.split("\\R", -1));

        Map<String, String> frontmatter = new LinkedHashMap<>();
        int bodyStart = 0;
        int first = firstNonBlank(lines);
        if (first >= 0 && lines.get(first).strip().equals("---")) {
            int i = first + 1;
            while (i < lines.size() && !lines.get(i).strip().equals("---")) {
                int colon = lines.get(i).indexOf(':');
                if (colon > 0) {
                    frontmatter.put(lines.get(i).substring(0, colon).strip(),
                            lines.get(i).substring(colon + 1).strip());
                }
                i++;
            }
            bodyStart = Math.min(i + 1, lines.size());
        }
        String body = String.join("\n", lines.subList(bodyStart, lines.size())).strip();

        String name = Optional.ofNullable(frontmatter.get("name"))
                .filter(value -> !value.isBlank())
                .orElse(folderName);
        String description = Optional.ofNullable(frontmatter.get("description"))
                .filter(value -> !value.isBlank())
                .orElseGet(() -> descriptionFromBody(body));
        return new Skill(name, description, body, skillFile);
    }

    /**
     * Finds where content starts — frontmatter detection keys off this line.
     *
     * @param lines the file, already split into lines
     * @return index of the first non-blank line, or -1 for an all-blank file
     */
    private static int firstNonBlank(List<String> lines) {
        for (int i = 0; i < lines.size(); i++) {
            if (!lines.get(i).isBlank()) {
                return i;
            }
        }
        return -1;
    }

    /**
     * Fallback description: the first non-blank body line, capped for prompt hygiene.
     *
     * @param body the skill body to summarize
     * @return the capped first content line, or "" for an all-blank body
     */
    private static String descriptionFromBody(String body) {
        return body.lines()
                .filter(line -> !line.isBlank())
                .findFirst()
                .map(String::strip)
                .map(line -> line.length() <= DESCRIPTION_FALLBACK_LIMIT
                        ? line
                        : line.substring(0, DESCRIPTION_FALLBACK_LIMIT))
                .orElse("");
    }
}
