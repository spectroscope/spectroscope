package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.playbook.AgentFile;
import dev.spectroscope.core.playbook.Finding;
import dev.spectroscope.core.playbook.PlaybookValidator;
import dev.spectroscope.core.playbook.SafeWalk;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Reads the Claude Code plugins of this home for the Plugin tab (card 526): the plugin cache
 * ({@code ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/}) and the local plugins of each
 * marketplace ({@code ~/.claude/plugins/marketplaces/<marketplace>/}, the entries of its
 * {@code .claude-plugin/marketplace.json} whose source is a folder inside it).
 *
 * <p>This class only reads; it never writes into that folder, and it is the one source of the
 * playbook package that names it. A plugin is found by enumerating the two roots and matching the
 * labels a listing showed; nothing from a request is resolved as a path. A symbolic link below a
 * root is never followed: a linked plugin folder is not listed, and a link inside a part being read
 * refuses the import. What the playbook format does not carry is named, never copied: MCP servers
 * from {@code plugin.json} and {@code .mcp.json}, agent fields the format sets elsewhere, hook
 * events other than tool use, commands in sub folders.
 */
final class PluginSources {

    /** The root label of the plugin cache. */
    static final String CACHE = "cache";
    /** The root label of the marketplaces. */
    static final String MARKETPLACE = "marketplace";
    /** The kinds a plugin import takes, in the order an answer lists them. */
    static final List<String> KINDS = List.of("skills", "agents", "commands", "hooks");

    private static final String MANIFEST_DIR = ".claude-plugin";
    private static final String PLUGIN_JSON = MANIFEST_DIR + "/plugin.json";
    private static final String MARKET_JSON = MANIFEST_DIR + "/marketplace.json";
    private static final String MCP_JSON = ".mcp.json";
    private static final String SKILL_FILE = "SKILL.md";
    private static final List<String> LICENCE_NAMES = List.of("LICENSE", "LICENSE.md", "LICENSE.txt");
    private static final Set<String> SKIPPED = Set.of(".disabled", ".DS_Store", PlaybookInstaller.INSTALL_RECORD, MCP_JSON);
    private static final Pattern ROOT_REF = Pattern.compile(
            "\\$\\{CLAUDE_PLUGIN_ROOT\\}/([A-Za-z0-9._/-]+)|\\$CLAUDE_PLUGIN_ROOT/([A-Za-z0-9._/-]+)");
    private static final Pattern KEY_LINE = Pattern.compile("([A-Za-z0-9_][A-Za-z0-9_-]*):(.*)");
    private static final Pattern SKILL_TOKEN = Pattern.compile("[\\p{L}\\p{N}][\\p{L}\\p{N}_:-]*");
    private static final Pattern UNICODE_ESCAPE = Pattern.compile("\\\\u([0-9a-fA-F]{4})");
    private static final String ROOT_PREFIX = "${CLAUDE_PLUGIN_ROOT}/";
    private static final Map<String, String> EVENTS = Map.of("PreToolUse", "pre_tool_use", "PostToolUse", "post_tool_use");

    private static final ObjectMapper JSON = new ObjectMapper();

    private final Path cacheRoot;
    private final Path marketRoot;

    /** @param home the home folder whose Claude Code plugins are read */
    PluginSources(Path home) {
        Path plugins = home.resolve(".claude").resolve("plugins");
        this.cacheRoot = plugins.resolve("cache");
        this.marketRoot = plugins.resolve("marketplaces");
    }

    /** A refusal of a plugin read; nothing was written. */
    static final class Refusal extends Exception {
        private static final long serialVersionUID = 1L;
        private final transient PlaybookFiles.Refused answer;

        Refusal(int status, String reason, String message) {
            super(null, null, false, false);
            this.answer = new PlaybookFiles.Refused(status, reason, message, null);
        }

        PlaybookFiles.Refused answer() {
            return answer;
        }
    }

    /**
     * One plugin found under a root.
     *
     * @param root        {@link #CACHE} or {@link #MARKETPLACE}
     * @param marketplace the marketplace folder's name
     * @param name        the plugin folder's name in the cache, the entry's name in a marketplace
     * @param version     the version folder's name in the cache; in a marketplace the version of its
     *                    {@code plugin.json}, else of the entry, else empty
     * @param folder      the plugin folder; never echoed
     * @param description the description of {@code plugin.json}, else of the entry
     */
    record Found(String root, String marketplace, String name, String version, Path folder, String description) {
        /** The label PROVENANCE.md names the root with. */
        String where() {
            return CACHE.equals(root) ? "the Claude Code plugin cache" : "a Claude Code marketplace";
        }
    }

    // ---- finding plugins -----------------------------------------------------------------------

    /** Every plugin under the two roots: the cache first, each root sorted by its labels. */
    List<Found> list() {
        List<Found> out = new ArrayList<>();
        Path cache = real(cacheRoot);
        if (cache != null) {
            for (Path market : plainFolders(cache)) {
                for (Path plugin : plainFolders(market)) {
                    for (Path version : plainFolders(plugin)) {
                        JsonNode manifest = manifest(version);
                        if (manifest == null) {
                            continue;
                        }
                        out.add(new Found(CACHE, name(market), name(plugin), name(version), version,
                                manifest.path("description").asText("")));
                    }
                }
            }
        }
        Path markets = real(marketRoot);
        if (markets != null) {
            List<Found> listed = new ArrayList<>();
            for (Path market : plainFolders(markets)) {
                JsonNode entries = readJson(market, MARKET_JSON);
                if (entries == null) {
                    continue;
                }
                for (JsonNode entry : entries.path("plugins")) {
                    String name = entry.path("name").asText("");
                    Path folder = entry.path("source").isTextual() ? inside(market, entry.get("source").asText()) : null;
                    if (name.isEmpty() || folder == null) {
                        continue;
                    }
                    JsonNode manifest = manifest(folder);
                    String version = manifest != null && manifest.path("version").isTextual()
                            ? manifest.get("version").asText() : entry.path("version").asText("");
                    String description = manifest != null && manifest.path("description").isTextual()
                            ? manifest.get("description").asText() : entry.path("description").asText("");
                    listed.add(new Found(MARKETPLACE, name(market), name, version, folder, description));
                }
            }
            listed.sort(Comparator.comparing(Found::marketplace).thenComparing(Found::name)
                    .thenComparing(Found::version));
            out.addAll(listed);
        }
        return out;
    }

