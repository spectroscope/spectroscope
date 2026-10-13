package dev.spectroscope.core.skills;

import dev.spectroscope.core.config.SpectroDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Card 558: the skills, commands and agents of a session's own working folder,
 * read in place from its {@code .claude} and {@code .spectro} folders. Inside
 * the workspace the {@code .spectro} copy of a name replaces the
 * {@code .claude} one, as the settings layers do; the owner's rule of no
 * precedence is between the workspace, the playbook and the user's folders.
 *
 * <ul>
 *   <li>Skills: {@code skills/} as {@link SkillLibrary} reads a root, packs included.</li>
 *   <li>Commands: the {@code .md} files directly in {@code commands/}, by file name;
 *       the body after the frontmatter is the text a {@code /name} hands the model.</li>
 *   <li>Agents: the {@code .md} files directly in {@code agents/}. The child type is the
 *       file's {@code type} when it names one; a file without one (the Claude Code
 *       shape) runs as {@code worker}, or as {@code explore} when its {@code tools}
 *       line names no tool that writes or runs a command. A model or a tool list in
 *       the file is not applied: the session's model and the type's belt run.</li>
 * </ul>
 *
 * <p>Reads only. A file that does not read is left out.</p>
 */
public final class WorkspaceItems {

    private static final org.slf4j.Logger LOG = org.slf4j.LoggerFactory.getLogger(WorkspaceItems.class);

    /** The folders read, in the order the later one replaces the earlier by name. */
    static final List<String> FOLDERS = List.of(".claude", dev.spectroscope.core.config.SpectroDir.NAME);

    /** The child types an agent may name. */
    static final Set<String> TYPES = Set.of("explore", "worker", "research");

    /** The Claude Code tool names that write a file or run a command. */
    private static final Set<String> WRITING_TOOLS = Set.of("write", "edit", "multiedit", "bash", "notebookedit");

    private static final Pattern PLAIN_NAME = Pattern.compile("[\\p{L}\\p{N}][\\p{L}\\p{N}_-]*");

    private WorkspaceItems() {
    }

    /**
     * Reads a working folder, leaving out a skill root that is the user's own
     * ({@code ~/.spectro/skills}), as the session's own folder is when it is
     * the home: the user layer reads that root already (review finding 1).
     *
     * @param workspace the session's working folder, or null when it has none yet
     * @return the workspace layer; empty for null or a folder without either subfolder
     */
    public static SessionCatalogue.Layer read(Path workspace) {
        return read(workspace, Path.of(System.getProperty("user.home"), SpectroDir.NAME, "skills"));
    }

    /**
     * @param workspace     the session's working folder, or null when it has none yet
     * @param userSkillRoot the user's own skill root; a workspace skill root that is
     *                      the same folder is not read, or null to read every root
     * @return the workspace layer; empty for null or a folder without either subfolder
     */
    public static SessionCatalogue.Layer read(Path workspace, Path userSkillRoot) {
        List<SessionCatalogue.Entry> entries = new ArrayList<>();
        if (workspace != null) {
            Path userReal = real(userSkillRoot);
            List<Path> roots = FOLDERS.stream().map(f -> workspace.resolve(f).resolve("skills"))
                    .filter(root -> userReal == null || !userReal.equals(real(root))).toList();
            for (Skill s : SkillLibrary.load(roots).skills()) {
                entries.add(new SessionCatalogue.Entry(SessionCatalogue.SKILL, s.name(), s.description(), s.body(),
                        s.source(), null));
            }
            entries.addAll(commands(workspace));
            entries.addAll(agents(workspace));
        }
        return new SessionCatalogue.Layer(SessionCatalogue.WORKSPACE, SessionCatalogue.WORKSPACE, entries);
    }

    private static List<SessionCatalogue.Entry> commands(Path workspace) {
        Map<String, SessionCatalogue.Entry> byName = new LinkedHashMap<>();
        for (String folder : FOLDERS) {
            for (Path file : markdownFiles(workspace.resolve(folder).resolve("commands"))) {
                String stem = stem(file);
                String raw = text(file);
                if (raw == null || !PLAIN_NAME.matcher(stem).matches()) {
                    continue;
                }
                Skill parsed = SkillLibrary.parse(raw, stem, file);
                byName.put(stem, new SessionCatalogue.Entry(SessionCatalogue.COMMAND, stem, parsed.description(),
                        parsed.body(), file, null));
            }
        }
        return new ArrayList<>(byName.values());
    }

