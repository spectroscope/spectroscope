package dev.spectroscope.server.spectrolyzr;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Reads the Spectrolyzr manifest strictly. The tree is walked by hand, so an
 * unknown or missing field is a problem carrying its JSON path. A manifest
 * that reads clean is then checked by {@link Spectrolyzr#validateAll}; a
 * {@link Read} with any problem carries no manifest.
 */
public final class ManifestReader {

    public record Read(Manifest manifest, List<String> problems) {}

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final Set<String> TOP = Set.of("schema_version", "archetypes", "languages", "addons", "parts");
    private static final Set<String> CHOICE = Set.of("id", "name", "description");
    private static final Set<String> LANGUAGE = Set.of("id", "name", "commands");
    private static final Set<String> COMMANDS = Set.of("test", "gate");
    private static final Set<String> TEXT = Set.of("en", "de");
    private static final Set<String> PART = Set.of("id", "when", "root", "put", "append", "import");
    private static final Set<String> WHEN = Set.of("archetype", "language", "addon");
    private static final Set<String> PUT = Set.of("path", "template", "why");
    private static final Set<String> APPEND = Set.of("path", "template");
    private static final Set<String> IMPORT = Set.of("from", "set_json", "why_by_prefix");
    private static final Set<String> WHY_RULE = Set.of("prefix", "why");

    private final List<String> problems = new ArrayList<>();

    private ManifestReader() {
    }

    /** Reads {@code <resourceRoot>/manifest.json} from the classpath. */
    public static Read read(String resourceRoot) {
        String at = resourceRoot + "/manifest.json";
        try (InputStream in = ManifestReader.class.getClassLoader().getResourceAsStream(at)) {
            if (in == null) {
                return new Read(null, List.of(at + ": no manifest on the classpath"));
            }
            return parse(new String(in.readAllBytes(), StandardCharsets.UTF_8), resourceRoot);
        } catch (IOException e) {
            return new Read(null, List.of(at + ": " + e.getMessage()));
        }
    }

    static Read parse(String json, String resourceRoot) {
        JsonNode root;
        try {
            root = JSON.readTree(json);
        } catch (IOException malformed) {
            return new Read(null, List.of("manifest: not JSON: " + malformed.getMessage()));
        }
        if (root == null || !root.isObject()) {
            return new Read(null, List.of("manifest: must be a JSON object"));
        }
        ManifestReader r = new ManifestReader();
        Manifest manifest = r.manifest(root, resourceRoot);
        if (r.problems.isEmpty()) {
            r.problems.addAll(Spectrolyzr.validateAll(manifest));
        }
        return r.problems.isEmpty() ? new Read(manifest, List.of()) : new Read(null, List.copyOf(r.problems));
    }

    private static String at(String path, String field) {
        return path.isEmpty() ? field : path + "." + field;
    }

    private void unknown(JsonNode node, Set<String> known, String path) {
        Iterator<String> names = node.fieldNames();
        while (names.hasNext()) {
            String field = names.next();
            if (!known.contains(field)) {
                problems.add(at(path, field) + ": unknown field");
            }
        }
    }

    private boolean object(JsonNode node, String path) {
        if (node == null || !node.isObject()) {
            problems.add(path + ": must be an object");
            return false;
        }
        return true;
    }

    private String text(JsonNode node, String field, String path) {
        JsonNode v = node.get(field);
        if (v == null || !v.isTextual() || v.asText().isBlank()) {
            problems.add(at(path, field) + ": missing or blank");
            return "";
        }
        return v.asText();
    }

    private String optionalText(JsonNode node, String field, String path) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) {
            return null;
        }
        if (!v.isTextual() || v.asText().isBlank()) {
            problems.add(at(path, field) + ": must be a non blank string");
            return null;
        }
        return v.asText();
    }

    private List<JsonNode> array(JsonNode node, String field, String path, boolean required) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) {
            if (required) {
                problems.add(at(path, field) + ": missing");
            }
            return List.of();
        }
        if (!v.isArray()) {
            problems.add(at(path, field) + ": must be an array");
            return List.of();
        }
        List<JsonNode> out = new ArrayList<>();
        v.forEach(out::add);
        return out;
    }

    private Manifest.Text bilingual(JsonNode node, String field, String path) {
        String here = at(path, field);
        JsonNode v = node.get(field);
        if (!object(v, here)) {
            return new Manifest.Text("", "");
        }
        unknown(v, TEXT, here);
        return new Manifest.Text(text(v, "en", here), text(v, "de", here));
    }

    private Manifest manifest(JsonNode root, String resourceRoot) {
        unknown(root, TOP, "");
        JsonNode version = root.get("schema_version");
        int schemaVersion = 0;
        if (version == null || !version.isInt()) {
            problems.add("schema_version: missing or not an integer");
        } else {
            schemaVersion = version.asInt();
        }
        List<Manifest.Archetype> archetypes = new ArrayList<>();
        int i = 0;
        for (JsonNode a : array(root, "archetypes", "", true)) {
            String path = "archetypes[" + i++ + "]";
            if (object(a, path)) {
                unknown(a, CHOICE, path);
                archetypes.add(new Manifest.Archetype(text(a, "id", path), bilingual(a, "name", path),
                        bilingual(a, "description", path)));
            }
        }
        List<Manifest.Language> languages = new ArrayList<>();
        i = 0;
        for (JsonNode l : array(root, "languages", "", true)) {
            String path = "languages[" + i++ + "]";
            if (object(l, path)) {
                unknown(l, LANGUAGE, path);
                Map<String, String> commands = new LinkedHashMap<>();
                String here = at(path, "commands");
                JsonNode c = l.get("commands");
                if (object(c, here)) {
                    unknown(c, COMMANDS, here);
                    for (String key : List.of("test", "gate")) {
                        commands.put(key, text(c, key, here));
                    }
                }
                languages.add(new Manifest.Language(text(l, "id", path), text(l, "name", path), Map.copyOf(commands)));
            }
        }
        List<Manifest.Addon> addons = new ArrayList<>();
        i = 0;
        for (JsonNode a : array(root, "addons", "", true)) {
            String path = "addons[" + i++ + "]";
            if (object(a, path)) {
                unknown(a, CHOICE, path);
                addons.add(new Manifest.Addon(text(a, "id", path), bilingual(a, "name", path),
                        bilingual(a, "description", path)));
            }
        }
        List<Manifest.Part> parts = new ArrayList<>();
        i = 0;
        for (JsonNode p : array(root, "parts", "", true)) {
            String path = "parts[" + i++ + "]";
            if (object(p, path)) {
                parts.add(part(p, path));
            }
        }
        return new Manifest(schemaVersion, List.copyOf(archetypes), List.copyOf(languages), List.copyOf(addons),
                List.copyOf(parts), resourceRoot);
    }

    private Manifest.Part part(JsonNode p, String path) {
        unknown(p, PART, path);
        Manifest.When when = new Manifest.When(null, null, null);
        JsonNode w = p.get("when");
        if (w != null && !w.isNull()) {
            String here = at(path, "when");
            if (object(w, here)) {
                unknown(w, WHEN, here);
                when = new Manifest.When(optionalText(w, "archetype", here), optionalText(w, "language", here),
                        optionalText(w, "addon", here));
            }
        }
        List<Manifest.Put> puts = new ArrayList<>();
        int i = 0;
        for (JsonNode u : array(p, "put", path, false)) {
            String here = at(path, "put[" + i++ + "]");
            if (object(u, here)) {
                unknown(u, PUT, here);
                puts.add(new Manifest.Put(text(u, "path", here), text(u, "template", here), bilingual(u, "why", here)));
            }
        }
        List<Manifest.Append> appends = new ArrayList<>();
        i = 0;
        for (JsonNode a : array(p, "append", path, false)) {
            String here = at(path, "append[" + i++ + "]");
            if (object(a, here)) {
                unknown(a, APPEND, here);
                appends.add(new Manifest.Append(text(a, "path", here), text(a, "template", here)));
            }
        }
        Manifest.Import importFrom = null;
        JsonNode m = p.get("import");
        if (m != null && !m.isNull()) {
            importFrom = importFrom(m, at(path, "import"));
        }
        return new Manifest.Part(text(p, "id", path), when, text(p, "root", path), List.copyOf(puts),
                List.copyOf(appends), importFrom);
    }

    private Manifest.Import importFrom(JsonNode m, String path) {
        if (!object(m, path)) {
            return null;
        }
        unknown(m, IMPORT, path);
        Map<String, Map<String, String>> setJson = new LinkedHashMap<>();
        JsonNode s = m.get("set_json");
        if (s != null && !s.isNull()) {
            String here = at(path, "set_json");
            if (object(s, here)) {
                s.fields().forEachRemaining(file -> {
                    String fileAt = at(here, file.getKey());
                    Map<String, String> pointers = new LinkedHashMap<>();
                    if (object(file.getValue(), fileAt)) {
                        file.getValue().fields().forEachRemaining(ptr -> {
                            if (!ptr.getValue().isTextual()) {
                                problems.add(at(fileAt, ptr.getKey()) + ": must be a string");
                            } else {
                                pointers.put(ptr.getKey(), ptr.getValue().asText());
                            }
                        });
                    }
                    setJson.put(file.getKey(), pointers);
                });
            }
        }
        List<Manifest.WhyRule> rules = new ArrayList<>();
        int i = 0;
        for (JsonNode r : array(m, "why_by_prefix", path, true)) {
            String here = at(path, "why_by_prefix[" + i++ + "]");
            if (object(r, here)) {
                unknown(r, WHY_RULE, here);
                rules.add(new Manifest.WhyRule(text(r, "prefix", here), bilingual(r, "why", here)));
            }
        }
        return new Manifest.Import(text(m, "from", path), setJson, List.copyOf(rules));
    }
}
