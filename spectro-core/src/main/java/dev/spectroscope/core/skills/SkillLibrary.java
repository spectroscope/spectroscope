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
 *
 * <p>A folder that holds skills rather than being one is a PACK, and its skills
 * are advertised as {@code <pack>:<name>} (card 182). That is how a marketplace
 * copy of somebody else's {@code brainstorming} lands beside a locally written
 * one instead of on top of it.
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
                dev.spectroscope.core.config.SpectroDir.in(cwd).resolve("skills"));
    }

    /** Separates a pack from the skill it holds, in the name the model reads. */
    public static final String NAMESPACE_SEPARATOR = ":";

    /**
     * Scans each root in order for direct subdirectories containing a SKILL.md,
     * and for PACKS — a subdirectory that holds no SKILL.md of its own but does
     * hold skills, whose skills are then advertised as {@code <pack>:<name>}
     * (card 182). Later roots override earlier ones by that name (project over
     * user, same philosophy as the settings hierarchy). Nonexistent roots are
     * silently fine; an unreadable or broken skill is skipped with one warning
     * line on stderr.
     *
     * <p>The pack rule adds exactly one level and stops there. Anything installed
     * before it sits at level 1 and keeps its bare name unchanged, which is what
     * lets a marketplace copy land beside a skill of the same name instead of
     * over it.</p>
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
            for (Path dir : childDirectories(root)) {
                if (Files.isRegularFile(dir.resolve("SKILL.md"))) {
                    loadSkill(dir, null, byName);
                } else if (!Files.exists(dir.resolve(".disabled"))) {
                    // A folder with neither a SKILL.md nor skills below it simply
                    // contributes nothing — the loop is the whole "is it a pack?"
                    // test, so there is no shape to guess wrong about.
                    for (Path skill : childDirectories(dir)) {
                        loadSkill(skill, dir.getFileName().toString(), byName);
                    }
                }
            }
        }
        return new SkillLibrary(byName);
    }

    /** Direct subdirectories, sorted; an unreadable directory yields none. */
    private static List<Path> childDirectories(Path dir) {
        try (Stream<Path> entries = Files.list(dir)) {
            return entries.filter(Files::isDirectory).sorted().toList();
        } catch (IOException unreadable) {
            LOG.warn("skipping unreadable skill directory {}: {}", dir, unreadable.getMessage());
            return List.of();
        }
    }

    /**
     * Parses one skill folder into the map, under its pack when it has one.
     *
     * <p>The namespace is applied to the KEY, not merely printed next to it. The
     * name a skill carries is the one the system prompt lists and the one
     * {@code use_skill} answers to, so a pack skill that kept its bare name
     * would still collide with a top-level skill of that name — silently, since
     * the map would simply hold whichever loaded last.</p>
     *
     * @param dir    the folder holding SKILL.md
     * @param pack   the pack folder's name, or null for a top-level skill
     * @param byName the map being built; later roots win by name
     */
    private static void loadSkill(Path dir, String pack, Map<String, Skill> byName) {
        Path skillFile = dir.resolve("SKILL.md");
        if (!Files.isRegularFile(skillFile)) {
            return; // a folder without SKILL.md is not a skill
        }
        if (Files.exists(dir.resolve(".disabled"))) {
            return; // the skill manager's per-skill off switch (card 90)
        }
        try {
            Skill skill = parse(skillFile, dir.getFileName().toString());
            String name = pack == null ? skill.name() : pack + NAMESPACE_SEPARATOR + skill.name();
            byName.put(name, new Skill(name, skill.description(), skill.body(), skill.source()));
        } catch (IOException | RuntimeException broken) {
            LOG.warn("skipping broken skill {}: {}", skillFile, broken.getMessage());
        }
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
    /** Parses ONE skill file — public for the server's skill manager (card 90),
     *  which lists raw per-root skills incl. disabled ones the loader hides.
     *  @param skillFile the SKILL.md to parse
     *  @param folderName the folder name, the name fallback
     *  @return the parsed skill
     *  @throws IOException when unreadable */
    public static Skill parse(Path skillFile, String folderName) throws IOException {
        return parse(Files.readString(skillFile, StandardCharsets.UTF_8), folderName, skillFile);
    }

    /**
     * The same parse over text that never touched this disk — the marketplace
     * catalogue (card 182) reads SKILL.md out of the jar, where there is no
     * {@link Path} to open.
     *
     * @param raw        the whole SKILL.md as text
     * @param folderName name of the containing folder — the skill-name fallback
     * @param source     where the text came from, carried through onto the skill
     * @return the parsed skill with all fallbacks applied
     */
    public static Skill parse(String raw, String folderName, Path source) {
        // \R matches \n, \r\n and \r alike — a CRLF-edited SKILL.md parses the same.
        List<String> lines = List.of(raw.split("\\R", -1));

        Map<String, String> frontmatter = new LinkedHashMap<>();
        int bodyStart = 0;
        int first = firstNonBlank(lines);
        if (first >= 0 && lines.get(first).strip().equals("---")) {
            int i = first + 1;
            while (i < lines.size() && !lines.get(i).strip().equals("---")) {
                String line = lines.get(i);
                int colon = line.indexOf(':');
                if (colon > 0) {
                    String key = line.substring(0, colon).strip();
                    String value = line.substring(colon + 1).strip();
                    if (BLOCK_MARKERS.contains(value)) {
                        // A YAML block scalar: the value is the indented lines that
                        // follow, and the marker itself is not text. Reading only the
                        // marker gave the catalogue's foreign skills a description of
                        // "|", and the continuation lines — one of which ends in a
                        // colon — were then read as further keys (card 182).
                        int blockEnd = endOfBlock(lines, i + 1, indentOf(line));
                        value = fold(lines.subList(i + 1, blockEnd));
                        i = blockEnd - 1;
                    }
                    frontmatter.put(key, unquote(value));
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
        return new Skill(name, description, body, source);
    }

    /**
     * The block-scalar markers this parser recognises. Literal ({@code |}) and
     * folded ({@code >}) are both here, with and without the chomping suffix,
     * because both appear in the vendored catalogue.
     */
    private static final List<String> BLOCK_MARKERS = List.of("|", "|-", ">", ">-");

    /**
     * Where a block scalar stops: the first line at or left of the key's own
     * indentation. Blank lines belong to the block wherever they sit, since a
     * paragraph break inside a description is not the end of it.
     *
     * @param lines    the whole file, already split
     * @param from     the first line after the marker
     * @param keyIndent leading-whitespace width of the line carrying the key
     * @return the exclusive end index of the block
     */
    private static int endOfBlock(List<String> lines, int from, int keyIndent) {
        int i = from;
        while (i < lines.size() && (lines.get(i).isBlank() || indentOf(lines.get(i)) > keyIndent)) {
            i++;
        }
        return i;
    }

    /** Leading-whitespace width, the only indentation measure a block scalar needs. */
    private static int indentOf(String line) {
        int i = 0;
        while (i < line.length() && Character.isWhitespace(line.charAt(i))) {
            i++;
        }
        return i;
    }

    /**
     * Folds a block scalar into one line. YAML would keep the newlines of a
     * literal block, but both readers of this map put the value on a single
     * line — the system prompt's one-bullet-per-skill list and the settings
     * row, which is {@code white-space: nowrap}. A description that wrapped
     * would break the bullet list it lives in.
     *
     * @param block the lines of the block, indentation included
     * @return the block as one stripped line
     */
    private static String fold(List<String> block) {
        return block.stream()
                .map(String::strip)
                .filter(line -> !line.isEmpty())
                .collect(Collectors.joining(" "));
    }

    /**
     * Removes one matching pair of surrounding quotes. YAML treats them as
     * delimiters; keeping them printed {@code "…"} inside prompt bullets and
     * settings rows for the seven catalogue skills that quote their value. A
     * quote elsewhere in the line is content and stays.
     *
     * @param value the raw value after the colon, already stripped
     * @return the value without its wrapping quote pair
     */
    private static String unquote(String value) {
        if (value.length() >= 2
                && (value.charAt(0) == '"' || value.charAt(0) == '\'')
                && value.charAt(value.length() - 1) == value.charAt(0)) {
            return value.substring(1, value.length() - 1);
        }
        return value;
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