    private static List<SessionCatalogue.Entry> agents(Path workspace) {
        Map<String, SessionCatalogue.Entry> byName = new LinkedHashMap<>();
        for (String folder : FOLDERS) {
            for (Path file : markdownFiles(workspace.resolve(folder).resolve("agents"))) {
                String raw = text(file);
                SessionCatalogue.Entry e = raw == null ? null : agent(raw, stem(file), file);
                if (e != null) {
                    byName.put(e.plain(), e);
                }
            }
        }
        return new ArrayList<>(byName.values());
    }

    /** One agent file, or null when it has no usable name or no body. */
    private static SessionCatalogue.Entry agent(String raw, String stem, Path file) {
        Map<String, String> fields = frontmatter(raw);
        String name = fields.getOrDefault("name", stem).strip();
        String body = SkillLibrary.parse(raw, stem, file).body();
        if (!PLAIN_NAME.matcher(name).matches() || body.isBlank()) {
            return null;
        }
        String type = fields.getOrDefault("type", "").strip();
        if (!TYPES.contains(type)) {
            type = typeFromTools(raw, file);
        }
        return new SessionCatalogue.Entry(SessionCatalogue.AGENT, name, fields.getOrDefault("description", "").strip(),
                body, file, type);
    }

    /**
     * {@code worker} without a tools key (every tool, as Claude Code reads it),
     * {@code worker} when the list names a tool that writes or runs a command,
     * else {@code explore}. A tools key whose value does not read as a list runs
     * as {@code explore}, the narrower type, and the log says why (review
     * finding 3).
     */
    private static String typeFromTools(String raw, Path file) {
        List<String> tools;
        try {
            tools = toolsOf(raw);
        } catch (IllegalArgumentException unreadable) {
            LOG.warn("agent {}: the tools key does not read as a list ({}); it runs as explore",
                    file, unreadable.getMessage());
            return "explore";
        }
        if (tools == null) {
            return "worker";
        }
        for (String tool : tools) {
            if (WRITING_TOOLS.contains(tool.toLowerCase(Locale.ROOT))) {
                return "worker";
            }
        }
        return "explore";
    }

    /**
     * The tool names of an agent file's {@code tools} key: an inline line
     * ({@code Read, Bash(git log:*)}), a flow list ({@code [Read, "Bash"]}) or a
     * block list of {@code - Read} lines. A name is the part before a
     * parenthesis, so {@code Bash(git log:*)} is {@code Bash}.
     *
     * @return the names, or null when the frontmatter has no tools key
     * @throws IllegalArgumentException when the value does not read as a list
     */
    static List<String> toolsOf(String raw) {
        List<String> lines = frontmatterLines(raw);
        for (int i = 0; i < lines.size(); i++) {
            String line = lines.get(i);
            if (line.isEmpty() || Character.isWhitespace(line.charAt(0)) || !line.startsWith("tools")) {
                continue;
            }
            int colon = line.indexOf(':');
            if (colon < 0 || !line.substring(0, colon).strip().equals("tools")) {
                continue;
            }
            String value = line.substring(colon + 1).strip();
            List<String> entries = new ArrayList<>();
            if (value.isEmpty()) {
                for (int j = i + 1; j < lines.size(); j++) {
                    String next = lines.get(j);
                    if (next.isBlank()) {
                        continue;
                    }
                    if (!Character.isWhitespace(next.charAt(0))) {
                        break;
                    }
                    String item = next.strip();
                    if (!item.startsWith("-")) {
                        throw new IllegalArgumentException("a block line that is not a list item: " + item);
                    }
                    entries.add(item.substring(1));
                }
            } else if (Set.of("|", "|-", ">", ">-").contains(value)) {
                throw new IllegalArgumentException("a block scalar, not a list");
            } else if (value.startsWith("[")) {
                if (!value.endsWith("]")) {
                    throw new IllegalArgumentException("a flow list without its closing bracket");
                }
                entries.addAll(splitTopLevel(value.substring(1, value.length() - 1)));
            } else {
                entries.addAll(splitTopLevel(value));
            }
            List<String> names = new ArrayList<>();
            for (String entry : entries) {
                String name = unquote(entry.strip());
                int paren = name.indexOf('(');
                name = (paren < 0 ? name : name.substring(0, paren)).strip();
                if (!name.isEmpty()) {
                    names.add(name);
                }
            }
            if (names.isEmpty()) {
                throw new IllegalArgumentException("no tool named");
            }
            return names;
        }
        return null;
    }

