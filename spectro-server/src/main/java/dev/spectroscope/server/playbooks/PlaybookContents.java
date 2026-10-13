package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.HookConfig;
import dev.spectroscope.core.playbook.AgentFile;
import dev.spectroscope.core.playbook.ContentHash;
import dev.spectroscope.core.playbook.Finding;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.SafeWalk;
import dev.spectroscope.core.skills.Skill;
import dev.spectroscope.core.skills.SkillLibrary;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;

/**
 * The preview of what a playbook folder brings: one {@link Item} per skill, command, hook, agent
 * and workflow, each with its source, content hash, state and reach, computed without writing
 * anything. The Playbook pane and the run sheet show this list; nothing installs it (owner,
 * 2026-10-13, card 558).
 *
 * <p>An item is listed only when its source is clean: a source with a finding (a link inside a
 * skill folder, a hooks entry with an unknown field, a command without a description) is named
 * under {@link Preview#findings()} and not listed. The order of the items is skills, commands,
 * hooks, agents, workflows.
 *
 * <p>A skill, command, hook or agent has the state {@code in-playbook}: a session reads it from
 * the folder in place, so neither the home, the user's hooks nor the install record an earlier
 * version left decides it. A workflow is {@code runnable} or {@code not-run}.
 */
public final class PlaybookContents {

    /** One file beside {@code hooks/hooks.json}; {@code path} is relative to the hooks folder. */
    public record HookFile(String path, String text) {}

    /**
     * One thing the folder brings. {@code scope} is a word: {@code sessions}, {@code tool-calls},
     * {@code runs} or {@code none}. {@code target} is where the install would put it (null for
     * agents and workflows). {@code command} and {@code files} are set for hooks only.
     */
    public record Item(String kind, String name, String source, String sha256, String state, String scope,
                       long bytes, String target, String command, List<HookFile> files) {}

    /**
     * The whole preview. {@code promptChars} is the length of the bullets the skills and commands
     * add to every system prompt. {@code hooksOrigin} names the settings layer whose hooks block is
     * in force, null when none is.
     */
    public record Preview(String playbook, String dir, String contentsHash, List<Item> items,
                          int promptChars, String hooksOrigin, List<Finding> findings) {}

    /** The state of every skill, command, hook and agent: a session reads it from the folder in place. */
    static final String IN_PLAYBOOK = "in-playbook";

    /** The largest text file the preview reads whole. */
    static final long MAX_TEXT_BYTES = 1024L * 1024;

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Set<String> HOOK_FIELDS = Set.of("event", "matcher", "command", "timeoutSeconds");
    /** The placeholder a hook command uses for the folder its scripts are installed into. */
    static final String HOOKS_PLACEHOLDER = "{hooks}";
    /** The placeholder a hook command uses for the workspace it is installed for (card 538). */
    static final String PROJECT_PLACEHOLDER = "{project}";

    private final Path root;
    private final Path spectroHome;
    /** The home folder: the parent of {@link #spectroHome}. */
    private final Path userHome;
    private final Path workspace;
    private final String id;
    private final List<Finding> findings = new ArrayList<>();
    private int promptChars;

    private PlaybookContents(Path root, Path spectroHome, Path workspace, String id) {
        this.root = root;
        this.spectroHome = spectroHome;
        this.userHome = spectroHome.getParent();
        this.workspace = workspace;
        this.id = id;
    }

    /**
     * Previews the contents of a playbook folder.
     *
     * @param dir           the playbook folder
     * @param playbook      the playbook read from its {@code playbook.json}
     * @param spectroHome   {@code ~/.spectro}
     * @param hooksOrigin   the settings layer whose hooks block is in force, or null
     * @return the items, the hashes and the findings
     * @throws IOException when the folder cannot be read
     */
    public static Preview preview(Path dir, Playbook playbook, Path spectroHome, String hooksOrigin) throws IOException {
        return preview(dir, playbook, spectroHome, hooksOrigin, null);
    }

