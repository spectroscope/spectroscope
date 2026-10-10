package dev.spectroscope.server.spectrolyzr;

import com.fasterxml.jackson.core.JsonPointer;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.PlaybookWriter;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import java.io.IOException;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Renders the files of one set of choices from the manifest's classpath
 * templates, and validates a manifest over every combination of choices.
 * Rendering is a pure function of the manifest and the choices: it reads
 * the classpath and nothing else, and uses no clock and no random, so the
 * same choices give the same bytes.
 */
public final class Spectrolyzr {

    /** The closed placeholder set; a template writes one as {@code @@name@@}. */
    public static final List<String> PLACEHOLDERS =
            List.of("name", "py_module", "java_package", "test_command", "check_command");

    /** JLS 21 section 3.9 ReservedKeyword plus the literals; ManifestReaderTest pins it against the JLS text. */
    static final List<String> JAVA_KEYWORDS = List.of("abstract", "continue", "for", "new", "switch", "assert",
            "default", "if", "package", "synchronized", "boolean", "do", "goto", "private", "this", "break", "double",
            "implements", "protected", "throw", "byte", "else", "import", "public", "throws", "case", "enum",
            "instanceof", "return", "transient", "catch", "extends", "int", "short", "try", "char", "final",
            "interface", "static", "void", "class", "finally", "long", "strictfp", "volatile", "const", "float",
            "native", "super", "while", "_", "true", "false", "null");

    /** Python's keyword.kwlist; ManifestReaderTest pins it against python3. */
    static final List<String> PYTHON_KEYWORDS = List.of("False", "None", "True", "and", "as", "assert", "async",
            "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from",
            "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
            "while", "with", "yield");

    static final Set<String> ROOTS = Set.of("project", "playbook");
    static final String QUALITY_GATE = "quality-gate";
    static final String SET_JSON_FILE = "playbook.json";

    private static final Pattern NAME = Pattern.compile("^[a-z][a-z0-9]*(-[a-z0-9]+)*$");
    private static final int NAME_MAX = 40;
    private static final Pattern PLACEHOLDER = Pattern.compile("@@([A-Za-z0-9_]+)@@");
    private static final Pattern SECOND_SENTENCE = Pattern.compile("[.!?]\\s+\\p{Lu}");
    private static final String SAMPLE_NAME = "sample-name";
    private static final ObjectMapper JSON = new ObjectMapper();

    private record Imported(String path, String content) {}

    private static final Map<String, List<Imported>> IMPORTS = new ConcurrentHashMap<>();

    private Spectrolyzr() {
    }

    /** Every subset of the manifest's add-ons, each in manifest order, the empty set first. */
    public static List<List<String>> addonSubsets(Manifest manifest) {
        List<String> ids = manifest.addons().stream().map(Manifest.Addon::id).toList();
        List<List<String>> out = new ArrayList<>();
        for (int mask = 0; mask < (1 << ids.size()); mask++) {
            List<String> subset = new ArrayList<>();
            for (int i = 0; i < ids.size(); i++) {
                if ((mask & (1 << i)) != 0) {
                    subset.add(ids.get(i));
                }
            }
            out.add(List.copyOf(subset));
        }
        return List.copyOf(out);
    }

    // ---------------------------------------------------------------- render

