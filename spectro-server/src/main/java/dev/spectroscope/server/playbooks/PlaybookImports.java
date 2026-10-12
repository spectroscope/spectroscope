package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.config.HookConfig;
import dev.spectroscope.core.playbook.AgentFile;
import dev.spectroscope.core.playbook.ContentHash;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.PlaybookValidator;
import dev.spectroscope.core.playbook.PlaybookWriter;
import dev.spectroscope.core.playbook.SafeWalk;
import dev.spectroscope.core.skills.Skill;
import dev.spectroscope.core.skills.SkillLibrary;
import dev.spectroscope.server.settings.SkillCatalogue;
import dev.spectroscope.server.settings.StagedInstall;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.UnaryOperator;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Assembles a playbook bundle from what the machine already has (card 523): skills from the
 * installed roots and the catalogue, the hooks of the user settings, agents and commands from a
 * template, and the removal of a {@code contents} entry with its files.
 *
 * <p>A source is named by a root label, a pack and a name, or by a catalogue id, and is found by
 * enumerating the known roots and the catalogue; nothing from the request is resolved as a path. A
 * source skill with a symbolic link or a file that is not regular is refused as a whole. Every
 * route reads {@code playbook.json} first and refuses one that does not read cleanly, because the
 * canonical writer would drop what it does not know. Every route that changes {@code contents}
 * writes {@code playbook.json} through {@link PlaybookWriter}, after the files, under the lock the
 * playbook editor and the file routes hold, and only while the file on disk is the one it read.
 * Hooks are written into the playbook only; the settings file is read and never written.
 */
final class PlaybookImports {

    /** The pack a flat installed skill and a catalogue skill go into. */
    static final String IMPORTED_PACK = "imported";
    /** Where a skill is built before it moves into place, inside the playbook folder. */
    static final String STAGING = ".import-staging";
    /** Files a source skill carries that belong to its installation, not to the skill. */
    static final Set<String> SKIPPED = Set.of(".disabled", ".DS_Store", PlaybookInstaller.INSTALL_RECORD);
    /** The root labels, in the order a lookup without a label tries them: project over user. */
    static final List<String> ROOT_LABELS = List.of("project", "user");

    private static final String SKILL_FILE = "SKILL.md";
    private static final String LICENCE = PlaybookInstaller.LICENCE_FILE;
    private static final String HOOKS_FILE = "hooks/hooks.json";
    private static final String HOOKS_PLACEHOLDER = PlaybookContents.HOOKS_PLACEHOLDER;
    private static final String SEG = PlaybookValidator.PATH_SEGMENT.pattern();
    private static final Pattern SKILL_TOKEN = Pattern.compile("[\\p{L}\\p{N}][\\p{L}\\p{N}_:-]*");
    private static final Map<String, Pattern> SHAPES = Map.of(
            "skills", Pattern.compile("skills/" + SEG),
            "agents", Pattern.compile("agents/" + SEG + "\\.md"),
            "hooks", Pattern.compile("hooks/hooks\\.json"),
            "commands", Pattern.compile("commands/" + SEG + "\\.md"),
            "workflows", Pattern.compile("workflows/[^/\\\\]+"));
    /** File name endings of a script a hook command may run. */
    private static final Pattern SCRIPT_NAME = Pattern.compile(".+\\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|ps1)");

    private static final ObjectMapper JSON = new ObjectMapper();

    private final Path home;
    /** The one dot folder below the home a hook script may come from: the spectro home's own name. */
    private final String scriptDotFolder;
    private final Map<String, Path> roots = new LinkedHashMap<>();
    private final Path launchDir;
    private final Path userSettings;
    /** The Claude Code plugins of the home, read for the Plugin tab (card 526). */
    private final PluginSources plugins;
    /** Runs between the files a route writes and the {@code playbook.json} it writes; a test makes it fail. */
    private Step midway = () -> { };

    /**
     * @param spectroHome   {@code ~/.spectro}; its parent is the home folder
     * @param projectSkills the launch directory's {@code .spectro/skills}
     * @param launchDir     the project folder, the second place a hook script may come from
     * @param userSettings  the user settings file whose hooks are imported
     */
    PlaybookImports(Path spectroHome, Path projectSkills, Path launchDir, Path userSettings) {
        Path spectro = spectroHome.toAbsolutePath().normalize();
        this.home = spectro.getParent();
        this.scriptDotFolder = spectro.getFileName().toString();
        this.roots.put("user", spectro.resolve("skills"));
        this.roots.put("project", projectSkills.toAbsolutePath().normalize());
        this.launchDir = launchDir.toAbsolutePath().normalize();
        this.userSettings = userSettings;
        this.plugins = new PluginSources(home);
    }

    /** One step of a route that may fail. */
    @FunctionalInterface
    interface Step {
        void run() throws IOException;
    }

    /** Sets the step that runs between a route's files and its {@code playbook.json}, for a test. */
    PlaybookImports midway(Step step) {
        this.midway = step;
        return this;
    }

    // ---- the answers ---------------------------------------------------------------------------

    /** A refusal raised in the middle of a route; everything written so far is taken back. */
    private static final class Abort extends Exception {
        private static final long serialVersionUID = 1L;
        private final transient PlaybookFiles.Answer answer;

        Abort(PlaybookFiles.Answer answer) {
            super(null, null, false, false);
            this.answer = answer;
        }
    }

    private static PlaybookFiles.Refused refused(int status, String reason, String message) {
        return new PlaybookFiles.Refused(status, reason, message, null);
    }

    // ---- the playbook file ---------------------------------------------------------------------

    /** The {@code playbook.json} a route started from. */
    private record Current(Playbook playbook, String hash) {}

    private static Current current(Path root, JsonNode body) throws IOException, Abort {
        Path file = root.resolve(PlaybookFolders.PLAYBOOK_FILE);
        BasicFileAttributes attrs;
        try {
            attrs = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        } catch (IOException absent) {
            throw new Abort(refused(400, "playbook-unreadable", "The folder has no playbook.json."));
        }
        if (!attrs.isRegularFile() || attrs.size() > PlaybookLoader.MAX_BYTES) {
            throw new Abort(refused(400, "playbook-unreadable",
                    "playbook.json is not a plain file of at most 1 MB, so it is not changed."));
        }
        byte[] bytes = Files.readAllBytes(file);
        String hash = EditorView.sha256(bytes);
        String base = body == null ? "" : body.path("baseHash").asText("");
        if (!base.isEmpty() && !base.equals(hash)) {
            throw new Abort(new PlaybookFiles.Refused(409, "changed",
                    "playbook.json changed on disk since it was read.", hash));
        }
        PlaybookReader.Read read = PlaybookReader.read(new String(bytes, StandardCharsets.UTF_8));
        if (read.playbook() == null) {
            throw new Abort(refused(400, "playbook-unreadable",
                    "playbook.json does not read as a playbook. Fix it in the editor first."));
        }
        if (!read.findings().isEmpty()) {
            throw new Abort(refused(400, "playbook-findings", "playbook.json has a finding at "
                    + read.findings().get(0).path() + ". Fix it in the editor first, so that nothing is lost when "
                    + "the contents are written."));
        }
        return new Current(read.playbook(), hash);
    }