    /**
     * Previews the contents of a playbook folder for a workspace: a hook command's {@code {project}}
     * becomes that folder.
     *
     * @param dir           the playbook folder
     * @param playbook      the playbook read from its {@code playbook.json}
     * @param spectroHome   {@code ~/.spectro}
     * @param hooksOrigin   the settings layer whose hooks block is in force, or null
     * @param workspace     the folder {@code {project}} stands for, or null when none is known; a hook
     *                      that names {@code {project}} is then a finding
     * @return the items, the hashes and the findings
     * @throws IOException when the folder cannot be read
     */
    public static Preview preview(Path dir, Playbook playbook, Path spectroHome, String hooksOrigin, Path workspace)
            throws IOException {
        Path root = dir.toRealPath();
        Path home = spectroHome.toAbsolutePath().normalize();
        PlaybookContents run = new PlaybookContents(root, home,
                workspace == null ? null : workspace.toAbsolutePath().normalize(), playbook.id());
        Playbook.Contents c = playbook.contents();
        List<Item> items = new ArrayList<>();
        items.addAll(run.skills(list(c == null ? null : c.skills())));
        items.addAll(run.commands(list(c == null ? null : c.commands())));
        items.addAll(run.hooks(list(c == null ? null : c.hooks())));
        items.addAll(run.agents(list(c == null ? null : c.agents())));
        items.addAll(run.workflows(list(c == null ? null : c.workflows())));
        List<String> lines = items.stream().map(i -> i.kind() + " " + i.name() + " " + i.sha256()).toList();
        return new Preview(playbook.id(), root.toString(), ContentHash.contents(lines), List.copyOf(items),
                run.promptChars, hooksOrigin, List.copyOf(run.findings));
    }

    /**
     * Card 558: the skills, commands and agents for a session that reads the folder in place.
     * Reads only.
     *
     * @param dir           the playbook folder
     * @param playbook      the playbook read from its {@code playbook.json}
     * @param spectroHome   {@code ~/.spectro}
     * @return the items and the findings
     * @throws IOException when the folder cannot be read
     */
    public static Preview listing(Path dir, Playbook playbook, Path spectroHome) throws IOException {
        Path root = dir.toRealPath();
        Path home = spectroHome.toAbsolutePath().normalize();
        PlaybookContents run = new PlaybookContents(root, home, null, playbook.id());
        Playbook.Contents c = playbook.contents();
        List<Item> items = new ArrayList<>();
        items.addAll(run.skills(list(c == null ? null : c.skills())));
        items.addAll(run.commands(list(c == null ? null : c.commands())));
        items.addAll(run.agents(list(c == null ? null : c.agents())));
        List<String> lines = items.stream().map(i -> i.kind() + " " + i.name() + " " + i.sha256()).toList();
        return new Preview(playbook.id(), root.toString(), ContentHash.contents(lines), List.copyOf(items),
                run.promptChars, null, List.copyOf(run.findings));
    }

    private static List<String> list(List<String> entries) {
        return entries == null ? List.of() : entries;
    }

    // ---- skills ------------------------------------------------------------------------------