    /**
     * The files of {@code choices}, in manifest order. Throws
     * {@link ChoiceException} for a choice the manifest does not offer or a
     * refused name, and {@link IllegalStateException} when the manifest or a
     * bundled file is broken, which is not the choice's fault.
     */
    public static List<RenderedFile> render(Manifest manifest, Choices choices) {
        Manifest.Language language = check(manifest, choices);
        Set<String> chosen = new HashSet<>(choices.addons() == null ? List.of() : choices.addons());
        Map<String, String> values = values(choices.name(), language, chosen);
        Map<String, RenderedFile> files = new LinkedHashMap<>();
        for (Manifest.Part part : manifest.parts()) {
            if (!applies(part.when(), choices.archetype(), language.id(), chosen)) {
                continue;
            }
            for (Manifest.Put put : part.put()) {
                String path = substitute(put.path(), values);
                RenderedFile earlier = files.putIfAbsent(key(part.root(), path),
                        new RenderedFile(part.root(), path, substitute(template(manifest, put.template()), values),
                                put.why()));
                if (earlier != null) {
                    throw new IllegalStateException(part.id() + " puts " + part.root() + ":" + path + " twice");
                }
            }
            for (Manifest.Append append : part.append()) {
                String path = substitute(append.path(), values);
                RenderedFile earlier = files.get(key(part.root(), path));
                if (earlier == null) {
                    throw new IllegalStateException(part.id() + " appends to " + path + ", which nothing put");
                }
                files.put(key(part.root(), path), new RenderedFile(earlier.root(), earlier.path(),
                        earlier.content() + substitute(template(manifest, append.template()), values), earlier.why()));
            }
            if (part.importFrom() != null) {
                Manifest.Import imp = part.importFrom();
                for (Imported file : imported(imp.from())) {
                    Map<String, String> pointers = imp.setJson().get(file.path());
                    String content = pointers == null ? file.content() : setJson(file, pointers, values);
                    Manifest.Text why = whyFor(imp, file.path());
                    if (why == null) {
                        throw new IllegalStateException(part.id() + ": no why rule matches " + file.path());
                    }
                    if (files.putIfAbsent(key(part.root(), file.path()),
                            new RenderedFile(part.root(), file.path(), content, why)) != null) {
                        throw new IllegalStateException(part.id() + " imports " + file.path() + " twice");
                    }
                }
            }
        }
        return List.copyOf(files.values());
    }

    private static Manifest.Language check(Manifest manifest, Choices choices) {
        if (manifest.archetypes().stream().noneMatch(a -> a.id().equals(choices.archetype()))) {
            throw new ChoiceException("archetype", "unknown archetype: " + choices.archetype());
        }
        Manifest.Language language = manifest.languages().stream()
                .filter(l -> l.id().equals(choices.language())).findFirst()
                .orElseThrow(() -> new ChoiceException("language", "unknown language: " + choices.language()));
        Set<String> known = new HashSet<>(manifest.addons().stream().map(Manifest.Addon::id).toList());
        for (String addon : choices.addons() == null ? List.<String>of() : choices.addons()) {
            if (!known.contains(addon)) {
                throw new ChoiceException("addons", "unknown add-on: " + addon);
            }
        }
        String name = choices.name();
        if (name == null || name.length() > NAME_MAX || !NAME.matcher(name).matches()) {
            throw new ChoiceException("name", "the name must be lower case letters and digits in words joined by "
                    + "single hyphens, starting with a letter, at most " + NAME_MAX + " characters");
        }
        if (JAVA_KEYWORDS.contains(javaPackage(name))) {
            throw new ChoiceException("name", "the Java package " + javaPackage(name) + " is a Java keyword");
        }
        if (PYTHON_KEYWORDS.contains(pyModule(name))) {
            throw new ChoiceException("name", "the Python module " + pyModule(name) + " is a Python keyword");
        }
        return language;
    }

    private static String pyModule(String name) {
        return name.replace('-', '_');
    }

    private static String javaPackage(String name) {
        return name.replace("-", "");
    }

    private static Map<String, String> values(String name, Manifest.Language language, Set<String> chosen) {
        Map<String, String> v = new LinkedHashMap<>();
        v.put("name", name);
        v.put("py_module", pyModule(name));
        v.put("java_package", javaPackage(name));
        v.put("test_command", language.commands().get("test"));
        v.put("check_command", language.commands().get(chosen.contains(QUALITY_GATE) ? "gate" : "test"));
        return v;
    }

    private static boolean applies(Manifest.When when, String archetype, String language, Set<String> chosen) {
        return (when.archetype() == null || when.archetype().equals(archetype))
                && (when.language() == null || when.language().equals(language))
                && (when.addon() == null || chosen.contains(when.addon()));
    }

    private static String key(String root, String path) {
        return root + "\u0000" + path;
    }