    /**
     * Writes {@code playbook.json} with changed contents in the canonical form, while the file on disk
     * is still the one {@code cur} read. Answers the hash now on disk; writes nothing when the contents
     * did not change.
     */
    private static String writeContents(Path root, Current cur, UnaryOperator<Playbook.Contents> change)
            throws IOException, Abort {
        Playbook p = cur.playbook();
        Playbook.Contents now = change.apply(p.contents());
        if (now.equals(p.contents())) {
            return cur.hash();
        }
        Path file = root.resolve(PlaybookFolders.PLAYBOOK_FILE);
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)
                || !EditorView.sha256(Files.readAllBytes(file)).equals(cur.hash())) {
            throw new Abort(new PlaybookFiles.Refused(409, "changed", "playbook.json changed on disk since it was read.",
                    Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) ? EditorView.sha256(Files.readAllBytes(file)) : ""));
        }
        Playbook changed = new Playbook(p.schemaVersion(), p.id(), p.name(), p.description(), p.models(),
                p.documents(), p.checks(), p.vars(), p.start(), p.nodes(), p.arrows(), now);
        byte[] bytes = PlaybookWriter.write(changed).getBytes(StandardCharsets.UTF_8);
        PlaybookFileWriter.writeAtomically(file, bytes);
        return EditorView.sha256(bytes);
    }

    private static Playbook.Contents with(Playbook.Contents c, String kind, String entry, boolean add) {
        List<String> skills = edit(c.skills(), "skills", kind, entry, add);
        List<String> agents = edit(c.agents(), "agents", kind, entry, add);
        List<String> hooks = edit(c.hooks(), "hooks", kind, entry, add);
        List<String> commands = edit(c.commands(), "commands", kind, entry, add);
        List<String> workflows = edit(c.workflows(), "workflows", kind, entry, add);
        return new Playbook.Contents(skills, agents, hooks, commands, workflows);
    }

    private static List<String> edit(List<String> list, String own, String kind, String entry, boolean add) {
        List<String> out = new ArrayList<>(list == null ? List.of() : list);
        if (own.equals(kind)) {
            if (add && !out.contains(entry)) {
                out.add(entry);
            } else if (!add) {
                out.removeIf(entry::equals);
            }
        }
        return List.copyOf(out);
    }

    private static List<String> listed(Playbook.Contents c, String kind) {
        List<String> list = switch (kind) {
            case "skills" -> c.skills();
            case "agents" -> c.agents();
            case "hooks" -> c.hooks();
            case "commands" -> c.commands();
            default -> c.workflows();
        };
        return list == null ? List.of() : list;
    }

    private static Map<String, Object> contentsBody(Path root) throws IOException {
        Playbook p = PlaybookReader.read(Files.readString(root.resolve(PlaybookFolders.PLAYBOOK_FILE),
                StandardCharsets.UTF_8)).playbook();
        Map<String, Object> out = new LinkedHashMap<>();
        if (p != null) {
            for (String kind : List.of("skills", "agents", "hooks", "commands", "workflows")) {
                out.put(kind, listed(p.contents(), kind));
            }
        }
        return out;
    }

    private static PlaybookFiles.Done done(Path root, String hash, Map<String, Object> fields) throws IOException {
        Map<String, Object> out = new LinkedHashMap<>(fields);
        out.put("sha256", hash);
        out.put("contents", contentsBody(root));
        return new PlaybookFiles.Done(out);
    }

    // ---- the sources ---------------------------------------------------------------------------

    /** One installed skill: its root label, its pack or null, its folder name and folder. */
    private record Installed(String root, Path rootPath, String pack, String name, Path folder, boolean link) {
        String display() {
            return pack == null ? name : pack + SkillLibrary.NAMESPACE_SEPARATOR + name;
        }

        String targetPack() {
            return pack == null ? IMPORTED_PACK : pack;
        }
    }

    /** Every installed skill under the known roots, without following a link. */
    private List<Installed> installed() {
        List<Installed> out = new ArrayList<>();
        for (Map.Entry<String, Path> root : roots.entrySet()) {
            for (Path child : children(root.getValue())) {
                BasicFileAttributes attrs = attrs(child);
                if (attrs == null) {
                    continue;
                }
                String name = child.getFileName().toString();
                if (attrs.isSymbolicLink()) {
                    out.add(new Installed(root.getKey(), root.getValue(), null, name, child, true));
                } else if (attrs.isDirectory() && Files.isRegularFile(child.resolve(SKILL_FILE), LinkOption.NOFOLLOW_LINKS)) {
                    out.add(new Installed(root.getKey(), root.getValue(), null, name, child, false));
                } else if (attrs.isDirectory()) {
                    for (Path skill : children(child)) {
                        BasicFileAttributes inner = attrs(skill);
                        if (inner == null) {
                            continue;
                        }
                        boolean link = inner.isSymbolicLink();
                        if (link || (inner.isDirectory()
                                && Files.isRegularFile(skill.resolve(SKILL_FILE), LinkOption.NOFOLLOW_LINKS))) {
                            out.add(new Installed(root.getKey(), root.getValue(), name,
                                    skill.getFileName().toString(), skill, link));
                        }
                    }
                }
            }
        }
        return out;
    }

    private static List<Path> children(Path dir) {
        if (!Files.isDirectory(dir)) {
            return List.of();
        }
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

    private static boolean exists(Path path) {
        return Files.exists(path, LinkOption.NOFOLLOW_LINKS);
    }

    /** The listing of GET import-sources. */
    Map<String, Object> sources(Path root) throws IOException {
        Path skills = root.resolve("skills");
        List<Map<String, Object>> installedRows = new ArrayList<>();
        for (Installed skill : installed()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("root", skill.root());
            row.put("pack", skill.pack());
            row.put("name", skill.name());
            row.put("description", skill.link() ? "" : description(skill.folder()));
            row.put("inPlaybook", exists(skills.resolve(skill.targetPack()).resolve(skill.name())));
            row.put("importable", !skill.link());
            if (skill.link()) {
                row.put("why", "a symbolic link; it is not imported");
            }
            installedRows.add(row);
        }
        List<Map<String, Object>> catalogueRows = new ArrayList<>();
        for (SkillCatalogue.Entry entry : SkillCatalogue.index()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", entry.id());
            row.put("pack", entry.pack());
            row.put("name", entry.name());
            row.put("description", entry.description());
            row.put("licence", entry.licence());
            row.put("inPlaybook", exists(skills.resolve(IMPORTED_PACK).resolve(entry.name())));
            catalogueRows.add(row);
        }
        List<Map<String, Object>> hookRows = new ArrayList<>();
        for (HookConfig hook : PlaybookContents.readUserHooks(userSettings)) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("event", hook.event());
            row.put("matcher", hook.matcher());
            row.put("command", shown(hook.command()));
            row.put("timeoutSeconds", hook.timeoutSeconds());
            List<Script> scripts = scripts(hook.command());
            row.put("scripts", scripts.stream().map(Script::name).toList());
            row.put("left", leftReason(withPlaceholders(hook.command(), scripts)));
            hookRows.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("installed", installedRows);
        out.put("catalogue", catalogueRows);
        out.put("hooks", hookRows);
        out.put("hooksInPlaybook", exists(root.resolve(HOOKS_FILE)));
        return out;
    }

    private static String description(Path folder) {
        try {
            Path file = folder.resolve(SKILL_FILE);
            if (Files.size(file) > PlaybookFiles.MAX_TEXT_BYTES) {
                return "";
            }
            return SkillLibrary.parse(file, folder.getFileName().toString()).description();
        } catch (IOException | RuntimeException unreadable) {
            return "";
        }
    }

    /**
     * A command as the listing shows it: the project folder written as {@code {project}} and the home
     * as {@code ~} where {@code hooks/hooks.json} writes them so, then what is left of the home folder
     * as {@code ~} too, so that no path of the machine is echoed.
     */
    private String shown(String command) {
        String out = portable(projectPlaceholder(command));
        for (Path h : spellings(home)) {
            out = out.replace(h.toString(), "~");
        }
        return out;
    }

    /** What {@code hooks/hooks.json} says when a hook is left out for naming a dot folder of the home. */
    static final String LEFT_REASON = "home-dot-folder";
    /** What it says when a path after {@code {project}} climbs above the project with {@code ..}. */
    static final String PARENT_REASON = "project-parent";
    /** What the answer names as the folder of a hook left out for {@link #PARENT_REASON}. */
    private static final String PARENT_FOLDER = PlaybookContents.PROJECT_PLACEHOLDER + "/..";
    /** Where a path in a shell word or a value may start: not inside another path or word. */
    private static final String WORD_START = HookCommands.WORD_START;
    /** Where such a path ends: a slash, the end, a space, a quote or a separator. */
    private static final String WORD_END = "(?=/|$|[\\s'\"=:;,)|&])";
    /** An absolute path where a word or a value starts, up to the next separator. */
    private static final Pattern ABSOLUTE = Pattern.compile(WORD_START + "/[^\\s'\"=:;,)|&<>]*");

    /** Why the import leaves a hook out, from its command with the placeholders written, or null. */
    private String leftReason(String placeholdered) {
        if (HookCommands.homeDotFolder(placeholdered, home) != null) {
            return LEFT_REASON;
        }
        return HookCommands.climbsAbove(placeholdered, PlaybookContents.PROJECT_PLACEHOLDER) ? PARENT_REASON : null;
    }

    /**
     * The project folder of a command written as {@code {project}} wherever it starts a path: as its
     * absolute path, its real path, and below the home as {@code ~/}, {@code $HOME/} or
     * {@code ${HOME}/} with the rest of its path. The installer puts the workspace in its place.
     */
    private String projectPlaceholder(String command) {
        List<String> spellings = new ArrayList<>();
        for (Path p : projectScopes()) {
            spellings.add(p.toString());
            for (Path h : spellings(home)) {
                if (p.startsWith(h)) {
                    String rel = h.relativize(p).toString().replace('\\', '/');
                    spellings.add("~/" + rel);
                    spellings.add("$HOME/" + rel);
                    spellings.add("${HOME}/" + rel);
                }
            }
        }
        spellings.sort(Comparator.comparingInt(String::length).reversed());
        String out = command;
        for (String spelling : spellings) {
            out = Pattern.compile(WORD_START + Pattern.quote(spelling) + WORD_END).matcher(out)
                    .replaceAll(java.util.regex.Matcher.quoteReplacement(PlaybookContents.PROJECT_PLACEHOLDER));
        }
        return projectAliases(out);
    }

    /**
     * The absolute paths of a command that reach the project through another spelling, a link to it
     * or a second name of a folder on its way, written as {@code {project}}: the longest leading part
     * of each path whose real path is the project's real path becomes the placeholder.
     */
    private String projectAliases(String command) {
        if (projectScopes().isEmpty()) {
            return command;
        }
        Path project;
        try {
            project = launchDir.toRealPath();
        } catch (IOException absent) {
            return command;
        }
        java.util.regex.Matcher m = ABSOLUTE.matcher(command);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            m.appendReplacement(out, java.util.regex.Matcher.quoteReplacement(projectAlias(m.group(), project)));
        }
        m.appendTail(out);
        return out.toString();
    }

    private static String projectAlias(String path, Path project) {
        String[] segments = path.split("/", -1);
        for (int i = segments.length; i > 1; i--) {
            String prefix = String.join("/", java.util.Arrays.copyOfRange(segments, 0, i));
            try {
                if (!prefix.isEmpty() && Path.of(prefix).toRealPath().equals(project)) {
                    return PlaybookContents.PROJECT_PLACEHOLDER + path.substring(prefix.length());
                }
            } catch (IOException | InvalidPathException notThere) {
                // a part that is not there is no alias
            }
        }
        return path;
    }

    /** The command with each script token written as {@code {hooks}/<name>} and the project as {@code {project}}. */
    private String withPlaceholders(String command, List<Script> scripts) {
        String out = command;
        for (Script script : scripts) {
            out = out.replace(script.token(), HOOKS_PLACEHOLDER + "/" + script.name());
        }
        return projectPlaceholder(out);
    }

    /**
     * A command with the home folder written as {@code ~} where it starts a shell word, which the
     * shell reads as the same folder. A home path inside quotes or after {@code =} stays as it is,
     * since the shell would not read {@code ~} there.
     */
    private String portable(String command) {
        String out = command;
        for (Path h : spellings(home)) {
            out = Pattern.compile("(^|\\s)" + Pattern.quote(h.toString()) + "(?=/|\\s|$)").matcher(out)
                    .replaceAll(m -> java.util.regex.Matcher.quoteReplacement(m.group(1) + "~"));
        }
        return out;
    }

    /**
     * The spellings of the project folder that count as a project. A launch folder that is the home
     * or holds it, the file system root included, is no project: a scope that wide would reach every
     * file of the home.
     */
    private List<Path> projectScopes() {
        List<Path> homes = spellings(home);
        return spellings(launchDir).stream()
                .filter(p -> homes.stream().noneMatch(h -> h.startsWith(p)))
                .toList();
    }

    /** The path as given and as its real path, longest first. */
    private static List<Path> spellings(Path path) {
        Set<Path> out = new LinkedHashSet<>();
        try {
            out.add(path.toRealPath());
        } catch (IOException absent) {
            // a folder that is not there has only the one spelling
        }
        out.add(path);
        return out.stream().sorted(Comparator.comparingInt((Path p) -> p.toString().length()).reversed()).toList();
    }

    // ---- importing skills ----------------------------------------------------------------------

    /** One skill to copy: where it goes, its files, and the line PROVENANCE.md gets. */
    private record Plan(String display, String pack, String name, Map<String, StagedInstall.Source> files,
                        long bytes, String provenance) {}

    PlaybookFiles.Answer importSkills(Path root, JsonNode body) throws IOException {
        JsonNode items = body == null ? null : body.get("items");
        if (items == null || !items.isArray() || items.isEmpty()) {
            return refused(400, "bad-request", "A 'dir' and a list of 'items' are required.");
        }
        synchronized (PlaybookFileWriter.class) {
            try {
                Current cur = current(root, body);
                String today = LocalDate.now().toString();
                Map<String, Plan> plans = new LinkedHashMap<>();
                for (JsonNode item : items) {
                    for (Plan plan : plan(item, cur.playbook().id(), today)) {
                        Plan earlier = plans.putIfAbsent(plan.pack() + "/" + plan.name(), plan);
                        if (earlier != null && !ContentHash.entries(bytes(earlier)).equals(ContentHash.entries(bytes(plan)))) {
                            throw new Abort(refused(409, "taken", earlier.display() + " and " + plan.display()
                                    + " both go to skills/" + plan.pack() + "/" + plan.name() + " with other content. "
                                    + "Nothing was copied; import one of them."));
                        }
                    }
                }
                List<Plan> copy = new ArrayList<>();
                List<String> already = new ArrayList<>();
                Set<String> packs = new LinkedHashSet<>();
                for (Plan plan : plans.values()) {
                    packs.add("skills/" + plan.pack());
                    if (present(root, plan)) {
                        already.add(plan.display());
                    } else {
                        copy.add(plan);
                    }
                }
                caps(root, copy.stream().mapToInt(p -> p.files().size()).sum(),
                        copy.stream().mapToLong(Plan::bytes).sum());
                String hash = write(root, cur, copy, packs);
                List<Map<String, String>> imported = new ArrayList<>();
                for (Plan plan : copy) {
                    imported.add(Map.of("name", plan.display(), "path", "skills/" + plan.pack() + "/" + plan.name()));
                }
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("imported", imported);
                out.put("already", already);
                return done(root, hash, out);
            } catch (Abort abort) {
                return abort.answer;
            }
        }
    }

    private static final PlaybookFiles.Refused UNKNOWN_SOURCE = refused(400, "unknown-source",
            "A skill is named by its source (installed or catalogue), its root, its pack and its name, as the "
                    + "list of sources shows them. This one is not on the list.");

    private List<Plan> plan(JsonNode item, String playbookId, String today) throws IOException, Abort {
        if (item == null || !item.isObject()) {
            throw new Abort(UNKNOWN_SOURCE);
        }
        String source = item.path("source").asText("");
        String pack = item.hasNonNull("pack") ? item.get("pack").asText() : null;
        String name = item.hasNonNull("name") ? item.get("name").asText() : null;
        List<Plan> out = new ArrayList<>();
        if ("installed".equals(source)) {
            String label = item.hasNonNull("root") ? item.get("root").asText() : null;
            if (label != null && !roots.containsKey(label)) {
                throw new Abort(UNKNOWN_SOURCE);
            }
            List<Installed> found = lookUp(label, pack, name);
            if (found.isEmpty()) {
                throw new Abort(UNKNOWN_SOURCE);
            }
            for (Installed skill : found) {
                out.add(installedPlan(skill, playbookId, today));
            }
        } else if ("catalogue".equals(source)) {
            if (pack == null || name == null) {
                throw new Abort(UNKNOWN_SOURCE);
            }
            Optional<SkillCatalogue.Entry> entry = SkillCatalogue.find(pack + "/" + name);
            if (entry.isEmpty()) {
                throw new Abort(UNKNOWN_SOURCE);
            }
            out.add(cataloguePlan(entry.get(), playbookId, today));
        } else {
            throw new Abort(UNKNOWN_SOURCE);
        }
        return out;
    }

    /**
     * The installed skills an item names, by string equality against the enumeration. Without a
     * label, the project root is asked before the user root, as the skill library ranks them. A pack
     * without a name is the whole pack.
     */
    private List<Installed> lookUp(String label, String pack, String name) {
        List<Installed> all = installed();
        for (String root : label == null ? ROOT_LABELS : List.of(label)) {
            List<Installed> found = all.stream()
                    .filter(s -> s.root().equals(root))
                    .filter(s -> java.util.Objects.equals(s.pack(), pack))
                    .filter(s -> name == null ? pack != null : s.name().equals(name))
                    .toList();
            if (!found.isEmpty()) {
                return found;
            }
        }
        return List.of();
    }

    private Plan installedPlan(Installed skill, String playbookId, String today) throws IOException, Abort {
        targetNames(skill.targetPack(), skill.name(), playbookId);
        SafeWalk.Walk walk = SafeWalk.walk(skill.rootPath(), skill.folder());
        if (!walk.refused().isEmpty()) {
            throw new Abort(linkRefusal(skill.display()));
        }
        Map<String, StagedInstall.Source> files = new LinkedHashMap<>();
        long bytes = 0;
        for (String rel : walk.files()) {
            if (skipped(rel)) {
                continue;
            }
            Path file = skill.folder().resolve(rel);
            files.put(rel, () -> Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS));
            bytes += Files.size(file);
        }
        if (skill.pack() != null && !files.containsKey(LICENCE)) {
            Path packLicence = skill.rootPath().resolve(skill.pack()).resolve(LICENCE);
            BasicFileAttributes attrs = attrs(packLicence);
            if (attrs != null && attrs.isRegularFile()) {
                files.put(LICENCE, () -> Files.newInputStream(packLicence, LinkOption.NOFOLLOW_LINKS));
                bytes += attrs.size();
            }
        }
        named(skill.display(), skill.name(), files);
        String line = "- skills/" + skill.targetPack() + "/" + skill.name() + ": imported on " + today
                + " from the installed skill " + skill.display() + " (" + skill.root() + " root).";
        return new Plan(skill.display(), skill.targetPack(), skill.name(), files, bytes, line);
    }

    private Plan cataloguePlan(SkillCatalogue.Entry entry, String playbookId, String today) throws IOException, Abort {
        targetNames(IMPORTED_PACK, entry.name(), playbookId);
        Map<String, StagedInstall.Source> files = new LinkedHashMap<>();
        long bytes = 0;
        for (SkillCatalogue.ShelfFile file : SkillCatalogue.files(entry)) {
            if (skipped(file.rel())) {
                continue;
            }
            files.put(file.rel(), file.source());
            bytes += file.bytes();
        }
        Optional<SkillCatalogue.ShelfFile> licence = SkillCatalogue.licence(entry.pack());
        if (licence.isPresent()) {
            String free = files.containsKey(LICENCE) ? LICENCE + "." + entry.pack() : LICENCE;
            files.put(free, licence.get().source());
            bytes += licence.get().bytes();
        }
        named(entry.id(), entry.name(), files);
        String line = "- skills/" + IMPORTED_PACK + "/" + entry.name() + ": imported on " + today
                + " from the catalogue skill " + entry.id() + ", licence " + entry.licence() + ", "
                + entry.repo() + " at " + entry.commit() + ".";
        return new Plan(entry.id(), IMPORTED_PACK, entry.name(), files, bytes, line);
    }

    /** The pack and the skill folder keep the segment rule, and the pack is not named like the playbook. */
    private static void targetNames(String pack, String name, String playbookId) throws Abort {
        if (!PlaybookValidator.PATH_SEGMENT.matcher(pack).matches()
                || !PlaybookValidator.PATH_SEGMENT.matcher(name).matches()) {
            throw new Abort(refused(400, "name", "The skill " + name + " or its pack " + pack + " has a name a "
                    + "playbook folder does not take: it starts with a letter or a digit and holds only letters, "
                    + "digits, '_' and '-'."));
        }
        if (pack.equals(playbookId)) {
            throw new Abort(refused(400, "pack-is-playbook-id", "The pack " + pack + " has the name of the "
                    + "playbook, which the playbook's commands use when they are installed. Rename the pack first."));
        }
    }

    /** The skill's own name in SKILL.md equals its folder, as the install preview requires. */
    private static void named(String display, String folder, Map<String, StagedInstall.Source> files)
            throws IOException, Abort {
        StagedInstall.Source skillFile = files.get(SKILL_FILE);
        if (skillFile == null) {
            throw new Abort(refused(400, "not-a-skill", display + " holds no SKILL.md."));
        }
        String raw;
        try (InputStream in = skillFile.open()) {
            raw = new String(in.readNBytes((int) PlaybookFiles.MAX_TEXT_BYTES + 1), StandardCharsets.UTF_8);
        }
        Skill parsed = SkillLibrary.parse(raw, folder, Path.of(SKILL_FILE));
        if (!parsed.name().equals(folder)) {
            throw new Abort(refused(400, "name", "The SKILL.md of " + display + " names the skill " + parsed.name()
                    + " while its folder is " + folder + "; the playbook would show one name and the agent another."));
        }
    }

    private static PlaybookFiles.Refused linkRefusal(String display) {
        return refused(400, "link", "The skill " + display + " is or holds a symbolic link, or a file that is not "
                + "regular. It is not imported, not even in part.");
    }

    private static boolean skipped(String rel) {
        return SKIPPED.contains(rel.substring(rel.lastIndexOf('/') + 1));
    }

    /**
     * Whether the target already holds exactly the planned files. A target with other content is a
     * 409; a link on the way to it is refused.
     */
    private static boolean present(Path root, Plan plan) throws IOException, Abort {
        Path skills = root.resolve("skills");
        Path pack = skills.resolve(plan.pack());
        Path target = pack.resolve(plan.name());
        for (Path step : List.of(skills, pack, target)) {
            BasicFileAttributes attrs = attrs(step);
            if (attrs == null) {
                return false;
            }
            if (attrs.isSymbolicLink()) {
                throw new Abort(refused(400, "link", "skills/" + plan.pack() + "/" + plan.name()
                        + " passes a symbolic link in the playbook folder; nothing was copied."));
            }
            if (!attrs.isDirectory()) {
                throw new Abort(taken(plan));
            }
        }
        SafeWalk.Walk there = SafeWalk.walk(root, target);
        if (!there.refused().isEmpty()) {
            throw new Abort(taken(plan));
        }
        Map<String, byte[]> planned = bytes(plan);
        if (there.files().size() == planned.size() && ContentHash.tree(there).equals(ContentHash.entries(planned))) {
            return true;
        }
        throw new Abort(taken(plan));
    }

    /** The planned files of a skill with their bytes. */
    private static Map<String, byte[]> bytes(Plan plan) throws IOException {
        Map<String, byte[]> planned = new LinkedHashMap<>();
        for (Map.Entry<String, StagedInstall.Source> file : plan.files().entrySet()) {
            try (InputStream in = file.getValue().open()) {
                planned.put(file.getKey(), in.readAllBytes());
            }
        }
        return planned;
    }

    private static PlaybookFiles.Refused taken(Plan plan) {
        return refused(409, "taken", "skills/" + plan.pack() + "/" + plan.name() + " already exists in the playbook "
                + "with other content. Nothing was copied; remove it first or import under another name.");
    }

    /** The loader's caps over the folder as it would be: files to its depth plus every new file, and the bytes. */
    private static void caps(Path root, int newFiles, long newBytes) throws IOException, Abort {
        SafeWalk.Tree tree = SafeWalk.tree(root, PlaybookLoader.WALK_DEPTH, PlaybookLoader.MAX_FILES);
        if (tree.capped() || tree.files() + newFiles > PlaybookLoader.MAX_FILES) {
            throw new Abort(refused(413, "too-many-files", "The playbook folder would hold more than "
                    + PlaybookLoader.MAX_FILES + " files. Nothing was copied."));
        }
        if (tree.bytes() + newBytes > PlaybookFiles.MAX_FOLDER_BYTES) {
            throw new Abort(refused(413, "folder-too-large",
                    "The playbook folder would hold more than 24 MB. Nothing was copied."));
        }
    }

    /**
     * Copies every planned skill through a staging folder and one move each, appends the provenance
     * lines, then writes {@code playbook.json}. A failure takes back everything written before it.
     */
    private String write(Path root, Current cur, List<Plan> copy, Set<String> packs) throws IOException, Abort {
        StringBuilder lines = new StringBuilder();
        copy.forEach(p -> lines.append(p.provenance()).append('\n'));
        return commit(root, cur, copy, List.of(), lines.toString(), c -> {
            Playbook.Contents out = c;
            for (String pack : packs) {
                out = with(out, "skills", pack, true);
            }
            return out;
        });
    }

    /** One text file a route writes: its path, its text, the hash it replaces ({@code ""} for a new file) and the old text. */
    private record TextWrite(String rel, String text, String base, String old) {}

    /**
     * Copies the planned skills through a staging folder and one move each, writes the text files
     * through the file route, appends {@code provenance} to PROVENANCE.md, then writes
     * {@code playbook.json} with {@code change}. A failure takes back everything written before it:
     * the text files, the moved skills and the folders the route created.
     */
    private String commit(Path root, Current cur, List<Plan> copy, List<TextWrite> texts, String provenance,
                          UnaryOperator<Playbook.Contents> change) throws IOException, Abort {
        Path staging = root.resolve(STAGING);
        deleteTree(staging);
        List<Path> created = new ArrayList<>();
        List<Path> moved = new ArrayList<>();
        List<Undo> undo = new ArrayList<>();
        boolean finished = false;
        try {
            for (Plan plan : copy) {
                List<StagedInstall.FileCopy> files = new ArrayList<>();
                plan.files().forEach((rel, source) -> files.add(new StagedInstall.FileCopy(rel, source)));
                Path staged = StagedInstall.build(staging, plan.name(), files);
                Path target = root.resolve("skills").resolve(plan.pack()).resolve(plan.name());
                folder(root.resolve("skills"), created);
                folder(target.getParent(), created);
                if (StagedInstall.promote(staged, target) == StagedInstall.Outcome.TAKEN) {
                    throw new Abort(taken(plan));
                }
                moved.add(target);
            }
            Set<String> tops = new LinkedHashSet<>();
            for (TextWrite t : texts) {
                if (t.rel().contains("/")) {
                    tops.add(t.rel().substring(0, t.rel().indexOf('/')));
                }
            }
            for (String top : tops) {
                undo.add(folderBack(root, top));
            }
            for (TextWrite t : texts) {
                undo.add(replace(root, t.rel(), t.text(), t.base(), t.old()));
            }
            if (!provenance.isEmpty()) {
                undo.add(append(root, PlaybookInstaller.PROVENANCE_FILE, provenance));
            }
            midway.run();
            String hash = writeContents(root, cur, change);
            finished = true;
            return hash;
        } finally {
            deleteTree(staging);
            if (!finished) {
                for (int i = undo.size() - 1; i >= 0; i--) {
                    undo.get(i).run();
                }
                for (int i = moved.size() - 1; i >= 0; i--) {
                    deleteTree(moved.get(i));
                }
                for (int i = created.size() - 1; i >= 0; i--) {
                    Files.deleteIfExists(created.get(i));
                }
            }
        }
    }

    /** Creates a folder of the playbook when it is missing; a link or a file in its place is refused. */
    private static void folder(Path dir, List<Path> created) throws IOException, Abort {
        if (!plainFolder(dir, created)) {
            throw new Abort(refused(400, "link", "A symbolic link or a file stands where the playbook needs a folder."));
        }
    }

    /**
     * Creates {@code dir} when it is missing and adds it to {@code created}. False when something
     * other than a folder stands there; the attributes are read without following a link, so a link
     * is no folder. {@link #present} refuses a link on the way first; this check holds when one
     * appears after it.
     */
    static boolean plainFolder(Path dir, List<Path> created) throws IOException {
        BasicFileAttributes attrs = attrs(dir);
        if (attrs == null) {
            Files.createDirectory(dir);
            created.add(dir);
            return true;
        }
        return attrs.isDirectory();
    }

    /** Takes back a folder of the playbook that a route creates, once it is empty again. */
    private static Undo folderBack(Path root, String rel) {
        Path folder = root.resolve(rel);
        boolean there = exists(folder);
        return () -> {
            if (!there && Files.isDirectory(folder, LinkOption.NOFOLLOW_LINKS) && children(folder).isEmpty()) {
                Files.delete(folder);
            }
        };
    }

    /** Takes a write back. */
    @FunctionalInterface
    private interface Undo {
        void run() throws IOException;
    }

    /** Appends {@code text} to a text file of the playbook through the file route; answers how to take it back. */
    private static Undo append(Path root, String rel, String text) throws IOException, Abort {
        PlaybookFiles.Answer read = PlaybookFiles.read(root, rel);
        String old;
        String base;
        if (read instanceof PlaybookFiles.Done done) {
            PlaybookFiles.TextFile file = (PlaybookFiles.TextFile) done.body();
            old = file.text();
            base = file.sha256();
        } else if (exists(root.resolve(rel))) {
            throw new Abort(refused(400, "link", rel + " is not a text file the playbook can append to."));
        } else {
            old = null;
            base = "";
        }
        String now = old == null ? "# Provenance\n\n" + text
                : old + (old.isEmpty() || old.endsWith("\n") ? "" : "\n") + text;
        return replace(root, rel, now, base, old);
    }

    /** Writes a text file through the file route; answers how to put the old text back or remove the new file. */
    private static Undo replace(Path root, String rel, String text, String base, String old) throws IOException, Abort {
        PlaybookFiles.Answer written = PlaybookFiles.write(root, rel, text, base);
        if (written instanceof PlaybookFiles.Hidden) {
            throw new Abort(refused(400, "link", rel + " passes a symbolic link or a file where the playbook needs "
                    + "a folder. Nothing was written."));
        }
        if (!(written instanceof PlaybookFiles.Done done)) {
            throw new Abort(written);
        }
        String now = ((PlaybookFiles.Saved) done.body()).sha256();
        return () -> {
            if (old == null) {
                PlaybookFiles.delete(root, rel);
            } else {
                PlaybookFiles.write(root, rel, old, now);
            }
        };
    }

    // ---- importing hooks -----------------------------------------------------------------------

    /** A script a hook command names: the text as written, the file, and its name in {@code hooks/}. */
    private record Script(String token, Path file, String name) {}

    /**
     * The scripts a command names: a token that is an absolute path or starts with {@code ~/}, names
     * a regular file (read without following a link, so a link is none), whose own name does not start with a dot and has a script
     * ending, and whose real path lies under the home and outside the project folder. A file of the
     * project stays there and is written {@code {project}} (card 538). A real path under the home
     * passes no dot folder other than the spectro home. The project is no scope when it is the home or
     * holds it.
     */
    private List<Script> scripts(String command) {
        List<Script> out = new ArrayList<>();
        if (command == null) {
            return out;
        }
        for (String raw : command.trim().split("\\s+")) {
            String token = raw.replaceAll("^['\"]|['\";]$", "").replaceAll("['\"]$", "");
            Path file;
            try {
                if (token.startsWith("~/")) {
                    file = home.resolve(token.substring(2)).normalize();
                } else if (token.startsWith("/")) {
                    file = Path.of(token).normalize();
                } else {
                    continue;
                }
            } catch (InvalidPathException notAPath) {
                continue;
            }
            Script script = script(token, file);
            if (script != null && out.stream().noneMatch(s -> s.token().equals(token))) {
                out.add(script);
            }
        }
        return out;
    }

    private Script script(String token, Path file) {
        BasicFileAttributes attrs = attrs(file);
        String name = file.getFileName() == null ? "" : file.getFileName().toString();
        if (attrs == null || !attrs.isRegularFile() || name.startsWith(".")
                || !SCRIPT_NAME.matcher(name).matches()) {
            return null;
        }
        Path real;
        try {
            real = file.toRealPath();
        } catch (IOException unreadable) {
            return null;
        }
        boolean inProject = projectScopes().stream().anyMatch(p -> real.startsWith(p) && !real.equals(p));
        Path underHome = spellings(home).stream().filter(h -> real.startsWith(h) && !real.equals(h))
                .findFirst().orElse(null);
        if (inProject || underHome == null) {
            return null;
        }
        if (underHome != null) {
            Path rel = underHome.relativize(real);
            for (int i = 0; i < rel.getNameCount() - 1; i++) {
                String segment = rel.getName(i).toString();
                if (segment.startsWith(".") && !segment.equals(scriptDotFolder)) {
                    return null;
                }
            }
        }
        return new Script(token, file, name);
    }

    PlaybookFiles.Answer importHooks(Path root, JsonNode body) throws IOException {
        boolean replace = body != null && body.path("replace").asBoolean(false);
        synchronized (PlaybookFileWriter.class) {
            try {
                Current cur = current(root, body);
                List<HookConfig> hooks = PlaybookContents.readUserHooks(userSettings);
                if (hooks.isEmpty()) {
                    return refused(400, "no-hooks", "The user settings hold no hooks to import.");
                }
                Existing hooksFile = existing(root, HOOKS_FILE);
                if (hooksFile.text() != null && !replace) {
                    return refused(409, "exists", "The playbook has a hooks/hooks.json already. Import again with "
                            + "replace to write over it.");
                }
                Map<String, String> copies = new LinkedHashMap<>();
                ArrayNode entries = JSON.createArrayNode();
                List<Map<String, Object>> left = new ArrayList<>();
                for (HookConfig hook : hooks) {
                    String command = hook.command();
                    List<Script> scripts = scripts(command);
                    String placeholdered = withPlaceholders(command, scripts);
                    String dotFolder = HookCommands.homeDotFolder(placeholdered, home);
                    String reason = leftReason(placeholdered);
                    if (reason != null) {
                        Map<String, Object> out = new LinkedHashMap<>();
                        out.put("event", hook.event());
                        out.put("matcher", hook.matcher());
                        out.put("folder", dotFolder != null ? dotFolder : PARENT_FOLDER);
                        out.put("reason", reason);
                        left.add(out);
                        continue;
                    }
                    for (Script script : scripts) {
                        if (!PlaybookFiles.nameOk("hooks/" + script.name())) {
                            return refused(409, "script-name", "The hook script " + script.name() + " has a name "
                                    + "the playbook folder does not take: it starts with a letter or a digit and "
                                    + "holds only letters, digits, '_' and '-', with extensions after a dot. Rename "
                                    + "it first.");
                        }
                        byte[] bytes = Files.size(script.file()) > PlaybookFiles.MAX_TEXT_BYTES ? null
                                : Files.readAllBytes(script.file());
                        String text = bytes == null ? null : PlaybookFiles.textOf(bytes);
                        if (text == null) {
                            return refused(415, "script-not-text", "The hook script " + script.name()
                                    + " is not UTF-8 text of at most 1 MB, so it is not copied.");
                        }
                        String earlier = copies.putIfAbsent(script.name(), text);
                        if (earlier != null && !earlier.equals(text)) {
                            return refused(409, "script-name", "Two different hook scripts are both named "
                                    + script.name() + ". Rename one of them first.");
                        }
                    }
                    ObjectNode entry = entries.addObject();
                    entry.put("event", hook.event());
                    if (hook.matcher() != null) {
                        entry.put("matcher", hook.matcher());
                    }
                    entry.put("command", portable(withPlaceholders(command, scripts)));
                    if (hook.timeoutSeconds() != null) {
                        entry.put("timeoutSeconds", hook.timeoutSeconds());
                    }
                }
                if (entries.isEmpty()) {
                    return new PlaybookFiles.Refused(400, "all-left-out", "Every hook in the user settings names a "
                            + "hidden file or folder of the home or a path that leaves " + PlaybookContents.PROJECT_PLACEHOLDER
                            + " with '..' ("
                            + String.join(", ", left.stream().map(l -> (String) l.get("folder")).distinct().toList())
                            + "), so no hook was written.", null, Map.of("left", left));
                }
                Map<String, Existing> scriptsThere = new LinkedHashMap<>();
                for (Map.Entry<String, String> copy : copies.entrySet()) {
                    Existing there = existing(root, "hooks/" + copy.getKey());
                    if (there.text() != null && !there.text().equals(copy.getValue()) && !replace) {
                        return refused(409, "exists", "The playbook has another hooks/" + copy.getKey()
                                + " already. Import again with replace to write over it.");
                    }
                    scriptsThere.put(copy.getKey(), there);
                }
                List<Undo> undo = new ArrayList<>();
                undo.add(folderBack(root, "hooks"));
                boolean finished = false;
                try {
                    for (Map.Entry<String, String> copy : copies.entrySet()) {
                        Existing there = scriptsThere.get(copy.getKey());
                        if (!copy.getValue().equals(there.text())) {
                            undo.add(replace(root, "hooks/" + copy.getKey(), copy.getValue(), there.hash(), there.text()));
                        }
                    }
                    String json = JSON.writerWithDefaultPrettyPrinter().writeValueAsString(entries) + "\n";
                    undo.add(replace(root, HOOKS_FILE, json, hooksFile.hash(), hooksFile.text()));
                    midway.run();
                    String hash = writeContents(root, cur, c -> with(c, "hooks", HOOKS_FILE, true));
                    finished = true;
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("hooks", entries.size());
                    out.put("scripts", List.copyOf(copies.keySet()));
                    out.put("left", left);
                    return done(root, hash, out);
                } finally {
                    if (!finished) {
                        for (int i = undo.size() - 1; i >= 0; i--) {
                            undo.get(i).run();
                        }
                    }
                }
            } catch (Abort abort) {
                return abort.answer;
            }
        }
    }

    /** A text file of the playbook as it is: its text and hash, or null and {@code ""} when it is absent. */
    private record Existing(String text, String hash) {}

    private static Existing existing(Path root, String rel) throws IOException, Abort {
        PlaybookFiles.Answer read = PlaybookFiles.read(root, rel);
        if (read instanceof PlaybookFiles.Done done) {
            PlaybookFiles.TextFile file = (PlaybookFiles.TextFile) done.body();
            return new Existing(file.text(), file.sha256());
        }
        if (read instanceof PlaybookFiles.Refused || exists(root.resolve(rel))) {
            throw new Abort(refused(400, "link", rel + " is a link, a folder or not text, so it is not written over."));
        }
        return new Existing(null, "");
    }

    // ---- agents and commands -------------------------------------------------------------------

    PlaybookFiles.Answer newAgent(Path root, JsonNode body) throws IOException {
        String name = body == null ? "" : body.path("name").asText("");
        String type = body == null ? "" : body.path("type").asText("");
        String skill = body != null && body.hasNonNull("skill") ? body.get("skill").asText().strip() : "";
        String description = body != null && body.hasNonNull("description") ? body.get("description").asText().strip() : "";
        if (!PlaybookValidator.PATH_SEGMENT.matcher(name).matches()) {
            return badName("agent");
        }
        if (!AgentFile.TYPES.contains(type)) {
            return refused(400, "type", "An agent's type is explore, worker or research.");
        }
        if (!skill.isEmpty() && !SKILL_TOKEN.matcher(skill).matches()) {
            return refused(400, "skill", "A skill is named by one token such as pack:name.");
        }
        if (description.contains("\n") || description.contains("\r")) {
            return refused(400, "description", "The description is one line.");
        }
        StringBuilder text = new StringBuilder("---\n")
                .append("name: ").append(name).append('\n')
                .append("description: ").append(description.isEmpty()
                        ? "A " + type + " agent. Replace this line with what it does, in one sentence." : description)
                .append('\n')
                .append("type: ").append(type).append('\n');
        if (!skill.isEmpty()) {
            text.append("skill: ").append(skill).append('\n');
        }
        text.append("---\n\nWrite the preamble of this agent here: what it reads first, what it does, and what it "
                + "hands back.\n");
        return created(root, body, "agents", "agents/" + name + ".md", text.toString());
    }

    PlaybookFiles.Answer newCommand(Path root, JsonNode body) throws IOException {
        String name = body == null ? "" : body.path("name").asText("");
        if (!PlaybookValidator.PATH_SEGMENT.matcher(name).matches()) {
            return badName("command");
        }
        String text = "---\ndescription: Replace this line with what the command does, in one sentence.\n---\n\n"
                + "Write the prompt of this command here.\n";
        return created(root, body, "commands", "commands/" + name + ".md", text);
    }

    private static PlaybookFiles.Refused badName(String what) {
        return refused(409, "name", "A " + what + " name starts with a letter or a digit and holds only letters, "
                + "digits, '_' and '-'.");
    }

    /** Writes a new file from a template and lists it; a name that exists answers 409. */
    private PlaybookFiles.Answer created(Path root, JsonNode body, String kind, String rel, String text)
            throws IOException {
        synchronized (PlaybookFileWriter.class) {
            try {
                Current cur = current(root, body);
                if (listed(cur.playbook().contents(), kind).contains(rel) || exists(root.resolve(rel))) {
                    return refused(409, "exists", rel + " exists already.");
                }
                Undo folder = folderBack(root, kind);
                Undo undo = replace(root, rel, text, "", null);
                boolean finished = false;
                try {
                    midway.run();
                    String hash = writeContents(root, cur, c -> with(c, kind, rel, true));
                    finished = true;
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("path", rel);
                    return done(root, hash, out);
                } finally {
                    if (!finished) {
                        undo.run();
                        folder.run();
                    }
                }
            } catch (Abort abort) {
                return abort.answer;
            }
        }
    }

    // ---- importing a plugin (card 526) ---------------------------------------------------------

    /** The listing of GET plugin-sources: every Claude Code plugin of the home, by label. */
    Map<String, Object> pluginSources() {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (PluginSources.Found found : plugins.list()) {
            rows.add(plugins.row(found));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("plugins", rows);
        return out;
    }

    private static final PlaybookFiles.Refused PLUGIN_REQUEST = refused(400, "bad-request", "A 'dir', a 'plugin' "
            + "with its marketplace, name and version as the list of plugins shows them, and a list of 'kinds' are "
            + "required.");

    /**
     * Copies the chosen kinds of one Claude Code plugin into the playbook folder: skills as one pack
     * named like the plugin, agents with the four fields a playbook agent has, commands as prompt
     * files, pre and post tool use hooks with the scripts they run. The plugin's licence goes beside
     * each skill and, for the other kinds, to {@code LICENSE.<plugin>} at the root; an unlicensed
     * plugin copies nothing. PROVENANCE.md gets one line per kind that was copied, and
     * {@code playbook.json} lists every entry. The plugin is found by its labels only; one that is
     * not listed is hidden.
     */
    PlaybookFiles.Answer importPlugin(Path root, JsonNode body) throws IOException {
        JsonNode plugin = body == null ? null : body.get("plugin");
        JsonNode kindList = body == null ? null : body.get("kinds");
        if (plugin == null || !plugin.isObject() || kindList == null || !kindList.isArray() || kindList.isEmpty()
                || !plugin.path("marketplace").isTextual() || !plugin.path("name").isTextual()
                || !plugin.path("version").isTextual()) {
            return PLUGIN_REQUEST;
        }
        Set<String> kinds = new LinkedHashSet<>();
        for (JsonNode kind : kindList) {
            if (!kind.isTextual() || !PluginSources.KINDS.contains(kind.asText())) {
                return refused(400, "kind", "A plugin import takes the kinds skills, agents, commands and hooks.");
            }
            kinds.add(kind.asText());
        }
        String label = plugin.hasNonNull("root") ? plugin.get("root").asText() : null;
        Optional<PluginSources.Found> found = plugins.find(label, plugin.get("marketplace").asText(),
                plugin.get("name").asText(), plugin.get("version").asText());
        if (found.isEmpty()) {
            return new PlaybookFiles.Hidden();
        }
        PluginSources.Found from = found.get();
        if (!PlaybookValidator.PATH_SEGMENT.matcher(from.name()).matches()) {
            return refused(400, "name", "The plugin " + from.name() + " has a name a playbook folder does not take: it "
                    + "starts with a letter or a digit and holds only letters, digits, '_' and '-'.");
        }
        synchronized (PlaybookFileWriter.class) {
            try {
                PluginSources.Parts parts;
                try {
                    parts = plugins.read(from, kinds);
                } catch (PluginSources.Refusal refusal) {
                    return refusal.answer();
                }
                Current cur = current(root, body);
                String name = from.name();

                List<Plan> skillPlans = new ArrayList<>();
                List<String> targets = new ArrayList<>();
                for (PluginSources.Skill skill : parts.skills()) {
                    targetNames(name, skill.name(), cur.playbook().id());
                    Map<String, StagedInstall.Source> files = new LinkedHashMap<>();
                    long bytes = 0;
                    for (Map.Entry<String, byte[]> file : skill.files().entrySet()) {
                        byte[] content = file.getValue();
                        files.put(file.getKey(), () -> new ByteArrayInputStream(content));
                        bytes += content.length;
                    }
                    byte[] licence = parts.licence();
                    files.put(files.containsKey(LICENCE) ? LICENCE + "." + name : LICENCE,
                            () -> new ByteArrayInputStream(licence));
                    bytes += licence.length;
                    String display = name + SkillLibrary.NAMESPACE_SEPARATOR + skill.name();
                    named(display, skill.name(), files);
                    skillPlans.add(new Plan(display, name, skill.name(), files, bytes, null));
                    files.keySet().forEach(rel -> targets.add("skills/" + name + "/" + skill.name() + "/" + rel));
                }
                depth(targets);

                List<Plan> copy = new ArrayList<>();
                List<String> already = new ArrayList<>();
                List<String> importedSkills = new ArrayList<>();
                for (Plan plan : skillPlans) {
                    String path = "skills/" + plan.pack() + "/" + plan.name();
                    if (present(root, plan)) {
                        already.add(path);
                    } else {
                        copy.add(plan);
                        importedSkills.add(path);
                    }
                }

                List<TextWrite> texts = new ArrayList<>();
                List<String> importedAgents = new ArrayList<>();
                List<String> importedCommands = new ArrayList<>();
                for (PluginSources.Text agent : parts.agents()) {
                    (planText(root, agent, texts) ? importedAgents : already).add(agent.path());
                }
                for (PluginSources.Text command : parts.commands()) {
                    (planText(root, command, texts) ? importedCommands : already).add(command.path());
                }
                List<String> importedHooks = new ArrayList<>();
                boolean hooksListed = !parts.hooks().isEmpty();
                if (hooksListed) {
                    for (PluginSources.Text script : parts.scripts()) {
                        if (planText(root, script, texts)) {
                            importedHooks.add(script.path());
                        }
                    }
                    if (mergeHooks(root, parts.hooks(), texts)) {
                        importedHooks.add(0, HOOKS_FILE);
                    }
                }
                if (!parts.agents().isEmpty() || !parts.commands().isEmpty() || hooksListed) {
                    String licence = PlaybookFiles.textOf(parts.licence());
                    if (licence == null) {
                        throw new Abort(refused(415, "plugin-file", "The plugin's licence is not UTF-8 text, so it cannot "
                                + "travel beside its agents, commands and hooks. Nothing was copied."));
                    }
                    planText(root, new PluginSources.Text(LICENCE + "." + name, licence), texts);
                }
                depth(texts.stream().map(TextWrite::rel).toList());

                int newFiles = copy.stream().mapToInt(p -> p.files().size()).sum()
                        + (int) texts.stream().filter(t -> t.old() == null).count()
                        + (exists(root.resolve(PlaybookInstaller.PROVENANCE_FILE)) ? 0 : 1);
                long newBytes = copy.stream().mapToLong(Plan::bytes).sum()
                        + texts.stream().mapToLong(t -> t.text().getBytes(StandardCharsets.UTF_8).length).sum();
                caps(root, newFiles, newBytes);

                String origin = ": imported on " + LocalDate.now() + " from the plugin "
                        + (from.version().isEmpty() ? name : name + " " + from.version()) + " of the marketplace "
                        + from.marketplace() + " (" + from.where() + ").\n";
                StringBuilder provenance = new StringBuilder();
                if (!importedSkills.isEmpty()) {
                    provenance.append("- skills/").append(name).append(origin);
                }
                for (List<String> kind : List.of(importedAgents, importedCommands, importedHooks)) {
                    if (!kind.isEmpty()) {
                        provenance.append("- ").append(String.join(", ", kind)).append(origin);
                    }
                }

                String hash = commit(root, cur, copy, texts, provenance.toString(), c -> {
                    Playbook.Contents out = c;
                    if (!skillPlans.isEmpty()) {
                        out = with(out, "skills", "skills/" + name, true);
                    }
                    for (PluginSources.Text agent : parts.agents()) {
                        out = with(out, "agents", agent.path(), true);
                    }
                    for (PluginSources.Text command : parts.commands()) {
                        out = with(out, "commands", command.path(), true);
                    }
                    if (hooksListed) {
                        out = with(out, "hooks", HOOKS_FILE, true);
                    }
                    return out;
                });
                Map<String, Object> imported = new LinkedHashMap<>();
                imported.put("skills", importedSkills);
                imported.put("agents", importedAgents);
                imported.put("commands", importedCommands);
                imported.put("hooks", importedHooks.contains(HOOKS_FILE) ? List.of(HOOKS_FILE) : List.of());
                imported.put("scripts", importedHooks.stream().filter(p -> !p.equals(HOOKS_FILE)).toList());
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("imported", imported);
                out.put("already", already);
                out.put("dropped", parts.dropped());
                out.put("droppedHooks", parts.droppedHooks());
                out.put("notCopied", parts.notCopied());
                return done(root, hash, out);
            } catch (Abort abort) {
                return abort.answer;
            }
        }
    }

    /** Every path a route would write lies within the levels the playbook loader reads. */
    private static void depth(List<String> paths) throws Abort {
        for (String path : paths) {
            if (path.split("/").length > PlaybookLoader.WALK_DEPTH) {
                throw new Abort(refused(400, "too-deep", path + " would lie deeper than the " + PlaybookLoader.WALK_DEPTH
                        + " levels the playbook loader reads. Nothing was copied."));
            }
        }
    }

    /**
     * Plans one text file of a plugin import: true when it is new, false when the playbook holds
     * the same text already. Other text at the path answers 409 {@code exists}; a link on the way
     * is refused.
     */
    private static boolean planText(Path root, PluginSources.Text text, List<TextWrite> texts)
            throws IOException, Abort {
        Path at = root;
        for (String segment : text.path().split("/")) {
            at = at.resolve(segment);
            BasicFileAttributes attrs = attrs(at);
            if (attrs != null && attrs.isSymbolicLink()) {
                throw new Abort(refused(400, "link", text.path() + " passes a symbolic link in the playbook folder. "
                        + "Nothing was copied."));
            }
        }
        Existing there = existing(root, text.path());
        if (there.text() == null) {
            texts.add(new TextWrite(text.path(), text.text(), "", null));
            return true;
        }
        if (there.text().equals(text.text())) {
            return false;
        }
        throw new Abort(refused(409, "exists", text.path() + " already exists in the playbook with other content. "
                + "Nothing was copied; remove it first."));
    }

    /**
     * Adds the plugin's hook entries to {@code hooks/hooks.json}, after the entries it holds and
     * without one that is there already. True when the file changes.
     */
    private static boolean mergeHooks(Path root, List<PluginSources.Hook> hooks, List<TextWrite> texts)
            throws IOException, Abort {
        Existing there = existing(root, HOOKS_FILE);
        ArrayNode entries = JSON.createArrayNode();
        if (there.text() != null) {
            JsonNode parsed;
            try {
                parsed = JSON.readTree(there.text());
            } catch (IOException notJson) {
                parsed = null;
            }
            if (parsed == null || !parsed.isArray()) {
                throw new Abort(refused(400, "hooks-unreadable", "The playbook's hooks/hooks.json is not a list of "
                        + "hook entries, so the plugin's hooks are not added to it. Nothing was copied."));
            }
            entries.addAll((ArrayNode) parsed);
        }
        int before = entries.size();
        for (PluginSources.Hook hook : hooks) {
            ObjectNode entry = JSON.createObjectNode();
            entry.put("event", hook.event());
            if (hook.matcher() != null) {
                entry.put("matcher", hook.matcher());
            }
            entry.put("command", hook.command());
            if (hook.timeoutSeconds() != null) {
                entry.put("timeoutSeconds", hook.timeoutSeconds());
            }
            boolean listed = false;
            for (JsonNode e : entries) {
                listed |= e.equals(entry);
            }
            if (!listed) {
                entries.add(entry);
            }
        }
        if (entries.size() == before) {
            return false;
        }
        String json = JSON.writerWithDefaultPrettyPrinter().writeValueAsString(entries) + "\n";
        texts.add(new TextWrite(HOOKS_FILE, json, there.hash(), there.text()));
        return true;
    }

    // ---- removing an entry ---------------------------------------------------------------------

    PlaybookFiles.Answer removeContent(Path root, JsonNode body) throws IOException {
        String kind = body == null ? "" : body.path("kind").asText("");
        String path = body == null ? "" : body.path("path").asText("");
        Pattern shape = SHAPES.get(kind);
        if (shape == null) {
            return refused(400, "kind", "The kind is skills, agents, hooks, commands or workflows.");
        }
        List<String> segments = PlaybookFiles.segments(path);
        if (segments == null || !shape.matcher(path).matches()) {
            return refused(400, "path", "The path is not one of the " + kind + " entries a playbook carries.");
        }
        synchronized (PlaybookFileWriter.class) {
            try {
                Current cur = current(root, body);
                if (!listed(cur.playbook().contents(), kind).contains(path)) {
                    return refused(400, "not-listed", path + " is not listed in contents." + kind + ".");
                }
                Path at = root;
                for (String segment : segments) {
                    at = at.resolve(segment);
                    BasicFileAttributes attrs = attrs(at);
                    if (attrs != null && attrs.isSymbolicLink()) {
                        return refused(400, "link", path + " passes a symbolic link. The entry stays, and the link "
                                + "is not followed.");
                    }
                }
                List<Path> targets = new ArrayList<>();
                if (attrs(root.resolve(path)) != null) {
                    targets.add(root.resolve(path));
                }
                for (String script : "hooks".equals(kind) ? hookScripts(root) : List.<String>of()) {
                    Path file = root.resolve("hooks").resolve(script);
                    BasicFileAttributes sa = attrs(file);
                    if (sa != null && sa.isRegularFile()) {
                        targets.add(file);
                    }
                }
                List<String> removed = new ArrayList<>();
                for (Path target : targets) {
                    removed.addAll(filesUnder(target).stream().map(p -> slashed(root, p)).toList());
                }
                String hash = removeThenWrite(root, cur, kind, path, targets);
                Path hooksFolder = root.resolve("hooks");
                if ("hooks".equals(kind) && Files.isDirectory(hooksFolder, LinkOption.NOFOLLOW_LINKS)
                        && children(hooksFolder).isEmpty()) {
                    Files.deleteIfExists(hooksFolder);
                }
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("removed", removed);
                return done(root, hash, out);
            } catch (Abort abort) {
                return abort.answer;
            }
        }
    }

    /**
     * Moves the entry's files into the staging folder, writes {@code playbook.json}, then deletes
     * them. A failure before the write is done moves every file back.
     */
    private String removeThenWrite(Path root, Current cur, String kind, String path, List<Path> targets)
            throws IOException, Abort {
        Path staging = root.resolve(STAGING);
        deleteTree(staging);
        List<Path[]> moved = new ArrayList<>();
        boolean finished = false;
        try {
            Files.createDirectory(staging);
            for (Path target : targets) {
                Path to = staging.resolve(String.valueOf(moved.size()));
                Files.move(target, to);
                moved.add(new Path[] {target, to});
            }
            midway.run();
            String hash = writeContents(root, cur, c -> with(c, kind, path, false));
            finished = true;
            return hash;
        } finally {
            if (!finished) {
                for (int i = moved.size() - 1; i >= 0; i--) {
                    Files.move(moved.get(i)[1], moved.get(i)[0]);
                }
            }
            deleteTree(staging);
        }
    }

    /** The files at or below a path, without following a link. */
    private static List<Path> filesUnder(Path start) throws IOException {
        try (Stream<Path> walk = Files.walk(start)) {
            return walk.filter(p -> {
                BasicFileAttributes a = attrs(p);
                return a != null && !a.isDirectory();
            }).sorted().toList();
        }
    }

    /** The scripts {@code hooks/hooks.json} names as {@code {hooks}/<name>}, each one plain segment. */
    private static List<String> hookScripts(Path root) throws IOException {
        Set<String> out = new LinkedHashSet<>();
        PlaybookFiles.Answer read = PlaybookFiles.read(root, HOOKS_FILE);
        if (!(read instanceof PlaybookFiles.Done done)) {
            return List.of();
        }
        JsonNode tree;
        try {
            tree = JSON.readTree(((PlaybookFiles.TextFile) done.body()).text());
        } catch (IOException notJson) {
            return List.of();
        }
        Pattern ref = Pattern.compile(Pattern.quote(HOOKS_PLACEHOLDER + "/") + "([^\\s'\";/\\\\]+)");
        for (JsonNode entry : tree) {
            var m = ref.matcher(entry.path("command").asText(""));
            while (m.find()) {
                String name = m.group(1);
                if (PlaybookFiles.segments(name) != null && !"hooks.json".equals(name)) {
                    out.add(name);
                }
            }
        }
        return List.copyOf(out);
    }

    /** Deletes a tree without following a link, deepest first; answers the files it removed. */
    private static List<Path> deleteTree(Path start) throws IOException {
        if (!exists(start)) {
            return List.of();
        }
        List<Path> removed = new ArrayList<>();
        List<Path> all;
        try (Stream<Path> walk = Files.walk(start)) {
            all = walk.sorted(Comparator.reverseOrder()).toList();
        }
        for (Path p : all) {
            BasicFileAttributes attrs = attrs(p);
            if (attrs != null && !attrs.isDirectory()) {
                removed.add(p);
            }
            Files.deleteIfExists(p);
        }
        return removed;
    }

    private static String slashed(Path root, Path path) {
        String s = root.relativize(path).toString();
        String sep = path.getFileSystem().getSeparator();
        return "/".equals(sep) ? s : s.replace(sep, "/");
    }
}