    private List<Item> skills(List<String> packs) throws IOException {
        List<Item> out = new ArrayList<>();
        for (String entry : packs) {
            Path pack = inside(entry);
            if (pack == null || !Files.isDirectory(pack)) {
                continue; // the loader names a missing or escaping path
            }
            String packName = pack.getFileName().toString();
            List<Path> children;
            try (Stream<Path> listed = Files.list(pack)) {
                children = listed.sorted().toList();
            }
            for (Path skillDir : children) {
                BasicFileAttributes attrs = Files.readAttributes(skillDir, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                String rel = slashed(skillDir);
                if (attrs.isSymbolicLink()) {
                    findings.add(new Finding(rel, "a symbolic link"));
                } else if (attrs.isDirectory()) {
                    skill(packName, skillDir, rel).ifPresent(out::add);
                }
            }
        }
        return out;
    }

    private Optional<Item> skill(String pack, Path skillDir, String rel) throws IOException {
        String folder = skillDir.getFileName().toString();
        SafeWalk.Walk walk = SafeWalk.walk(root, skillDir);
        if (refused(walk, rel)) {
            return Optional.empty();
        }
        if (!walk.files().contains("SKILL.md")) {
            findings.add(new Finding(rel, "not a skill folder: it holds no SKILL.md"));
            return Optional.empty();
        }
        String raw = text(skillDir.resolve("SKILL.md"), rel + "/SKILL.md");
        if (raw == null) {
            return Optional.empty();
        }
        Skill parsed = SkillLibrary.parse(raw, folder, skillDir.resolve("SKILL.md"));
        if (!parsed.name().equals(folder)) {
            findings.add(new Finding(rel + "/SKILL.md#name", "the name " + parsed.name() + " differs from the folder name "
                    + folder + "; the settings list would show one name and the agent another"));
            return Optional.empty();
        }
        String name = pack + SkillLibrary.NAMESPACE_SEPARATOR + folder;
        String sha = ContentHash.tree(walk);
        Path target = spectroHome.resolve("skills").resolve(pack).resolve(folder);
        promptChars += bullet(name, parsed.description());
        return Optional.of(new Item("skill", name, rel, sha, IN_PLAYBOOK, "sessions", walk.bytes(), target.toString(), null, null));
    }

    // ---- commands ----------------------------------------------------------------------------

    private List<Item> commands(List<String> files) throws IOException {
        List<Item> out = new ArrayList<>();
        for (String entry : files) {
            Path file = inside(entry);
            if (file == null || !exists(file)) {
                continue;
            }
            String rel = slashed(file);
            SafeWalk.Walk walk = SafeWalk.walk(root, file);
            if (refused(walk, rel)) {
                continue;
            }
            String raw = text(file, rel);
            if (raw == null) {
                continue;
            }
            String description = frontmatterDescription(raw);
            if (description.isBlank()) {
                findings.add(new Finding(rel + "#description", "a command needs a description in its frontmatter"));
                continue;
            }
            String stem = stem(file);
            String name = id + SkillLibrary.NAMESPACE_SEPARATOR + stem;
            String sha = ContentHash.tree(walk);
            Path target = spectroHome.resolve("skills").resolve(id).resolve(stem);
            promptChars += bullet(name, description);
            out.add(new Item("command", name, rel, sha, IN_PLAYBOOK, "sessions", walk.bytes(), target.toString(), null, null));
        }
        return out;
    }

    /** The description of a command's frontmatter; empty when there is no closed frontmatter or no description. */
    static String frontmatterDescription(String raw) {
        List<String> lines = List.of(raw.split("\\R", -1));
        int first = -1;
        for (int i = 0; i < lines.size(); i++) {
            if (!lines.get(i).isBlank()) {
                first = i;
                break;
            }
        }
        if (first < 0 || !lines.get(first).strip().equals("---")) {
            return "";
        }
        for (int i = first + 1; i < lines.size(); i++) {
            if (lines.get(i).strip().equals("---")) {
                // Parsing the frontmatter alone keeps the skill parser from taking the first body line as a description.
                String head = String.join("\n", lines.subList(first, i + 1));
                return SkillLibrary.parse(head, "x", Path.of("command.md")).description();
            }
        }
        return "";
    }

    // ---- hooks -------------------------------------------------------------------------------

    private List<Item> hooks(List<String> files) throws IOException {
        List<Item> out = new ArrayList<>();
        for (String entry : files) {
            Path file = inside(entry);
            if (file == null || !exists(file)) {
                continue;
            }
            String rel = slashed(file);
            List<HookFile> scripts = new ArrayList<>();
            String scriptsHash = hookScripts(file, scripts);
            if (scriptsHash == null) {
                continue;
            }
            SafeWalk.Walk walk = SafeWalk.walk(root, file);
            if (refused(walk, rel)) {
                continue;
            }
            String raw = text(file, rel);
            if (raw == null) {
                continue;
            }
            JsonNode tree;
            try {
                tree = JSON.readTree(raw);
            } catch (IOException invalid) {
                findings.add(new Finding(rel, "not valid JSON: " + firstLine(invalid.getMessage())));
                continue;
            }
            if (tree == null || !tree.isArray()) {
                findings.add(new Finding(rel, "must be a JSON array of hook entries"));
                continue;
            }
            Path hookFolder = spectroHome.resolve("playbook-hooks").resolve(id);
            List<HookTokens.Hit> credentials = HookTokens.scan(raw);
            for (int i = 0; i < tree.size(); i++) {
                int index = i;
                List<HookTokens.Hit> hits = credentials.stream().filter(h -> h.entry() == index).toList();
                if (!hits.isEmpty()) {
                    hits.forEach(h -> findings.add(new Finding(rel + "[" + index + "]"
                            + (HOOK_FIELDS.contains(h.field()) ? "." + h.field() : ""),
                            HookTokens.message(h) + ". A hook that matches a key pattern is not listed.")));
                    continue;
                }
                hook(tree.get(i), rel, i, hookFolder, scripts, scriptsHash).ifPresent(out::add);
            }
        }
        return out;
    }

    /**
     * Reads every file beside {@code hooks.json} as text and returns their tree hash (null when one
     * is refused or not UTF-8). The hash skips {@code hooks.json} itself, so an edit of one entry
     * leaves the other entries' hashes alone; an edit of a script changes every hook's hash, because
     * each hook may run any of them.
     */
    private String hookScripts(Path hooksFile, List<HookFile> into) throws IOException {
        Path folder = hooksFile.getParent();
        String folderRel = slashed(folder);
        SafeWalk.Walk walk = SafeWalk.walk(root, folder);
        if (refused(walk, folderRel)) {
            return null;
        }
        String hooksName = hooksFile.getFileName().toString();
        boolean clean = true;
        for (String rel : walk.files()) {
            if (rel.equals(hooksName)) {
                continue;
            }
            String path = folderRel + "/" + rel;
            String text = text(folder.resolve(rel), path);
            if (text == null) {
                clean = false;
            } else {
                into.add(new HookFile(rel, text));
            }
        }
        return clean ? ContentHash.tree(walk, Set.of(hooksName)) : null;
    }

    /**
     * The hash of a hook item: the resolved entry and the scripts beside it, so that the contents
     * hash changes when a script does.
     */
    private static String hookItemHash(String entryHash, String scriptsHash) {
        return ContentHash.contents(List.of("entry " + entryHash, "scripts " + scriptsHash));
    }

    private Optional<Item> hook(JsonNode node, String rel, int index, Path hookFolder, List<HookFile> scripts,
                                 String scriptsHash) {
        String at = rel + "[" + index + "]";
        if (node == null || !node.isObject()) {
            findings.add(new Finding(at, "a hook entry must be an object"));
            return Optional.empty();
        }
        boolean clean = true;
        Set<String> fields = new TreeSet<>();
        node.fieldNames().forEachRemaining(fields::add);
        for (String field : fields) {
            if (!HOOK_FIELDS.contains(field)) {
                findings.add(new Finding(at + "." + field,
                        "unknown field; a hook entry has event, matcher, command and timeoutSeconds"));
                clean = false;
            }
        }
        String event = node.path("event").isTextual() ? node.get("event").asText() : null;
        String matcher = node.path("matcher").isTextual() ? node.get("matcher").asText() : null;
        String command = node.path("command").isTextual() ? node.get("command").asText() : null;
        Integer timeout = node.path("timeoutSeconds").isIntegralNumber() ? node.get("timeoutSeconds").asInt() : null;
        if (node.has("matcher") && !node.get("matcher").isNull() && matcher == null) {
            findings.add(new Finding(at + ".matcher", "must be text"));
            clean = false;
        }
        if (node.has("timeoutSeconds") && !node.get("timeoutSeconds").isNull() && timeout == null) {
            findings.add(new Finding(at + ".timeoutSeconds", "must be a whole number"));
            clean = false;
        }
        if (command == null || command.isBlank()) {
            findings.add(new Finding(at + ".command", "the command is missing"));
            clean = false;
        }
        try {
            new HookConfig(matcher, event, command, timeout);
        } catch (IllegalArgumentException unknownEvent) {
            findings.add(new Finding(at + ".event", unknownEvent.getMessage()));
            clean = false;
        }
        if (clean) {
            clean = commandFindings(at + ".command", command);
        }
        if (!clean) {
            return Optional.empty();
        }
        Map<String, String> values = new LinkedHashMap<>();
        values.put(HOOKS_PLACEHOLDER, hookFolder.toString());
        if (workspace != null) {
            values.put(PROJECT_PLACEHOLDER, workspace.toString());
        }
        String resolved = HookCommands.substitute(command, values);
        String sha = hookItemHash(ContentHash.hook(event, matcher, resolved, timeout), scriptsHash);
        String name = event + " " + (matcher == null || matcher.isBlank() ? "*" : matcher);
        String source = rel + "#" + index;
        return Optional.of(new Item("hook", name, source, sha, IN_PLAYBOOK, "tool-calls",
                resolved.getBytes(StandardCharsets.UTF_8).length, hookFolder.toString(), resolved, List.copyOf(scripts)));
    }

    /**
     * The findings of a hook command before its placeholders are put back (card 538): a hidden entry
     * of the home, a path that climbs above {@code {hooks}} or {@code {project}}, and a
     * {@code {project}} with no workspace, or with one that is the root, the home or holds the home.
     *
     * @return whether the command is clean
     */
    private boolean commandFindings(String at, String command) {
        String dot = HookCommands.homeDotFolder(command, userHome);
        if (dot != null) {
            findings.add(new Finding(at, "names " + dot + ", a hidden file or folder of the home. Such a hook "
                    + "is not installed"));
            return false;
        }
        for (String placeholder : List.of(HOOKS_PLACEHOLDER, PROJECT_PLACEHOLDER)) {
            if (HookCommands.climbsAbove(command, placeholder)) {
                findings.add(new Finding(at, "a path after " + placeholder + " leaves that folder with '..'. Such a hook "
                        + "is not installed"));
                return false;
            }
        }
        if (!command.contains(PROJECT_PLACEHOLDER)) {
            return true;
        }
        if (workspace == null) {
            findings.add(new Finding(at, "names " + PROJECT_PLACEHOLDER
                    + ", but no workspace is known to put in its place"));
            return false;
        }
        if (holdsTheHome(workspace)) {
            findings.add(new Finding(at, "names " + PROJECT_PLACEHOLDER + ", but the workspace is the file system "
                    + "root, the home folder or a folder that holds the home folder. The app does not put such a "
                    + "folder in its place"));
            return false;
        }
        return true;
    }

    /** Whether {@code folder} is the home or holds it, the root included, in any spelling of either. */
    private boolean holdsTheHome(Path folder) {
        for (String w : HookCommands.spellings(folder)) {
            for (String h : HookCommands.spellings(userHome)) {
                if (Path.of(h).startsWith(Path.of(w))) {
                    return true;
                }
            }
        }
        return false;
    }

    /** The hook entries of a settings file that bind; a missing or unreadable file has none. */
    static List<HookConfig> readUserHooks(Path settings) {
        List<HookConfig> out = new ArrayList<>();
        if (!Files.isRegularFile(settings)) {
            return out;
        }
        try {
            JsonNode hooks = JSON.readTree(Files.readString(settings, StandardCharsets.UTF_8)).path("hooks");
            for (JsonNode node : hooks) {
                try {
                    out.add(JSON.treeToValue(node, HookConfig.class));
                } catch (IOException | IllegalArgumentException unreadable) {
                    // An entry the settings loader would refuse is no entry to compare with.
                }
            }
        } catch (IOException | RuntimeException unreadable) {
            // A settings file that does not read has no hooks to collide with; the settings page names it.
        }
        return out;
    }

    // ---- agents and workflows ----------------------------------------------------------------

    private List<Item> agents(List<String> files) throws IOException {
        List<Item> out = new ArrayList<>();
        for (String entry : files) {
            Path file = inside(entry);
            if (file == null || !exists(file)) {
                continue;
            }
            String rel = slashed(file);
            SafeWalk.Walk walk = SafeWalk.walk(root, file);
            if (refused(walk, rel)) {
                continue;
            }
            String raw = text(file, rel);
            if (raw == null) {
                continue;
            }
            AgentFile.Read read = AgentFile.read(raw, rel);
            findings.addAll(read.findings());
            if (!read.findings().isEmpty() || read.agent() == null) {
                continue;
            }
            String sha = ContentHash.tree(walk);
            out.add(new Item("agent", read.agent().name(), rel, sha, IN_PLAYBOOK, "runs", walk.bytes(), null, null, null));
        }
        return out;
    }

    private List<Item> workflows(List<String> files) throws IOException {
        List<Item> out = new ArrayList<>();
        for (String entry : files) {
            Path file = inside(entry);
            if (file == null || !exists(file)) {
                continue;
            }
            String rel = slashed(file);
            SafeWalk.Walk walk = SafeWalk.walk(root, file);
            if (refused(walk, rel)) {
                continue;
            }
            String name = rel.startsWith("workflows/") ? rel.substring("workflows/".length()) : file.getFileName().toString();
            String sha;
            try {
                sha = ContentHash.tree(walk);
            } catch (IOException unreadable) {
                // Card 506 fix round 1: one unreadable file leaves the list, not the preview.
                findings.add(new Finding(rel, "not readable: " + unreadable.getClass().getSimpleName()));
                continue;
            }
            boolean runnable = runnable(file);
            out.add(new Item("workflow", name, rel, sha, runnable ? "runnable" : "not-run",
                    runnable ? "runs" : "none", walk.bytes(), null, null, null));
        }
        return out;
    }

    /**
     * Card 506: a regular file that reads as a step list runs in the session from the playbook
     * module; a directory, a link, a file that cannot be read and anything else is listed and not run.
     * A step list that starts a {@code worker} child is not run from the module either (fix round 2).
     */
    static boolean runnable(Path file) {
        if (!Files.isRegularFile(file, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            return false;
        }
        try (java.io.InputStream in = Files.newInputStream(file, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            byte[] bytes = in.readNBytes(dev.spectroscope.core.playbook.WorkflowReader.MAX_FILE_BYTES + 1);
            if (bytes.length > dev.spectroscope.core.playbook.WorkflowReader.MAX_FILE_BYTES) {
                return false;
            }
            dev.spectroscope.core.playbook.Workflow w = dev.spectroscope.core.playbook.WorkflowReader.read(bytes).workflow();
            return w != null && w.workerRoles().isEmpty();
        } catch (IOException unreadable) {
            return false;
        }
    }

    // ---- shared ------------------------------------------------------------------------------

    /** The path of a contents entry below the folder, or null when it leaves the folder or is not a path. */
    private Path inside(String entry) {
        if (entry == null || entry.isBlank()) {
            return null;
        }
        try {
            Path target = root.resolve(entry).normalize();
            return target.startsWith(root) && !target.equals(root) ? target : null;
        } catch (RuntimeException invalid) {
            return null;
        }
    }

    private static boolean exists(Path path) {
        return Files.exists(path, LinkOption.NOFOLLOW_LINKS);
    }

    /** Adds a finding for each refusal of the walk; true when there was one. */
    private boolean refused(SafeWalk.Walk walk, String startRel) {
        for (String line : walk.refused()) {
            int cut = line.indexOf(": ");
            String at = cut < 0 ? line : line.substring(0, cut);
            String why = cut < 0 ? "refused" : line.substring(cut + 2);
            findings.add(new Finding(at.equals(startRel) ? at : startRel + "/" + at, why));
        }
        return !walk.refused().isEmpty();
    }

    /** The text of a file, or null (with a finding) when it is too large or not UTF-8. */
    private String text(Path file, String rel) throws IOException {
        if (Files.size(file) > MAX_TEXT_BYTES) {
            findings.add(new Finding(rel, "larger than 1 MB; not read"));
            return null;
        }
        byte[] bytes = Files.readAllBytes(file);
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException notText) {
            findings.add(new Finding(rel, "not valid UTF-8; the file is shown in full before it is installed, so it must be text"));
            return null;
        }
    }

    private static int bullet(String name, String description) {
        return ("- " + name + ": " + description).length() + 1;
    }

    private String slashed(Path path) {
        String s = root.relativize(path).toString();
        String sep = path.getFileSystem().getSeparator();
        return "/".equals(sep) ? s : s.replace(sep, "/");
    }

    private static String stem(Path file) {
        String name = file.getFileName().toString();
        return name.endsWith(".md") ? name.substring(0, name.length() - 3) : name;
    }

    private static String firstLine(String message) {
        if (message == null) {
            return "";
        }
        int cut = message.indexOf('\n');
        return cut < 0 ? message : message.substring(0, cut);
    }
}