    /**
     * The plugin a request names, by string equality against {@link #list()}. Without a root label
     * the cache is asked before the marketplaces.
     */
    Optional<Found> find(String root, String marketplace, String name, String version) {
        if (root != null && !CACHE.equals(root) && !MARKETPLACE.equals(root)) {
            return Optional.empty();
        }
        return list().stream()
                .filter(f -> root == null || f.root().equals(root))
                .filter(f -> f.marketplace().equals(marketplace) && f.name().equals(name) && f.version().equals(version))
                .findFirst();
    }

    /** The row the listing shows: labels, the description, the count of each kind, MCP and licence. */
    Map<String, Object> row(Found found) {
        Map<String, Object> kinds = new LinkedHashMap<>();
        kinds.put("skills", skillFolders(found).size());
        kinds.put("agents", markdown(found.folder().resolve("agents"), false).size());
        kinds.put("commands", markdown(found.folder().resolve("commands"), true).size());
        kinds.put("hooks", hookCount(found));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("root", found.root());
        out.put("marketplace", found.marketplace());
        out.put("name", found.name());
        out.put("version", found.version());
        out.put("description", found.description());
        out.put("kinds", kinds);
        out.put("mcp", !mcpNotCopied(found).isEmpty());
        out.put("licensed", licenceFile(found) != null);
        return out;
    }

    // ---- reading a plugin ----------------------------------------------------------------------

    /** A skill of the plugin: its folder name and its files, relative to the skill folder. */
    record Skill(String name, Map<String, byte[]> files) {}

    /** A text file the import writes: its path in the playbook and its text. */
    record Text(String path, String text) {}

    /** A hook entry in the playbook's form. */
    record Hook(String event, String matcher, String command, Integer timeoutSeconds) {}

    /**
     * What a plugin brings for the chosen kinds, in the playbook's form, with what was left out.
     *
     * @param licence    the bytes of the plugin's licence
     * @param skills     the skills, each to go under {@code skills/<plugin>/}
     * @param agents     {@code agents/<name>.md} with the four allowed fields
     * @param commands   {@code commands/<name>.md}
     * @param hooks      the pre and post tool use hooks
     * @param scripts    {@code hooks/<name>} for each script a hook runs
     * @param dropped    one row per agent field or command left out: path, field (or null), reason
     * @param droppedHooks one row per hook left out: event, matcher, command, reason
     * @param notCopied  the MCP server files and fields, by their path in the plugin
     */
    record Parts(byte[] licence, List<Skill> skills, List<Text> agents, List<Text> commands, List<Hook> hooks,
                 List<Text> scripts, List<Map<String, Object>> dropped, List<Map<String, Object>> droppedHooks,
                 List<String> notCopied) {}

    /** One file the read will take, known by its size before a byte of it is read. */
    private record Planned(Path file, long size) {}