    static String substitute(String text, Map<String, String> values) {
        Matcher m = PLACEHOLDER.matcher(text);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            String value = values.get(m.group(1));
            if (value == null) {
                throw new IllegalStateException("unknown placeholder " + m.group());
            }
            m.appendReplacement(out, Matcher.quoteReplacement(value));
        }
        return m.appendTail(out).toString();
    }

    private static Manifest.Text whyFor(Manifest.Import imp, String path) {
        for (Manifest.WhyRule rule : imp.whyByPrefix()) {
            if (path.startsWith(rule.prefix())) {
                return rule.why();
            }
        }
        return null;
    }

    private static String setJson(Imported file, Map<String, String> pointers, Map<String, String> values) {
        JsonNode tree;
        try {
            tree = JSON.readTree(file.content());
        } catch (IOException e) {
            throw new IllegalStateException(file.path() + " is not JSON: " + e.getMessage(), e);
        }
        if (!(tree instanceof ObjectNode)) {
            throw new IllegalStateException(file.path() + " is not a JSON object");
        }
        for (Map.Entry<String, String> e : pointers.entrySet()) {
            JsonPointer pointer = JsonPointer.compile(e.getKey());
            JsonNode parent = tree.at(pointer.head());
            if (!(parent instanceof ObjectNode object) || pointer.last().getMatchingProperty().isEmpty()) {
                throw new IllegalStateException(file.path() + ": " + e.getKey() + " does not name an object field");
            }
            object.put(pointer.last().getMatchingProperty(), substitute(e.getValue(), values));
        }
        PlaybookReader.Read read = PlaybookReader.read(tree.toString());
        if (read.playbook() == null || !read.findings().isEmpty()) {
            throw new IllegalStateException(file.path() + " does not read clean: " + read.findings());
        }
        return PlaybookWriter.write(read.playbook());
    }

    // ------------------------------------------------------------- classpath

    private static String resource(String at) {
        try (InputStream in = Spectrolyzr.class.getClassLoader().getResourceAsStream(at)) {
            if (in == null) {
                return null;
            }
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(in.readAllBytes())).toString();
        } catch (CharacterCodingException notUtf8) {
            throw new IllegalStateException(at + " is not UTF-8", notUtf8);
        } catch (IOException e) {
            throw new IllegalStateException(at + ": " + e.getMessage(), e);
        }
    }

    private static String template(Manifest manifest, String template) {
        String text = resource(manifest.resourceRoot() + "/templates/" + template);
        if (text == null) {
            throw new IllegalStateException("no template " + template);
        }
        return text;
    }

    /**
     * Every file below the classpath folder {@code from}, relative to it and
     * sorted by that relative path, because the resolver promises no order.
     */
    static List<Imported> imported(String from) {
        return IMPORTS.computeIfAbsent(from, Spectrolyzr::list);
    }

    private static List<Imported> list(String from) {
        Map<String, Imported> found = new LinkedHashMap<>();
        try {
            Resource[] resources = new PathMatchingResourcePatternResolver(Spectrolyzr.class.getClassLoader())
                    .getResources("classpath*:" + from + "**");
            for (Resource resource : resources) {
                String url = String.valueOf(resource.getURL());
                int at = url.lastIndexOf(from);
                if (at < 0 || url.endsWith("/") || !resource.isReadable()) {
                    continue;
                }
                String rel = URLDecoder.decode(url.substring(at + from.length()).replace("+", "%2B"),
                        StandardCharsets.UTF_8);
                if (rel.isEmpty()) {
                    continue;
                }
                String content;
                try (InputStream in = resource.getInputStream()) {
                    content = new String(in.readAllBytes(), StandardCharsets.UTF_8);
                }
                Imported earlier = found.putIfAbsent(rel, new Imported(rel, content));
                if (earlier != null && !earlier.content().equals(content)) {
                    throw new IllegalStateException(from + rel + " is on the classpath twice with different content");
                }
            }
        } catch (IOException e) {
            throw new IllegalStateException("cannot list " + from + ": " + e.getMessage(), e);
        }
        List<Imported> sorted = new ArrayList<>(found.values());
        sorted.sort(Comparator.comparing(Imported::path));
        return List.copyOf(sorted);
    }

    // -------------------------------------------------------------- validate

    /**
     * The spec's rules 1 to 5 over the manifest and over every combination of
     * archetype, language and add-on subset. Each problem names where it is.
     */
    public static List<String> validateAll(Manifest manifest) {
        List<String> problems = new ArrayList<>();
        if (manifest.schemaVersion() != 1) {
            problems.add("schema_version: must be 1, is " + manifest.schemaVersion());
        }
        Set<String> archetypes = unique(manifest.archetypes().stream().map(Manifest.Archetype::id).toList(),
                "archetypes", problems);
        Set<String> languages = unique(manifest.languages().stream().map(Manifest.Language::id).toList(),
                "languages", problems);
        Set<String> addons = unique(manifest.addons().stream().map(Manifest.Addon::id).toList(), "addons", problems);
        unique(manifest.parts().stream().map(Manifest.Part::id).toList(), "parts", problems);
        for (int i = 0; i < manifest.archetypes().size(); i++) {
            Manifest.Archetype a = manifest.archetypes().get(i);
            dashes(a.name(), "archetypes[" + i + "].name", problems);
            dashes(a.description(), "archetypes[" + i + "].description", problems);
        }
        for (int i = 0; i < manifest.addons().size(); i++) {
            Manifest.Addon a = manifest.addons().get(i);
            dashes(a.name(), "addons[" + i + "].name", problems);
            dashes(a.description(), "addons[" + i + "].description", problems);
        }
        for (int i = 0; i < manifest.parts().size(); i++) {
            part(manifest, manifest.parts().get(i), "parts[" + i + "]", archetypes, languages, addons, problems);
        }
        if (!problems.isEmpty()) {
            return List.copyOf(problems);
        }
        for (Manifest.Archetype archetype : manifest.archetypes()) {
            for (Manifest.Language language : manifest.languages()) {
                for (List<String> subset : addonSubsets(manifest)) {
                    combination(manifest, archetype.id(), language, subset, problems);
                }
            }
        }
        return List.copyOf(new LinkedHashSet<>(problems));
    }

    private static Set<String> unique(List<String> ids, String list, List<String> problems) {
        Set<String> seen = new LinkedHashSet<>();
        for (String id : ids) {
            if (!seen.add(id)) {
                problems.add(list + ": the id " + id + " is used twice");
            }
        }
        return seen;
    }

    private static void part(Manifest manifest, Manifest.Part part, String at, Set<String> archetypes,
            Set<String> languages, Set<String> addons, List<String> problems) {
        Manifest.When w = part.when();
        if (w.archetype() != null && !archetypes.contains(w.archetype())) {
            problems.add(at + ".when.archetype: unknown archetype " + w.archetype());
        }
        if (w.language() != null && !languages.contains(w.language())) {
            problems.add(at + ".when.language: unknown language " + w.language());
        }
        if (w.addon() != null && !addons.contains(w.addon())) {
            problems.add(at + ".when.addon: unknown add-on " + w.addon());
        }
        if (!ROOTS.contains(part.root())) {
            problems.add(at + ".root: must be one of " + ROOTS.stream().sorted().toList() + ", is " + part.root());
        }
        for (int i = 0; i < part.put().size(); i++) {
            Manifest.Put put = part.put().get(i);
            String here = at + ".put[" + i + "]";
            path(put.path(), here + ".path", problems);
            templateRules(manifest, put.template(), here + ".template", problems);
            why(put.why(), here + ".why", problems);
        }
        for (int i = 0; i < part.append().size(); i++) {
            Manifest.Append append = part.append().get(i);
            String here = at + ".append[" + i + "]";
            path(append.path(), here + ".path", problems);
            templateRules(manifest, append.template(), here + ".template", problems);
        }
        if (part.importFrom() != null) {
            importRules(part, at + ".import", problems);
        }
    }

    private static void importRules(Manifest.Part part, String at, List<String> problems) {
        Manifest.Import imp = part.importFrom();
        if (!imp.from().endsWith("/") || !relative(imp.from())) {
            problems.add(at + ".from: must be a relative classpath folder ending in /, is " + imp.from());
            return;
        }
        for (Map.Entry<String, Map<String, String>> e : imp.setJson().entrySet()) {
            if (!SET_JSON_FILE.equals(e.getKey())) {
                problems.add(at + ".set_json: part " + part.id() + " names " + e.getKey()
                        + ", only " + SET_JSON_FILE + " is allowed");
            }
            for (Map.Entry<String, String> pointer : e.getValue().entrySet()) {
                if (!pointer.getKey().startsWith("/")) {
                    problems.add(at + ".set_json." + e.getKey() + ": " + pointer.getKey() + " is not a JSON pointer");
                }
                placeholders(pointer.getValue(), at + ".set_json." + e.getKey() + "." + pointer.getKey(), problems);
            }
        }
        for (int i = 0; i < imp.whyByPrefix().size(); i++) {
            why(imp.whyByPrefix().get(i).why(), at + ".why_by_prefix[" + i + "].why", problems);
        }
        List<Imported> files;
        try {
            files = imported(imp.from());
        } catch (IllegalStateException e) {
            problems.add(at + ".from: " + e.getMessage());
            return;
        }
        if (files.isEmpty()) {
            problems.add(at + ".from: " + imp.from() + " holds no file on the classpath");
        }
        for (Imported file : files) {
            if (whyFor(imp, file.path()) == null) {
                problems.add(at + ": no why_by_prefix rule matches the imported file " + file.path());
            }
        }
        for (String file : imp.setJson().keySet()) {
            if (files.stream().noneMatch(f -> f.path().equals(file))) {
                problems.add(at + ".set_json: " + file + " is not among the imported files");
            }
        }
    }

    private static boolean relative(String path) {
        if (path.isEmpty() || path.startsWith("/") || path.contains("\\")) {
            return false;
        }
        for (String segment : path.split("/", -1)) {
            if (segment.equals("..") || segment.equals(".")) {
                return false;
            }
        }
        return true;
    }

    private static void path(String path, String at, List<String> problems) {
        if (!relative(path) || path.endsWith("/") || path.contains("//")) {
            problems.add(at + ": " + path + " must be a relative file path without . or .. segments");
        }
        placeholders(path, at, problems);
    }

    private static void placeholders(String text, String at, List<String> problems) {
        Matcher m = PLACEHOLDER.matcher(text);
        while (m.find()) {
            if (!PLACEHOLDERS.contains(m.group(1))) {
                problems.add(at + ": unknown placeholder " + m.group());
            }
        }
    }

    private static void templateRules(Manifest manifest, String template, String at, List<String> problems) {
        String where = at + " " + template;
        if (!relative(template)) {
            problems.add(where + ": must be a relative path");
            return;
        }
        String text;
        try {
            text = resource(manifest.resourceRoot() + "/templates/" + template);
        } catch (IllegalStateException notUtf8) {
            problems.add(where + ": " + notUtf8.getMessage());
            return;
        }
        if (text == null) {
            problems.add(where + ": no such template on the classpath");
            return;
        }
        if (text.indexOf('\r') >= 0) {
            problems.add(where + ": holds a carriage return");
        }
        placeholders(text, where, problems);
    }

    private static void dashes(Manifest.Text text, String at, List<String> problems) {
        dash(text.en(), at + ".en", problems);
        dash(text.de(), at + ".de", problems);
    }

    private static void dash(String text, String at, List<String> problems) {
        if (text.indexOf('—') >= 0 || text.indexOf('–') >= 0 || text.contains("--")
                || text.contains(" - ")) {
            problems.add(at + ": a dash used as punctuation");
        }
    }

    private static void why(Manifest.Text why, String at, List<String> problems) {
        for (Map.Entry<String, String> e : Map.of("en", why.en(), "de", why.de()).entrySet()) {
            String here = at + "." + e.getKey();
            String s = e.getValue();
            if (s == null || s.isBlank()) {
                problems.add(here + ": missing or blank");
                continue;
            }
            dash(s, here, problems);
            if (!s.strip().endsWith(".") || SECOND_SENTENCE.matcher(s).find()) {
                problems.add(here + ": must be one sentence ending in a full stop");
            }
        }
    }

    private static void combination(Manifest manifest, String archetype, Manifest.Language language,
            List<String> subset, List<String> problems) {
        String combo = "archetype=" + archetype + " language=" + language.id() + " addons=" + subset;
        Set<String> chosen = Set.copyOf(subset);
        Map<String, String> values = values(SAMPLE_NAME, language, chosen);
        Set<String> written = new HashSet<>();
        for (Manifest.Part part : manifest.parts()) {
            if (!applies(part.when(), archetype, language.id(), chosen)) {
                continue;
            }
            Set<String> before = Set.copyOf(written);
            for (Manifest.Put put : part.put()) {
                String path = substitute(put.path(), values);
                if (!relative(path)) {
                    problems.add(combo + ": part " + part.id() + " puts " + path + ", which is not relative");
                }
                if (!written.add(key(part.root(), path))) {
                    problems.add(combo + ": the root " + part.root() + " receives " + path + " twice (part "
                            + part.id() + ")");
                }
            }
            if (part.importFrom() != null) {
                for (Imported file : imported(part.importFrom().from())) {
                    if (!written.add(key(part.root(), file.path()))) {
                        problems.add(combo + ": the root " + part.root() + " receives " + file.path()
                                + " twice (part " + part.id() + ")");
                    }
                }
            }
            for (Manifest.Append append : part.append()) {
                String path = substitute(append.path(), values);
                if (!before.contains(key(part.root(), path))) {
                    problems.add(combo + ": part " + part.id() + " has an append to " + path
                            + ", which no earlier part put in the root " + part.root());
                }
            }
        }
    }
}
