package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.playbook.ContentHash;
import dev.spectroscope.core.playbook.Playbook;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SortedMap;
import java.util.TreeMap;
import java.util.function.Function;
import java.util.stream.Stream;

/**
 * The bytes a run holds for its whole length: the file, the templates and the
 * skills, read once at start, with the hash the confirmation showed.
 *
 * @param playbook      the playbook read from the folder
 * @param dir           the folder's real path
 * @param hash          sha256: and the hex digest over every pinned file
 * @param skills        the body of every skill a step names that resolved, by name
 * @param templates     the template text by document id
 * @param missingSkills the skill names that resolved nowhere, in node order
 */
public record PinnedPlaybook(Playbook playbook, Path dir, String hash, Map<String, SkillBody> skills,
                             Map<String, String> templates, List<String> missingSkills) {

    /**
     * @param dir           the playbook folder
     * @param p             the playbook read from it
     * @param installedBody an installed skill's body by name, or null when not installed
     * @return the pinned copy
     * @throws IOException when a pinned file cannot be read
     */
    public static PinnedPlaybook pin(Path dir, Playbook p, Function<String, String> installedBody) throws IOException {
        Path root = dir.toRealPath();
        SortedMap<String, byte[]> files = new TreeMap<>();
        files.put("playbook.json", Files.readAllBytes(root.resolve("playbook.json")));
        Map<String, String> templates = new LinkedHashMap<>();
        for (Map.Entry<String, Playbook.DocumentType> e : p.documents().entrySet()) {
            String template = e.getValue().template();
            if (template != null) {
                Path f = root.resolve(template).normalize();
                if (f.startsWith(root) && Files.isRegularFile(f, LinkOption.NOFOLLOW_LINKS)) {
                    byte[] bytes = Files.readAllBytes(f);
                    files.put(rel(root, f), bytes);
                    templates.put(e.getKey(), new String(bytes, StandardCharsets.UTF_8));
                }
            }
        }
        for (String skillRoot : p.contents().skills()) {
            Path base = root.resolve(skillRoot).normalize();
            if (!base.startsWith(root) || !Files.isDirectory(base, LinkOption.NOFOLLOW_LINKS)) {
                continue;
            }
            try (Stream<Path> walk = Files.walk(base)) {
                for (Path f : (Iterable<Path>) walk::iterator) {
                    if (Files.isRegularFile(f, LinkOption.NOFOLLOW_LINKS)) {
                        files.put(rel(root, f), Files.readAllBytes(f));
                    }
                }
            }
        }
        Set<String> names = new LinkedHashSet<>();
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.Step s) {
                names.addAll(s.skills());
            }
        }
        Map<String, SkillBody> skills = new LinkedHashMap<>();
        List<String> missing = new ArrayList<>();
        for (String name : names) {
            String pack = name.contains(":") ? name.substring(0, name.indexOf(':')) : null;
            String bare = name.contains(":") ? name.substring(name.indexOf(':') + 1) : name;
            String body = null;
            for (String skillRoot : p.contents().skills()) {
                String folder = Path.of(skillRoot).getFileName().toString();
                if (pack != null && !pack.equals(folder)) {
                    continue;
                }
                byte[] bytes = files.get(Path.of(skillRoot).normalize().toString().replace('\\', '/') + "/" + bare + "/SKILL.md");
                if (bytes != null) {
                    body = new String(bytes, StandardCharsets.UTF_8);
                    break;
                }
            }
            if (body != null) {
                skills.put(name, new SkillBody(name, "playbook", body));
                continue;
            }
            String installed = installedBody.apply(name);
            if (installed != null) {
                skills.put(name, new SkillBody(name, "installed", installed));
            } else {
                missing.add(name);
            }
        }
        return new PinnedPlaybook(p, root, hash(files), Map.copyOf(skills), Map.copyOf(templates), List.copyOf(missing));
    }

    /**
     * The start hash through the one {@link ContentHash} of playbooks.
     *
     * @param files relative path to bytes
     * @return sha256: and the lower hex digest
     */
    public static String hash(SortedMap<String, byte[]> files) {
        return "sha256:" + ContentHash.entries(files);
    }

    private static String rel(Path root, Path f) {
        return root.relativize(f).toString().replace('\\', '/');
    }
}