    /**
     * Reads the chosen kinds of a plugin. The file count and the bytes of every file it would take
     * are checked against the playbook's caps before any file is read.
     */
    Parts read(Found found, Set<String> kinds) throws IOException, Refusal {
        Path folder = found.folder();
        Path licenceFile = licenceFile(found);
        if (licenceFile == null) {
            throw new Refusal(400, "unlicensed", "The plugin " + found.name() + " has no LICENSE at its root, so "
                    + "nothing of it is copied: a playbook carries only what it may pass on.");
        }
        List<Path> mcp = mcpFiles(found);
        if (isMcp(mcp, licenceFile)) {
            throw new Refusal(400, "unlicensed", "The LICENSE of the plugin " + found.name() + " is one of its MCP "
                    + "server files, so nothing of it is copied.");
        }
        List<Map<String, Object>> dropped = new ArrayList<>();
        List<Map<String, Object>> droppedHooks = new ArrayList<>();
        Set<String> notCopied = new TreeSet<>(mcpNotCopied(found));

        // Survey: every file the chosen kinds take, by size, without reading one.
        Map<String, Map<String, Planned>> skillFiles = new LinkedHashMap<>();
        if (kinds.contains("skills")) {
            for (Path skill : skillFolders(found)) {
                String name = name(skill);
                if (skillFiles.containsKey(name)) {
                    throw new Refusal(400, "name", "The plugin carries two skills named " + name + ".");
                }
                SafeWalk.Walk walk = SafeWalk.walk(folder, skill);
                if (!walk.refused().isEmpty()) {
                    throw linkRefusal("the skill " + name);
                }
                Map<String, Planned> files = new LinkedHashMap<>();
                for (String rel : walk.files()) {
                    String file = rel.substring(rel.lastIndexOf('/') + 1);
                    Path at = skill.resolve(rel);
                    if (mcpName(file) || isMcp(mcp, at)) {
                        notCopied.add(slashed(folder, at));
                        continue;
                    }
                    if (SKIPPED.contains(file)) {
                        continue;
                    }
                    files.put(rel, new Planned(at, Files.size(at)));
                }
                skillFiles.put(name, files);
            }
        }
        List<Path> agentFiles = kinds.contains("agents")
                ? notMcp(folder, plainMarkdown(folder, "agents", dropped, false), mcp, notCopied) : List.of();
        List<Path> commandFiles = kinds.contains("commands")
                ? notMcp(folder, plainMarkdown(folder, "commands", dropped, true), mcp, notCopied) : List.of();
        List<Hook> hooks = new ArrayList<>();
        Map<String, Path> scriptFiles = new LinkedHashMap<>();
        if (kinds.contains("hooks")) {
            hooks(found, hooks, scriptFiles, droppedHooks, mcp);
        }
        long files = 0;
        long bytes = 0;
        for (Map<String, Planned> skill : skillFiles.values()) {
            for (Planned p : skill.values()) {
                files++;
                bytes += p.size();
            }
        }
        for (Path p : concat(agentFiles, commandFiles, List.copyOf(scriptFiles.values()))) {
            files++;
            bytes += Files.size(p);
        }
        if (files > PlaybookLoader.MAX_FILES) {
            throw new Refusal(413, "too-many-files", "The plugin's chosen parts hold more than "
                    + PlaybookLoader.MAX_FILES + " files, more than a playbook folder may hold. Nothing was copied.");
        }
        if (bytes > PlaybookFiles.MAX_FOLDER_BYTES) {
            throw new Refusal(413, "folder-too-large", "The plugin's chosen parts hold more than 24 MB, more than a "
                    + "playbook folder may hold. Nothing was copied.");
        }

        // Read.
        byte[] licence = readSmall(licenceFile, "its licence");
        List<Skill> skills = new ArrayList<>();
        for (Map.Entry<String, Map<String, Planned>> skill : skillFiles.entrySet()) {
            Map<String, byte[]> read = new LinkedHashMap<>();
            for (Map.Entry<String, Planned> file : skill.getValue().entrySet()) {
                byte[] content = Files.readAllBytes(file.getValue().file());
                if (!file.getKey().toLowerCase(Locale.ROOT).endsWith(".md") && holdsMcpServers(content)) {
                    notCopied.add(slashed(folder, file.getValue().file()));
                    continue;
                }
                read.put(file.getKey(), content);
            }
            skills.add(new Skill(skill.getKey(), read));
        }
        List<Text> agents = new ArrayList<>();
        for (Path file : agentFiles) {
            agents.add(agent(found, file, dropped));
        }
        List<Text> commands = new ArrayList<>();
        for (Path file : commandFiles) {
            commands.add(command(found, file));
        }
        List<Text> scripts = new ArrayList<>();
        for (Map.Entry<String, Path> script : scriptFiles.entrySet()) {
            String text = PlaybookFiles.textOf(readSmall(script.getValue(), "the hook script " + script.getKey()));
            if (text == null) {
                throw new Refusal(415, "script-not-text", "The hook script " + script.getKey()
                        + " is not UTF-8 text of at most 1 MB, so it is not copied.");
            }
            scripts.add(new Text("hooks/" + script.getKey(), text));
        }
        return new Parts(licence, skills, uniqueNames(agents, "agents"), commands, hooks, scripts, dropped,
                droppedHooks, List.copyOf(notCopied));
    }

    // ---- skills --------------------------------------------------------------------------------

    /**
     * The skill folders: each folder holding a SKILL.md under {@code skills/} and under the folders
     * {@code plugin.json} names in {@code skills}. A link in place of a skill folder refuses the
     * import when skills are read; the count of the listing passes over it.
     */
    private List<Path> skillFolders(Found found) {
        List<Path> roots = new ArrayList<>();
        roots.add(found.folder().resolve("skills"));
        JsonNode manifest = manifest(found.folder());
        JsonNode declared = manifest == null ? null : manifest.get("skills");
        List<String> named = new ArrayList<>();
        if (declared != null && declared.isTextual()) {
            named.add(declared.asText());
        } else if (declared != null && declared.isArray()) {
            declared.forEach(d -> named.add(d.asText("")));
        }
        for (String rel : named) {
            Path at = inside(found.folder(), rel);
            if (at != null && !roots.contains(at)) {
                roots.add(at);
            }
        }
        List<Path> out = new ArrayList<>();
        for (Path root : roots) {
            if (!plainFolder(root)) {
                continue;
            }
            for (Path child : children(root)) {
                BasicFileAttributes attrs = attrs(child);
                if (attrs == null) {
                    continue;
                }
                if (attrs.isSymbolicLink() || (attrs.isDirectory() && regular(child.resolve(SKILL_FILE)))) {
                    out.add(child);
                }
            }
        }
        return out;
    }

    // ---- agents and commands -------------------------------------------------------------------

    /**
     * The {@code .md} files directly in a folder of the plugin. A command in a sub folder is named in
     * {@code dropped}; a link anywhere in the folder refuses the import.
     */
    private List<Path> plainMarkdown(Path plugin, String folderName, List<Map<String, Object>> dropped,
                                     boolean nested) throws IOException, Refusal {
        Path folder = plugin.resolve(folderName);
        BasicFileAttributes attrs = attrs(folder);
        if (attrs == null) {
            return List.of();
        }
        if (!attrs.isDirectory()) {
            throw linkRefusal(folderName + "/");
        }
        SafeWalk.Walk walk = SafeWalk.walk(plugin, folder);
        if (!walk.refused().isEmpty()) {
            throw linkRefusal(folderName + "/");
        }
        List<Path> out = new ArrayList<>();
        for (String rel : walk.files()) {
            if (!rel.endsWith(".md")) {
                continue;
            }
            if (rel.contains("/")) {
                if (nested) {
                    dropped.add(row(folderName + "/" + rel, null, "nested"));
                }
                continue;
            }
            out.add(folder.resolve(rel));
        }
        return out;
    }