    /** Splits on the commas that stand outside parentheses and quotes. */
    private static List<String> splitTopLevel(String text) {
        List<String> out = new ArrayList<>();
        int depth = 0;
        char quote = 0;
        int from = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (quote != 0) {
                if (c == quote) {
                    quote = 0;
                }
            } else if (c == '"' || c == '\'') {
                quote = c;
            } else if (c == '(') {
                depth++;
            } else if (c == ')') {
                depth = Math.max(0, depth - 1);
            } else if (c == ',' && depth == 0) {
                out.add(text.substring(from, i));
                from = i + 1;
            }
        }
        out.add(text.substring(from));
        return out;
    }

    /** The lines between a leading {@code ---} and the closing one; empty without a frontmatter. */
    private static List<String> frontmatterLines(String raw) {
        List<String> lines = raw.lines().toList();
        int first = 0;
        while (first < lines.size() && lines.get(first).isBlank()) {
            first++;
        }
        if (first >= lines.size() || !lines.get(first).strip().equals("---")) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (int i = first + 1; i < lines.size() && !lines.get(i).strip().equals("---"); i++) {
            out.add(lines.get(i));
        }
        return out;
    }

    /** The real path of a folder, or its normalized form when it does not resolve; null for null. */
    private static Path real(Path folder) {
        if (folder == null) {
            return null;
        }
        try {
            return folder.toRealPath();
        } catch (java.io.IOException | RuntimeException unresolved) {
            return folder.toAbsolutePath().normalize();
        }
    }

    /** The flat {@code key: value} lines of a leading frontmatter block; empty without one. */
    private static Map<String, String> frontmatter(String raw) {
        Map<String, String> out = new LinkedHashMap<>();
        List<String> lines = raw.lines().toList();
        int first = 0;
        while (first < lines.size() && lines.get(first).isBlank()) {
            first++;
        }
        if (first >= lines.size() || !lines.get(first).strip().equals("---")) {
            return out;
        }
        for (int i = first + 1; i < lines.size() && !lines.get(i).strip().equals("---"); i++) {
            String line = lines.get(i);
            int colon = line.indexOf(':');
            if (colon > 0 && !Character.isWhitespace(line.charAt(0))) {
                out.putIfAbsent(line.substring(0, colon).strip(), unquote(line.substring(colon + 1).strip()));
            }
        }
        return out;
    }

    /** One matching pair of surrounding quotes is a delimiter, not text. */
    private static String unquote(String value) {
        if (value.length() >= 2 && (value.charAt(0) == '"' || value.charAt(0) == '\'')
                && value.charAt(value.length() - 1) == value.charAt(0)) {
            return value.substring(1, value.length() - 1);
        }
        return value;
    }

    /** The regular {@code .md} files directly in a folder, sorted; none when it is absent. */
    private static List<Path> markdownFiles(Path dir) {
        if (!Files.isDirectory(dir)) {
            return List.of();
        }
        try (Stream<Path> listed = Files.list(dir)) {
            return listed.filter(Files::isRegularFile).filter(p -> p.getFileName().toString().endsWith(".md"))
                    .sorted().toList();
        } catch (IOException unreadable) {
            return List.of();
        }
    }

    private static String text(Path file) {
        try {
            return Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException | RuntimeException unreadable) {
            return null;
        }
    }

    private static String stem(Path file) {
        String name = file.getFileName().toString();
        return name.substring(0, name.length() - ".md".length());
    }
}
