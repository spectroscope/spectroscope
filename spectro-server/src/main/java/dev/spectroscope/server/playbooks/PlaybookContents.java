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
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;

/**
 * The preview of what a playbook folder brings: one {@link Item} per skill, command, hook, agent
 * and workflow, each with its source, content hash, state and reach, computed without writing
 * anything. The confirmation of the playbook installer shows this list before a click, and the
 * contents hash binds the click to the list that was shown.
 *
 * <p>An item is listed only when its source is clean: a source with a finding (a link inside a
 * skill folder, a hooks entry with an unknown field, a command without a description) is named
 * under {@link Preview#findings()} and not listed, because the installer refuses a folder with
 * findings anyway. The order of the items is the order of the confirmation: skills, commands,
 * hooks, agents, workflows.
 *
 * <p>The state of an item follows the install ledger entry of the playbook id, the source hash and
 * the hash of the installed copy (the copy hash skips the files the installer generated). A
 * command is installed as a generated {@code SKILL.md}, so an edit of that file is not told apart
 * here; a command whose installed folder is gone is {@code copy-changed}. When both sides of an
 * item changed, the state is {@code copy-changed}, because the removal keeps edited copies.
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

    /** The largest text file the preview reads whole. */
    static final long MAX_TEXT_BYTES = 1024L * 1024;

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Set<String> HOOK_FIELDS = Set.of("event", "matcher", "command", "timeoutSeconds");
    private static final String HOOKS_PLACEHOLDER = "{hooks}";

    private final Path root;
    private final Path spectroHome;
    private final Path projectSkills;
    private final String id;
    private final Map<String, InstallLedger.Item> recorded = new HashMap<>();
    private final List<HookConfig> userHooks;
    private final List<Finding> findings = new ArrayList<>();
    private int promptChars;

    private PlaybookContents(Path root, Path spectroHome, Path projectSkills, String id,
                             Optional<InstallLedger.Install> installed, List<HookConfig> userHooks) {
        this.root = root;
        this.spectroHome = spectroHome;
        this.projectSkills = projectSkills;
        this.id = id;
        this.userHooks = userHooks;
        installed.ifPresent(i -> i.items().forEach(item -> recorded.put(key(item.kind(), item.source()), item)));
    }

    /**
     * Previews the contents of a playbook folder.
     *
     * @param dir           the playbook folder
     * @param playbook      the playbook read from its {@code playbook.json}
     * @param spectroHome   {@code ~/.spectro}
     * @param projectSkills the launch directory's {@code .spectro/skills}
     * @param ledger        the install ledger
     * @param hooksOrigin   the settings layer whose hooks block is in force, or null
     * @return the items, the hashes and the findings
     * @throws IOException when the folder cannot be read
     */
    public static Preview preview(Path dir, Playbook playbook, Path spectroHome, Path projectSkills,
                                  InstallLedger ledger, String hooksOrigin) throws IOException {
        Path root = dir.toRealPath();
        Path home = spectroHome.toAbsolutePath().normalize();
        PlaybookContents run = new PlaybookContents(root, home, projectSkills.toAbsolutePath().normalize(),
                playbook.id(), ledger.find(playbook.id()), readUserHooks(home.resolve("settings.json")));
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
        Path inProject = projectSkills.resolve(pack).resolve(folder);
        String state = treeState("skill", rel, sha, target, inProject);
        promptChars += bullet(name, parsed.description());
        return Optional.of(new Item("skill", name, rel, sha, state, "sessions", walk.bytes(), target.toString(), null, null));
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
            Path inProject = projectSkills.resolve(id).resolve(stem);
            InstallLedger.Item rec = recorded.get(key("command", rel));
            String state;
            if (rec == null) {
                state = exists(target) || exists(inProject) ? "taken" : "new";
            } else if (!Files.isRegularFile(target.resolve("SKILL.md"), LinkOption.NOFOLLOW_LINKS)) {
                state = "copy-changed";
            } else {
                state = rec.sha256().equals(sha) ? "same" : "source-changed";
            }
            promptChars += bullet(name, description);
            out.add(new Item("command", name, rel, sha, state, "sessions", walk.bytes(), target.toString(), null, null));
        }
        return out;
    }

    /** The description of a command's frontmatter; empty when there is no closed frontmatter or no description. */
    private static String frontmatterDescription(String raw) {
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
            if (!hookScripts(file, scripts)) {
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
            for (int i = 0; i < tree.size(); i++) {
                hook(tree.get(i), rel, i, hookFolder, scripts).ifPresent(out::add);
            }
        }
        return out;
    }

    /** Reads every file beside {@code hooks.json} as text; false when one is refused or not UTF-8. */
    private boolean hookScripts(Path hooksFile, List<HookFile> into) throws IOException {
        Path folder = hooksFile.getParent();
        String folderRel = slashed(folder);
        SafeWalk.Walk walk = SafeWalk.walk(root, folder);
        boolean clean = !refused(walk, folderRel);
        if (!clean) {
            return false;
        }
        for (String rel : walk.files()) {
            if (rel.equals(hooksFile.getFileName().toString())) {
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
        return clean;
    }

    private Optional<Item> hook(JsonNode node, String rel, int index, Path hookFolder, List<HookFile> scripts) {
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
        if (!clean) {
            return Optional.empty();
        }
        String resolved = command.replace(HOOKS_PLACEHOLDER, hookFolder.toString());
        HookConfig entry = new HookConfig(matcher, event, resolved, timeout);
        String sha = ContentHash.hook(event, matcher, resolved, timeout);
        String name = event + " " + (matcher == null || matcher.isBlank() ? "*" : matcher);
        String source = rel + "#" + index;
        InstallLedger.Item rec = recorded.get(key("hook", source));
        String state;
        if (rec == null) {
            state = userHooks.contains(entry) ? "taken" : "new";
        } else if (!userHooks.contains(entry) && !userHooks.contains(recordedEntry(rec))) {
            state = "copy-changed";
        } else {
            state = rec.sha256().equals(sha) ? "same" : "source-changed";
        }
        return Optional.of(new Item("hook", name, source, sha, state, "tool-calls",
                resolved.getBytes(StandardCharsets.UTF_8).length, hookFolder.toString(), resolved, List.copyOf(scripts)));
    }

    private static HookConfig recordedEntry(InstallLedger.Item rec) {
        Map<String, Object> e = rec.entry();
        if (e == null) {
            return null;
        }
        try {
            Object timeout = e.get("timeoutSeconds");
            return new HookConfig((String) e.get("matcher"), (String) e.get("event"), (String) e.get("command"),
                    timeout instanceof Number n ? n.intValue() : null);
        } catch (IllegalArgumentException | ClassCastException unreadable) {
            return null;
        }
    }

    private static List<HookConfig> readUserHooks(Path settings) {
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
            InstallLedger.Item rec = recorded.get(key("agent", rel));
            String state = rec == null ? "new" : rec.sha256().equals(sha) ? "same" : "source-changed";
            out.add(new Item("agent", read.agent().name(), rel, sha, state, "runs", walk.bytes(), null, null, null));
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
            out.add(new Item("workflow", name, rel, ContentHash.tree(walk), "not-run", "none", walk.bytes(), null, null, null));
        }
        return out;
    }

    // ---- shared ------------------------------------------------------------------------------

    /**
     * The state of an item that is copied as a tree: from the ledger item with the same kind and
     * source, the source hash and the copy hash (the target without the files the installer wrote).
     */
    private String treeState(String kind, String source, String sha, Path target, Path inProject) throws IOException {
        InstallLedger.Item rec = recorded.get(key(kind, source));
        if (rec == null) {
            return exists(target) || exists(inProject) ? "taken" : "new";
        }
        if (!exists(target) || !copyMatches(target, rec)) {
            return "copy-changed";
        }
        return rec.sha256().equals(sha) ? "same" : "source-changed";
    }

    private boolean copyMatches(Path target, InstallLedger.Item rec) throws IOException {
        SafeWalk.Walk copy = SafeWalk.walk(spectroHome, target);
        if (!copy.refused().isEmpty()) {
            return false;
        }
        Set<String> skip = new TreeSet<>(rec.generated());
        skip.add(".disabled");
        return ContentHash.tree(copy, skip).equals(rec.sha256());
    }

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

    private static String key(String kind, String source) {
        return kind + "\u0000" + source;
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