    /** The files that are none of the plugin's MCP server files; those are named in {@code notCopied}. */
    private static List<Path> notMcp(Path plugin, List<Path> files, List<Path> mcp, Set<String> notCopied) {
        List<Path> out = new ArrayList<>();
        for (Path file : files) {
            if (isMcp(mcp, file)) {
                notCopied.add(slashed(plugin, file));
            } else {
                out.add(file);
            }
        }
        return out;
    }

    /** The {@code .md} files a listing counts: directly in the folder, or at any depth for commands. */
    private static List<Path> markdown(Path folder, boolean nested) {
        if (!plainFolder(folder)) {
            return List.of();
        }
        try (Stream<Path> walk = Files.walk(folder, nested ? 4 : 1)) {
            return walk.filter(p -> p.getFileName().toString().endsWith(".md")).filter(PluginSources::regular)
                    .sorted().toList();
        } catch (IOException | RuntimeException unreadable) {
            return List.of();
        }
    }

    /** The frontmatter of a markdown file: key lines with their folded values, and the body. */
    private record Front(boolean present, Map<String, String> fields, String body) {}

    private static Front front(String raw) {
        String text = raw.replace("\r\n", "\n");
        String[] lines = text.split("\n", -1);
        int first = 0;
        while (first < lines.length && lines[first].isBlank()) {
            first++;
        }
        if (first >= lines.length || !lines[first].strip().equals("---")) {
            return new Front(false, Map.of(), text);
        }
        int close = -1;
        for (int i = first + 1; i < lines.length; i++) {
            if (lines[i].strip().equals("---")) {
                close = i;
                break;
            }
        }
        if (close < 0) {
            return new Front(false, Map.of(), text);
        }
        Map<String, List<String>> raws = new LinkedHashMap<>();
        String key = null;
        for (int i = first + 1; i < close; i++) {
            String line = lines[i];
            Matcher m = KEY_LINE.matcher(line);
            if (!line.startsWith(" ") && !line.startsWith("\t") && m.matches()) {
                key = m.group(1);
                List<String> parts = new ArrayList<>();
                parts.add(m.group(2).strip());
                raws.put(key, parts);
            } else if (key != null && !line.isBlank()) {
                raws.get(key).add(line.strip());
            }
        }
        Map<String, String> fields = new LinkedHashMap<>();
        raws.forEach((k, v) -> fields.put(k, fold(v)));
        StringBuilder body = new StringBuilder();
        for (int i = close + 1; i < lines.length; i++) {
            body.append(lines[i]);
            if (i < lines.length - 1) {
                body.append('\n');
            }
        }
        return new Front(true, fields, body.toString());
    }

    /** A YAML value folded onto one line: a block scalar or a plain value over several lines, unquoted. */
    private static String fold(List<String> parts) {
        String head = parts.get(0);
        List<String> rest = parts.subList(1, parts.size());
        String joined = head.matches("[|>][+-]?[0-9]?[+-]?") ? String.join(" ", rest)
                : String.join(" ", parts).strip();
        if (joined.length() >= 2) {
            char q = joined.charAt(0);
            if ((q == '"' || q == '\'') && joined.charAt(joined.length() - 1) == q) {
                joined = joined.substring(1, joined.length() - 1);
                if (q == '"') {
                    joined = joined.replace("\\n", " ").replace("\\\"", "\"");
                } else {
                    joined = joined.replace("''", "'");
                }
            }
        }
        return joined.replaceAll("\\s+", " ").strip();
    }

    /**
     * An agent in the playbook's form: name, description, type and skill, then the body. Every
     * other field is named in {@code dropped} with the reason the agent reader gives for it.
     */
    private Text agent(Found found, Path file, List<Map<String, Object>> dropped) throws IOException, Refusal {
        String stem = stem(file);
        String raw = textOrRefuse(file, "the agent " + stem);
        Front f = front(raw);
        String name = f.fields().getOrDefault("name", "");
        if (name.isEmpty()) {
            name = stem;
        }
        if (!PlaybookValidator.PATH_SEGMENT.matcher(name).matches()) {
            throw new Refusal(400, "name", "The agent " + name + " has a name a playbook does not take: it starts "
                    + "with a letter or a digit and holds only letters, digits, '_' and '-'.");
        }
        String path = "agents/" + name + ".md";
        String description = f.fields().getOrDefault("description", "");
        if (description.isEmpty()) {
            description = "An agent of the plugin " + found.name() + ".";
        }
        String type = f.fields().get("type");
        if (type != null && !AgentFile.TYPES.contains(type)) {
            dropped.add(row(path, "type", "type"));
        }
        if (type == null || !AgentFile.TYPES.contains(type)) {
            type = "worker";
        }
        String skill = f.fields().get("skill");
        if (skill != null && !SKILL_TOKEN.matcher(skill).matches()) {
            dropped.add(row(path, "skill", "not-a-playbook-field"));
            skill = null;
        }
        for (String field : f.fields().keySet()) {
            if (!AgentFile.FIELDS.contains(field)) {
                dropped.add(row(path, field, fieldReason(field)));
            }
        }
        StringBuilder text = new StringBuilder("---\n")
                .append("name: ").append(name).append('\n')
                .append("description: ").append(description).append('\n')
                .append("type: ").append(type).append('\n');
        if (skill != null && !skill.isEmpty()) {
            text.append("skill: ").append(skill).append('\n');
        }
        text.append("---\n\n").append(f.body().strip()).append('\n');
        AgentFile.Read read = AgentFile.read(text.toString(), path);
        if (read.agent() == null || !read.findings().isEmpty()) {
            Finding first = read.findings().isEmpty() ? new Finding(path, "unreadable") : read.findings().get(0);
            throw new Refusal(400, "not-an-agent", "The agent " + name + " does not read as a playbook agent: "
                    + first.path() + " " + first.message() + ".");
        }
        return new Text(path, text.toString());
    }

    /**
     * Why an agent field is left out, in the words of the agent reader itself: a field it refuses
     * outright, one it says others set, or one it does not know.
     */
    private static String fieldReason(String field) {
        String at = "agents/x.md#" + field;
        AgentFile.Read read = AgentFile.read("---\n" + field + ": x\n---\n\nx\n", "agents/x.md");
        if (read.agent() == null) {
            return "refused";
        }
        return read.findings().stream().filter(f -> f.path().equals(at))
                .anyMatch(f -> f.message().equals("unknown field")) ? "not-a-playbook-field" : "set-by-others";
    }

    /** Two agent files that name the same agent cannot both land. */
    private static List<Text> uniqueNames(List<Text> texts, String kind) throws Refusal {
        Set<String> seen = new TreeSet<>();
        for (Text t : texts) {
            if (!seen.add(t.path())) {
                throw new Refusal(400, "name", "Two " + kind + " of the plugin go to " + t.path() + ".");
            }
        }
        return texts;
    }

    /**
     * A command as a prompt file. One without a description in its frontmatter gets its first line
     * as one, which is what Claude Code shows for it.
     */
    private Text command(Found found, Path file) throws IOException, Refusal {
        String stem = stem(file);
        if (!PlaybookValidator.PATH_SEGMENT.matcher(stem).matches()) {
            throw new Refusal(400, "name", "The command " + stem + " has a name a playbook does not take: it starts "
                    + "with a letter or a digit and holds only letters, digits, '_' and '-'.");
        }
        String raw = textOrRefuse(file, "the command " + stem);
        String path = "commands/" + stem + ".md";
        if (!PlaybookContents.frontmatterDescription(raw).isBlank()) {
            return new Text(path, raw);
        }
        Front f = front(raw);
        String line = (f.present() ? f.body() : raw).lines().map(String::strip).filter(l -> !l.isEmpty())
                .map(l -> l.replaceFirst("^#+\\s*", "")).findFirst().orElse("");
        if (line.length() > 200) {
            line = line.substring(0, 200).strip();
        }
        String description = line.isEmpty() ? "A command of the plugin " + found.name() + "." : line;
        if (!f.present()) {
            return new Text(path, "---\ndescription: " + description + "\n---\n\n" + raw);
        }
        int open = raw.indexOf("---");
        int afterOpen = raw.indexOf('\n', open) + 1;
        return new Text(path, raw.substring(0, afterOpen) + "description: " + description + "\n" + raw.substring(afterOpen));
    }

    // ---- hooks ---------------------------------------------------------------------------------

    private JsonNode hooksJson(Found found) throws Refusal {
        Path file = found.folder().resolve("hooks").resolve("hooks.json");
        BasicFileAttributes dirAttrs = attrs(file.getParent());
        BasicFileAttributes attrs = attrs(file);
        if (dirAttrs == null || attrs == null) {
            return null;
        }
        if (!dirAttrs.isDirectory() || !attrs.isRegularFile()) {
            throw linkRefusal("hooks/hooks.json");
        }
        return readJson(found.folder(), "hooks/hooks.json");
    }

    private int hookCount(Found found) {
        try {
            JsonNode root = hooksJson(found);
            int n = 0;
            if (root != null) {
                for (JsonNode groups : iterable(root.path("hooks").elements())) {
                    for (JsonNode group : groups) {
                        n += group.path("hooks").size();
                    }
                }
            }
            return n;
        } catch (Refusal linked) {
            return 0;
        }
    }

    /**
     * Maps the plugin's {@code hooks/hooks.json}: PreToolUse and PostToolUse command hooks become
     * {@code pre_tool_use} and {@code post_tool_use} entries, with every file of the plugin they run
     * copied to {@code hooks/} and named {@code {hooks}/<name>}. Every other hook is named in
     * {@code dropped}.
     */
    private void hooks(Found found, List<Hook> out, Map<String, Path> scripts, List<Map<String, Object>> dropped,
                       List<Path> mcp) throws IOException, Refusal {
        JsonNode root = hooksJson(found);
        if (root == null) {
            return;
        }
        Iterator<Map.Entry<String, JsonNode>> events = root.path("hooks").fields();
        while (events.hasNext()) {
            Map.Entry<String, JsonNode> event = events.next();
            String mapped = EVENTS.get(event.getKey());
            for (JsonNode group : event.getValue()) {
                String matcher = group.path("matcher").isTextual() ? group.get("matcher").asText() : null;
                for (JsonNode handler : group.path("hooks")) {
                    String command = handler.path("command").isTextual() ? handler.get("command").asText() : null;
                    if (mapped == null) {
                        dropped.add(hookRow(event.getKey(), matcher, command, "event"));
                        continue;
                    }
                    if (!"command".equals(handler.path("type").asText("")) || command == null || command.isBlank()) {
                        dropped.add(hookRow(event.getKey(), matcher, command, "type"));
                        continue;
                    }
                    String rewritten = rootRefs(found.folder(), command, scripts, mcp);
                    if (rewritten == null || rewritten.contains("CLAUDE_PLUGIN_")) {
                        dropped.add(hookRow(event.getKey(), matcher, command, "plugin-root"));
                        continue;
                    }
                    Integer timeout = handler.path("timeout").isIntegralNumber() ? handler.get("timeout").asInt() : null;
                    out.add(new Hook(mapped, matcher, rewritten, timeout));
                }
            }
        }
    }

    /**
     * The command with each {@code ${CLAUDE_PLUGIN_ROOT}/<path>} that names a regular file of the
     * plugin written as {@code {hooks}/<name>}, and the file added to {@code scripts}. Null when a
     * path names nothing the import copies; a link on the way refuses the import.
     */
    private static String rootRefs(Path plugin, String command, Map<String, Path> scripts, List<Path> mcp)
            throws IOException, Refusal {
        Matcher m = ROOT_REF.matcher(command);
        StringBuilder out = new StringBuilder();
        Map<String, Path> found = new LinkedHashMap<>();
        while (m.find()) {
            String rel = m.group(1) != null ? m.group(1) : m.group(2);
            if (notAScript(rel)) {
                return null;
            }
            Path file = plainFile(plugin, rel);
            if (file == null || pluginOwn(plugin, file, mcp)
                    || Files.size(file) <= PlaybookFiles.MAX_TEXT_BYTES && holdsMcpServers(Files.readAllBytes(file))) {
                return null;
            }
            String name = name(file);
            if (!PlaybookFiles.nameOk("hooks/" + name)) {
                throw new Refusal(409, "script-name", "The hook script " + name + " has a name the playbook folder "
                        + "does not take. Nothing was copied.");
            }
            Path earlier = scripts.containsKey(name) ? scripts.get(name) : found.get(name);
            if (earlier != null && !earlier.equals(file)) {
                throw new Refusal(409, "script-name", "Two different hook scripts of the plugin are both named " + name
                        + ". Nothing was copied.");
            }
            found.put(name, file);
            m.appendReplacement(out, Matcher.quoteReplacement(PlaybookContents.HOOKS_PLACEHOLDER + "/" + name));
        }
        m.appendTail(out);
        scripts.putAll(found);
        return out.toString();
    }

    /**
     * True for a path no hook script is copied from: a file in a manifest folder (it holds
     * {@code mcpServers}), an MCP server file, and a file named {@code hooks.json}, which would
     * land on the playbook's own hook list. Compared in lower case, since a disk that ignores case
     * reaches the same file under any spelling.
     */
    private static boolean notAScript(String rel) {
        String lower = rel.toLowerCase(Locale.ROOT);
        String name = lower.substring(lower.lastIndexOf('/') + 1);
        return ("/" + lower).contains("/" + MANIFEST_DIR + "/") || mcpName(name) || name.equals("hooks.json");
    }

    /** True for a file name that names an MCP server file, in any case. */
    private static boolean mcpName(String name) {
        return name.toLowerCase(Locale.ROOT).endsWith(MCP_JSON);
    }

    /**
     * True when the bytes hold {@code mcpServers} in any case. NUL bytes are left out first, so a
     * UTF-16 text is read too, and JSON unicode escapes are decoded until none is left, so a key a
     * JSON parser reads as {@code mcpServers} is found whatever letters were escaped.
     */
    private static boolean holdsMcpServers(byte[] bytes) {
        StringBuilder text = new StringBuilder(bytes.length);
        for (byte b : bytes) {
            if (b != 0) {
                text.append((char) (b & 0xff));
            }
        }
        String plain = text.toString();
        for (int round = 0; round < 8; round++) {
            String decoded = UNICODE_ESCAPE.matcher(plain).replaceAll(m -> Matcher.quoteReplacement(
                    String.valueOf((char) Integer.parseInt(m.group(1), 16))));
            if (decoded.equals(plain)) {
                break;
            }
            plain = decoded;
        }
        return plain.toLowerCase(Locale.ROOT).contains("mcpservers");
    }

    /**
     * True when the file is, by identity on disk, one of the plugin's MCP server files, its
     * {@code hooks/hooks.json} or a file in its manifest folder, whatever the path spelled.
     */
    private static boolean pluginOwn(Path plugin, Path file, List<Path> mcp) {
        if (isMcp(mcp, file) || sameFile(plugin.resolve("hooks").resolve("hooks.json"), file)) {
            return true;
        }
        Path manifest = plugin.resolve(MANIFEST_DIR);
        for (Path at = file.getParent(); at != null && at.startsWith(plugin) && !at.equals(plugin);
                at = at.getParent()) {
            if (sameFile(at, manifest)) {
                return true;
            }
        }
        return false;
    }

    /** True when the file is, by identity on disk, one of the given files. */
    private static boolean isMcp(List<Path> mcp, Path file) {
        for (Path own : mcp) {
            if (sameFile(own, file)) {
                return true;
            }
        }
        return false;
    }

    /**
     * True when both paths are the same file on disk. Neither is followed when it is a link, and
     * an entry that cannot be read is not the same file: a link that leads nowhere compares false.
     */
    private static boolean sameFile(Path a, Path b) {
        BasicFileAttributes x = attrs(a);
        BasicFileAttributes y = attrs(b);
        if (x == null || y == null || x.isSymbolicLink() || y.isSymbolicLink()) {
            return false;
        }
        if (x.fileKey() != null && y.fileKey() != null) {
            return x.fileKey().equals(y.fileKey());
        }
        try {
            return Files.isSameFile(a, b);
        } catch (IOException unreadable) {
            return false;
        }
    }

    /** A regular file at a relative path inside the plugin, every step read without following a link. */
    private static Path plainFile(Path plugin, String rel) throws Refusal {
        Path at = plugin;
        String[] segments = rel.split("/");
        for (int i = 0; i < segments.length; i++) {
            String s = segments[i];
            if (s.isEmpty() || s.equals(".") || s.equals("..")) {
                return null;
            }
            at = at.resolve(s);
            BasicFileAttributes attrs = attrs(at);
            if (attrs == null) {
                return null;
            }
            if (attrs.isSymbolicLink()) {
                throw linkRefusal(rel);
            }
            boolean last = i == segments.length - 1;
            if (last ? !attrs.isRegularFile() : !attrs.isDirectory()) {
                return null;
            }
        }
        return at;
    }

    // ---- MCP servers and the licence ----------------------------------------------------------

    /**
     * The MCP server files and fields a plugin carries at its root or names in its manifest, which
     * no import copies.
     */
    private List<String> mcpNotCopied(Found found) {
        List<String> out = new ArrayList<>();
        JsonNode manifest = manifest(found.folder());
        if (manifest != null && manifest.has("mcpServers")) {
            out.add(PLUGIN_JSON + "#mcpServers");
        }
        if (attrs(found.folder().resolve(MCP_JSON)) != null) {
            out.add(MCP_JSON);
        }
        for (Path named : mcpNamed(found)) {
            out.add(slashed(found.folder(), named));
        }
        return out;
    }

    /**
     * The entries {@code plugin.json#mcpServers} names when it is a path or a list of paths, each
     * read inside the plugin like a marketplace source. Claude Code reads such a file as MCP server
     * configuration, with or without the {@code mcpServers} key in it.
     */
    private static List<Path> mcpNamed(Found found) {
        JsonNode manifest = manifest(found.folder());
        JsonNode servers = manifest == null ? null : manifest.get("mcpServers");
        List<String> named = new ArrayList<>();
        if (servers != null && servers.isTextual()) {
            named.add(servers.asText());
        } else if (servers != null && servers.isArray()) {
            servers.forEach(s -> {
                if (s.isTextual()) {
                    named.add(s.asText());
                }
            });
        }
        List<Path> out = new ArrayList<>();
        for (String path : named) {
            String rel = path.startsWith(ROOT_PREFIX) ? path.substring(ROOT_PREFIX.length()) : path;
            for (String spelling : List.of(rel, rel.replace('\\', '/'))) {
                Path at = named(found.folder(), spelling);
                if (at != null && attrs(at) != null && !out.contains(at)) {
                    out.add(at);
                }
            }
        }
        return out;
    }

    /**
     * The file a manifest path names, with {@code .} and {@code ..} taken out by text as Node's
     * {@code path.resolve} does, or null when it leaves the plugin or names the plugin itself. A path
     * that passes a linked folder names the file the link reaches, when that file is in the plugin.
     */
    private static Path named(Path plugin, String spelling) {
        Path at;
        try {
            at = (spelling.startsWith("/") ? Path.of(spelling) : plugin.resolve(spelling)).normalize();
        } catch (java.nio.file.InvalidPathException notAPath) {
            return null;
        }
        if (!at.startsWith(plugin) || at.equals(plugin)) {
            return null;
        }
        boolean linked = false;
        for (Path folder = at.getParent(); !folder.equals(plugin); folder = folder.getParent()) {
            BasicFileAttributes attrs = attrs(folder);
            if (attrs == null || !(attrs.isDirectory() || attrs.isSymbolicLink())) {
                return null;
            }
            linked |= attrs.isSymbolicLink();
        }
        if (!linked) {
            return at;
        }
        try {
            Path real = at.toRealPath();
            Path base = plugin.toRealPath();
            return real.startsWith(base) && !real.equals(base) ? real : null;
        } catch (IOException leadsNowhere) {
            return null;
        }
    }

    /**
     * Every MCP server file of the plugin as a file on disk: each file whose name ends in
     * {@code .mcp.json} in any case at any depth, the files the manifest names, and the manifest
     * itself when it holds {@code mcpServers}. A link among them stands for the file it leads to;
     * a link that leads nowhere stands for nothing. A folder that cannot be read refuses the
     * import, since an MCP server file in it could not be told apart.
     */
    private static List<Path> mcpFiles(Found found) throws Refusal {
        Path plugin = found.folder();
        List<Path> entries = new ArrayList<>(mcpNamed(found));
        JsonNode manifest = manifest(plugin);
        if (manifest != null && manifest.has("mcpServers")) {
            entries.add(plugin.resolve(MANIFEST_DIR).resolve("plugin.json"));
        }
        List<Path> unread = new ArrayList<>();
        java.util.ArrayDeque<Path> folders = new java.util.ArrayDeque<>(List.of(plugin));
        while (!folders.isEmpty()) {
            Path folder = folders.pop();
            try (java.nio.file.DirectoryStream<Path> children = Files.newDirectoryStream(folder)) {
                for (Path child : children) {
                    BasicFileAttributes attrs = attrs(child);
                    if (attrs == null) {
                        unread.add(child);
                    } else if (attrs.isDirectory()) {
                        folders.push(child);
                    } else if (mcpName(name(child))) {
                        entries.add(child);
                    }
                }
            } catch (IOException | java.nio.file.DirectoryIteratorException failure) {
                unread.add(folder);
            }
        }
        if (!unread.isEmpty()) {
            String where = slashed(plugin, unread.get(0));
            throw new Refusal(400, "plugin-unreadable", "A folder of the plugin " + found.name() + " cannot be read ("
                    + (where.isEmpty() ? "." : where) + "), so nothing of it was copied.");
        }
        List<Path> out = new ArrayList<>();
        for (Path entry : entries) {
            BasicFileAttributes attrs = attrs(entry);
            if (attrs != null && attrs.isSymbolicLink()) {
                try {
                    Path target = entry.toRealPath();
                    if (regular(target)) {
                        out.add(target);
                    }
                } catch (IOException leadsNowhere) {
                    // nothing on disk to compare with
                }
            } else if (attrs != null && attrs.isRegularFile()) {
                out.add(entry);
            }
        }
        return out;
    }

    private static Path licenceFile(Found found) {
        for (String name : LICENCE_NAMES) {
            Path file = found.folder().resolve(name);
            if (regular(file)) {
                return file;
            }
        }
        return null;
    }

    // ---- small reads ---------------------------------------------------------------------------

    private static byte[] readSmall(Path file, String what) throws IOException, Refusal {
        if (!regular(file)) {
            throw linkRefusal(what);
        }
        if (Files.size(file) > PlaybookFiles.MAX_TEXT_BYTES) {
            throw new Refusal(413, "plugin-file", "The plugin's " + what + " is larger than 1 MB. Nothing was copied.");
        }
        return Files.readAllBytes(file);
    }

    private static String textOrRefuse(Path file, String what) throws IOException, Refusal {
        String text = PlaybookFiles.textOf(readSmall(file, what));
        if (text == null) {
            throw new Refusal(415, "plugin-file", "The plugin's " + what + " is not UTF-8 text. Nothing was copied.");
        }
        return text;
    }

    private static JsonNode manifest(Path folder) {
        return readJson(folder, PLUGIN_JSON);
    }

    /** A JSON file of at most 1 MB at a relative path, every step read without following a link. */
    private static JsonNode readJson(Path folder, String rel) {
        Path at = folder;
        for (String segment : rel.split("/")) {
            at = at.resolve(segment);
            BasicFileAttributes attrs = attrs(at);
            if (attrs == null || attrs.isSymbolicLink()) {
                return null;
            }
        }
        try {
            if (!regular(at) || Files.size(at) > PlaybookLoader.MAX_BYTES) {
                return null;
            }
            JsonNode node = JSON.readTree(Files.readString(at, StandardCharsets.UTF_8));
            return node != null && node.isObject() ? node : null;
        } catch (IOException | RuntimeException unreadable) {
            return null;
        }
    }

    /**
     * The folder a marketplace entry's source names: a relative path without {@code ..}, every
     * step a plain folder inside the marketplace. Null for anything else, a remote source included.
     */
    private static Path inside(Path base, String source) {
        String rel = source.startsWith("./") ? source.substring(2) : source;
        if (rel.startsWith("/") || rel.contains("\\")) {
            return null;
        }
        Path at = base;
        for (String segment : rel.split("/")) {
            if (segment.isEmpty() || segment.equals(".")) {
                continue;
            }
            if (segment.equals("..")) {
                return null;
            }
            at = at.resolve(segment);
            if (!plainFolder(at)) {
                return null;
            }
        }
        return at;
    }

    private static Path real(Path root) {
        try {
            return Files.isDirectory(root) ? root.toRealPath() : null;
        } catch (IOException unreadable) {
            return null;
        }
    }

    private static List<Path> plainFolders(Path dir) {
        return children(dir).stream().filter(PluginSources::plainFolder).toList();
    }

    private static List<Path> children(Path dir) {
        try (Stream<Path> listed = Files.list(dir)) {
            return listed.sorted().toList();
        } catch (IOException | RuntimeException unreadable) {
            return List.of();
        }
    }

    private static BasicFileAttributes attrs(Path path) {
        try {
            return Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        } catch (IOException absent) {
            return null;
        }
    }

    private static boolean plainFolder(Path path) {
        BasicFileAttributes attrs = attrs(path);
        return attrs != null && attrs.isDirectory();
    }

    private static boolean regular(Path path) {
        BasicFileAttributes attrs = attrs(path);
        return attrs != null && attrs.isRegularFile();
    }

    private static String name(Path path) {
        return path.getFileName().toString();
    }

    private static String stem(Path file) {
        String n = name(file);
        return n.endsWith(".md") ? n.substring(0, n.length() - 3) : n;
    }

    private static String slashed(Path base, Path path) {
        String s = base.relativize(path).toString();
        String sep = path.getFileSystem().getSeparator();
        return "/".equals(sep) ? s : s.replace(sep, "/");
    }

    private static Refusal linkRefusal(String what) {
        return new Refusal(400, "link", "The plugin's " + what + " is or holds a symbolic link, or something that is "
                + "not a regular file. Nothing was copied.");
    }

    private static Map<String, Object> row(String path, String field, String reason) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("path", path);
        out.put("field", field);
        out.put("reason", reason);
        return out;
    }

    private static Map<String, Object> hookRow(String event, String matcher, String command, String reason) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("event", event);
        out.put("matcher", matcher);
        out.put("command", command);
        out.put("reason", reason);
        return out;
    }

    @SafeVarargs
    private static List<Path> concat(List<Path>... lists) {
        List<Path> out = new ArrayList<>();
        for (List<Path> l : lists) {
            out.addAll(l);
        }
        return out;
    }

    private static <T> Iterable<T> iterable(Iterator<T> it) {
        return () -> it;
    }
}
