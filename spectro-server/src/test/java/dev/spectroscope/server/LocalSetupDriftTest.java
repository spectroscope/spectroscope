package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.server.codegraph.GraphifyCommand;
import dev.spectroscope.server.web.LocalSetupScriptController;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.core.type.filter.AnnotationTypeFilter;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;

import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * The Local Setup page's data file against the code it describes (card 529).
 *
 * <p>{@code docs/local-setup/steps.json} prints install lines, addresses and
 * check URLs that the product also prints or listens for. Each fact below is
 * read from the class or file that owns it, so a change on either side turns
 * this red. The page itself is built from the data file by
 * {@code docs/local-setup/build_local_setup.py}; its Python tests hold the
 * page to the data on a machine with the WebP encoder. CI runs no Python, so
 * the checks at the bottom repeat what CI must catch: the page's build stamp
 * against the inputs in the tree, the scripts, the product sources and the
 * dash rule.</p>
 */
class LocalSetupDriftTest {

    static final Path ROOT = LangfuseComposeDriftTest.repoRoot();
    static final Path STEPS = ROOT.resolve("docs/local-setup/steps.json");
    static final Path SCRIPTS = ROOT.resolve("docs/local-setup/scripts");
    static final Path PAGE = ROOT.resolve("docs/local-setup/index.html");
    static final Path LOCAL_SETUP = ROOT.resolve("docs/local-setup");

    /**
     * Card 536 flips this to true once every plate is a real capture. Until
     * then a placeholder plate is reported and passes.
     */
    static final boolean PLACEHOLDERS_FAIL = false;

    /** The marker the builder writes into a placeholder plate's tEXt chunk. */
    static final String PLACEHOLDER_MARK = "spectroscope-placeholder";

    private static JsonNode doc() throws IOException {
        assertTrue(Files.isRegularFile(STEPS), "missing " + STEPS);
        return new ObjectMapper().readTree(STEPS.toFile());
    }

    private static JsonNode step(String id) throws IOException {
        for (JsonNode s : doc().path("steps")) {
            if (id.equals(s.path("id").asText())) {
                return s;
            }
        }
        fail("steps.json has no step " + id);
        return null;
    }

    private static List<String> commandTexts(JsonNode step, String platform) {
        List<String> out = new ArrayList<>();
        for (JsonNode c : step.path("commands").path(platform)) {
            out.add(c.path("text").asText());
        }
        return out;
    }

    private static List<String> allCommandTexts() throws IOException {
        List<String> out = new ArrayList<>();
        for (JsonNode s : doc().path("steps")) {
            s.path("commands").fields().forEachRemaining(e -> e.getValue()
                    .forEach(c -> out.add(c.path("text").asText())));
        }
        return out;
    }

    @Test
    void theWhisperInstallLineIsTheOneTheSpeechStatusPrints() throws Exception {
        Class<?> stt = Class.forName("dev.spectroscope.server.llm.SttController");
        Method hint = stt.getDeclaredMethod("hintFor", String.class);
        hint.setAccessible(true);
        String mac = (String) hint.invoke(null, "Mac OS X");
        assertEquals(List.of(mac), commandTexts(step("3.2"), "mac"),
                "step 3.2 on macOS must print exactly the binaryHint of SttController");
    }

    @Test
    void theGraphifyLineIsTheOneTheCodeGraphSheetPrints() throws IOException {
        List<String> lines = commandTexts(step("5.2"), "mac");
        assertFalse(lines.isEmpty(), "step 5.2 prints no command");
        assertEquals(GraphifyCommand.INSTALL_LINE, lines.get(0));
        assertEquals(GraphifyCommand.INSTALL_LINE, commandTexts(step("5.2"), "linux").get(0));
    }

    @Test
    void theSearxngCheckAsksThePortTheInstallerListensOn() throws IOException {
        String script = Files.readString(ROOT.resolve("samples/09-searxng/install.sh"));
        Matcher def = Pattern.compile("SEARXNG_PORT=\"\\$\\{SEARXNG_PORT:-(\\d+)}\"").matcher(script);
        assertTrue(def.find(), "install.sh lost its SEARXNG_PORT default");
        String check = step("4.2").path("check").path("all").path("text").asText();
        Matcher port = Pattern.compile("localhost:(\\d+)/search").matcher(check);
        assertTrue(port.find(), "step 4.2's check names no localhost search URL: " + check);
        assertEquals(def.group(1), port.group(1));
    }

    @Test
    void theProviderAddressesAreThePresets() throws IOException {
        Map<String, String> presets = Map.of(
                "ollama", SpectroConfig.effectiveOllamaBaseUrl(null, null),
                "lmstudio", SpectroConfig.effectiveLmstudioBaseUrl(null, null),
                "llamacpp", SpectroConfig.effectiveLlamacppBaseUrl(null, null));
        Set<String> seen = new TreeSet<>();
        for (JsonNode s : doc().path("steps")) {
            JsonNode address = s.path("address");
            if (address.isMissingNode() || address.isNull()) {
                continue;
            }
            String provider = address.path("provider").asText();
            assertTrue(presets.containsKey(provider), "unknown provider " + provider);
            assertEquals(presets.get(provider), address.path("url").asText(),
                    "step " + s.path("id").asText() + " prints another address than the preset");
            seen.add(provider);
        }
        assertEquals(presets.keySet(), seen, "every local provider's address is on the page");

        String llamaPort = presets.get("llamacpp").replaceAll(".*:(\\d+)$", "$1");
        int servers = 0;
        for (String text : allCommandTexts()) {
            for (String line : text.split("\n")) {
                if (line.startsWith("llama-server")) {
                    servers++;
                    assertTrue(line.contains("--port " + llamaPort),
                            "llama-server defaults to another port on current builds; name it: " + line);
                }
            }
        }
        assertTrue(servers > 0, "no llama-server command on the page");
    }

    @Test
    void everyProbeNamesARouteAControllerMaps() throws Exception {
        Set<String> routes = mappedGetRoutes();
        assertTrue(routes.contains("/api/health"), "the scan found no routes: " + routes.size());
        int probes = 0;
        for (JsonNode s : doc().path("steps")) {
            JsonNode probe = s.path("probe");
            if (probe.isNull() || probe.isMissingNode()) {
                continue;
            }
            probes++;
            String route = probe.path("route").asText();
            assertTrue(routes.contains(route),
                    "step " + s.path("id").asText() + " probes " + route + ", which no controller maps");
        }
        assertTrue(probes > 0, "no step names a probe");
    }

    private static Set<String> mappedGetRoutes() throws ClassNotFoundException {
        var scanner = new ClassPathScanningCandidateComponentProvider(false);
        scanner.addIncludeFilter(new AnnotationTypeFilter(Controller.class));
        Set<String> routes = new TreeSet<>();
        for (BeanDefinition bean : scanner.findCandidateComponents("dev.spectroscope.server")) {
            Class<?> type = Class.forName(bean.getBeanClassName());
            RequestMapping base = AnnotatedElementUtils.findMergedAnnotation(type, RequestMapping.class);
            String[] prefixes = base == null || base.path().length == 0 ? new String[] {""} : base.path();
            for (Method m : type.getDeclaredMethods()) {
                RequestMapping rm = AnnotatedElementUtils.findMergedAnnotation(m, RequestMapping.class);
                if (rm == null) {
                    continue;
                }
                boolean get = rm.method().length == 0
                        || List.of(rm.method()).contains(RequestMethod.GET);
                if (!get) {
                    continue;
                }
                String[] paths = rm.path().length == 0 ? new String[] {""} : rm.path();
                for (String prefix : prefixes) {
                    for (String path : paths) {
                        routes.add(prefix + path);
                    }
                }
            }
        }
        return routes;
    }

    @Test
    void everyShotHasAPlateInBothDesigns() throws IOException {
        int shots = 0;
        for (JsonNode s : doc().path("steps")) {
            for (JsonNode shot : s.path("shots")) {
                shots++;
                for (String folder : List.of("shots", "shots-light")) {
                    Path plate = ROOT.resolve("docs/local-setup/" + folder + "/" + shot.asText() + ".png");
                    assertTrue(Files.isRegularFile(plate), "missing plate " + plate);
                    String bytes = new String(Files.readAllBytes(plate), StandardCharsets.ISO_8859_1);
                    if (bytes.contains(PLACEHOLDER_MARK)) {
                        String note = "placeholder plate, card 536 captures it: " + folder + "/" + shot.asText();
                        if (PLACEHOLDERS_FAIL) {
                            fail(note);
                        }
                        System.err.println("WARN " + note);
                    }
                }
            }
        }
        assertTrue(shots > 0, "no step names a plate");
    }

    @Test
    void theCopiedScriptsAreTheProductsOwn() throws IOException {
        Map<String, String> copies = Map.of(
                "setup-stt.sh", "scripts/setup-stt.sh",
                "setup-tts.sh", "scripts/setup-tts.sh",
                "install-searxng.sh", "samples/09-searxng/install.sh",
                "docker-compose.yml", "samples/09-searxng/docker-compose.yml");
        for (var e : copies.entrySet()) {
            Path copy = SCRIPTS.resolve(e.getKey());
            assertTrue(Files.isRegularFile(copy), "missing " + copy + "; run build_local_setup.py");
            assertArrayEquals(Files.readAllBytes(ROOT.resolve(e.getValue())), Files.readAllBytes(copy),
                    e.getKey() + " differs from " + e.getValue() + "; run build_local_setup.py");
        }
    }

    @Test
    void everyGeneratedScriptCarriesItsStepsCommands() throws IOException {
        int generated = 0;
        for (JsonNode s : doc().path("steps")) {
            if (!"generate".equals(s.path("script").asText())) {
                continue;
            }
            var platforms = s.path("commands").fields();
            while (platforms.hasNext()) {
                var e = platforms.next();
                Path file = SCRIPTS.resolve(e.getKey() + "-step-" + s.path("id").asText().replace('.', '-') + ".sh");
                boolean anyScriptLine = false;
                for (JsonNode c : e.getValue()) {
                    anyScriptLine |= c.path("script").asBoolean(true);
                }
                if (!anyScriptLine) {
                    assertFalse(Files.exists(file), file.getFileName() + ": no line of the step belongs in a script");
                    continue;
                }
                assertTrue(Files.isRegularFile(file), "missing " + file + "; run build_local_setup.py");
                String text = Files.readString(file);
                int cut = text.indexOf("\n\n");
                assertTrue(cut > 0, "no preamble in " + file);
                assertTrue(text.substring(0, cut).contains("set -euo pipefail"), file.toString());
                StringBuilder body = new StringBuilder();
                for (JsonNode c : e.getValue()) {
                    if (c.path("script").asBoolean(true)) {
                        body.append(c.path("text").asText()).append('\n');
                    }
                }
                assertEquals(body.toString(), text.substring(cut + 2),
                        file.getFileName() + " lags steps.json; run build_local_setup.py");
                generated++;
            }
        }
        assertTrue(generated > 0, "no generated script");
    }

    /** Every {@code P:} source in the data file, in order of appearance. */
    private static List<String> productSources() throws IOException {
        List<String> out = new ArrayList<>();
        collectSources(doc(), null, out);
        out.removeIf(s -> !s.startsWith("P:"));
        return out;
    }

    private static void collectSources(JsonNode node, String key, List<String> out) {
        if (node.isObject()) {
            node.fields().forEachRemaining(e -> collectSources(e.getValue(), e.getKey(), out));
        } else if (node.isArray()) {
            node.forEach(n -> collectSources(n, key, out));
        } else if ("source".equals(key) && node.isTextual()) {
            out.add(node.asText());
        }
    }

    @Test
    void everyProductSourceNamesATextItsFileStillHolds() throws IOException {
        List<String> sources = productSources();
        assertTrue(sources.size() > 30, "only " + sources.size() + " product sources found");
        Pattern shape = Pattern.compile("^P:([^:]+)(?:::(.{1,48}))?$");
        for (String src : sources) {
            Matcher m = shape.matcher(src);
            assertTrue(m.matches(), "a product source is P:<path> or P:<path>::<text of 48 characters or less>: " + src);
            Path file = ROOT.resolve(m.group(1));
            assertTrue(Files.isRegularFile(file), src + " names no file");
            if (m.group(2) != null) {
                assertTrue(Files.readString(file).contains(m.group(2)),
                        m.group(1) + " no longer contains \"" + m.group(2) + "\"; fix the citation in steps.json and rebuild");
            }
        }
    }

    /**
     * The files the page is built from, by the rule build_local_setup.py
     * applies in {@code input_files}: five fixed files, every file in site/,
     * shots/ and shots-light/, and every product file a step copies.
     */
    static List<Path> inputFiles() throws IOException {
        Set<Path> files = new TreeSet<>((a, b) -> rel(a).compareTo(rel(b)));
        for (String name : List.of("build_local_setup.py", "steps.json", "steps.schema.json", "page.css", "page.js")) {
            files.add(LOCAL_SETUP.resolve(name));
        }
        for (String folder : List.of("site", "shots", "shots-light")) {
            try (Stream<Path> walk = Files.walk(LOCAL_SETUP.resolve(folder))) {
                walk.filter(Files::isRegularFile)
                        .filter(p -> !p.getFileName().toString().startsWith("."))
                        .forEach(files::add);
            }
        }
        for (JsonNode s : doc().path("steps")) {
            for (JsonNode copy : s.path("script").path("copy")) {
                files.add(ROOT.resolve(copy.path("from").asText()));
            }
        }
        return new ArrayList<>(files);
    }

    private static String rel(Path p) {
        return ROOT.relativize(p).toString().replace('\\', '/');
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static String inputDigest() throws IOException {
        StringBuilder lines = new StringBuilder();
        for (Path file : inputFiles()) {
            lines.append(rel(file)).append('\t').append(sha256(Files.readAllBytes(file))).append('\n');
        }
        return sha256(lines.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static final Pattern STAMP = Pattern.compile(
            "(?m)^<meta name=\"spectroscope:build\" content=\"inputs=([0-9a-f]{64}) page=([0-9a-f]{64})\">\\n");

    @Test
    void thePageIsBuiltFromTheInputsInTheTreeAndNotEditedByHand() throws IOException {
        assertTrue(Files.isRegularFile(PAGE), "missing " + PAGE);
        String page = Files.readString(PAGE);
        Matcher m = STAMP.matcher(page);
        assertTrue(m.find(), "docs/local-setup/index.html carries no build stamp; run build_local_setup.py");
        assertEquals(inputDigest(), m.group(1),
                "an input of docs/local-setup/index.html changed since it was built; run"
                        + " python3 docs/local-setup/build_local_setup.py");
        String rest = page.substring(0, m.start()) + page.substring(m.end());
        assertEquals(sha256(rest.getBytes(StandardCharsets.UTF_8)), m.group(2),
                "docs/local-setup/index.html was edited after the build; edit steps.json and rebuild");
    }

    @Test
    void thePageSourceCarriesNoDashAndNoInternalNote() throws IOException {
        String page = Files.readString(PAGE).replaceAll("data:[a-z/+]+;base64,[A-Za-z0-9+/=]+", "data:");
        assertFalse(page.contains("\u2014"), "an em dash in docs/local-setup/index.html");
        assertFalse(page.contains("\u2013"), "an en dash in docs/local-setup/index.html");
        assertFalse(page.contains("color-study"), "an internal design note in docs/local-setup/index.html");
        assertFalse(Pattern.compile("owner (?:trial )?\\d{4}-\\d{2}").matcher(page).find(),
                "an owner note in docs/local-setup/index.html");
    }

    private static int[] versionParts(String version) {
        String[] parts = version.split("\\.");
        int[] out = new int[parts.length];
        for (int i = 0; i < parts.length; i++) {
            out[i] = Integer.parseInt(parts[i]);
        }
        return out;
    }

    /**
     * The footer prints {@code page.version} of steps.json, a literal the
     * release preparation sets like the versions in README.md. tag.yml bumps
     * the build files after the page is built, so the page may be one release
     * ahead of {@code spectro-server/build.gradle.kts} (the preparation) or
     * equal to it (after the bump), never behind.
     */
    @Test
    void theFooterPrintsTheDataFilesVersionAndItIsNotBehindTheBuild() throws IOException {
        String version = doc().path("page").path("version").asText("");
        assertTrue(version.matches("\\d+\\.\\d+\\.\\d+"), "steps.json has no page.version: '" + version + "'");
        String page = Files.readString(PAGE);
        Matcher footer = Pattern.compile("<footer[^>]*>\\s*<p>spectroscope (\\d+\\.\\d+\\.\\d+)\\. ").matcher(page);
        assertTrue(footer.find(), "the footer prints no product version");
        assertEquals(version, footer.group(1), "the footer does not print steps.json page.version; rebuild the page");
        Matcher gradle = Pattern.compile("(?m)^version = \"([^\"]+)\"")
                .matcher(Files.readString(ROOT.resolve("spectro-server/build.gradle.kts")));
        assertTrue(gradle.find(), "spectro-server/build.gradle.kts declares no version");
        assertTrue(java.util.Arrays.compare(versionParts(version), versionParts(gradle.group(1))) >= 0,
                "the page prints " + version + ", behind the build's " + gradle.group(1)
                        + "; set page.version in steps.json in the release preparation and rebuild");
    }

    private static final Pattern PORT = Pattern.compile("(?:localhost|127\\.0\\.0\\.1):(\\d+)|--port (\\d+)");

    private static List<String> textsOf(JsonNode step) {
        List<String> out = new ArrayList<>();
        step.path("commands").forEach(cs -> cs.forEach(c -> {
            out.add(c.path("text").asText(""));
            out.add(c.path("label").asText(""));
        }));
        step.path("check").forEach(c -> {
            out.add(c.path("text").asText(""));
            out.add(c.path("expect").asText(""));
        });
        for (String group : List.of("notes", "vendor", "links")) {
            step.path(group).forEach(items -> items.forEach(i -> {
                for (String key : List.of("text", "says", "label", "url")) {
                    out.add(i.path(key).asText(""));
                }
            }));
        }
        return out;
    }

    @Test
    void everyPortAProviderStepPrintsIsThePresetsPort() throws IOException {
        Map<String, String> presets = Map.of(
                "ollama", SpectroConfig.effectiveOllamaBaseUrl(null, null),
                "lmstudio", SpectroConfig.effectiveLmstudioBaseUrl(null, null),
                "llamacpp", SpectroConfig.effectiveLlamacppBaseUrl(null, null));
        Map<String, Integer> hits = new java.util.TreeMap<>();
        for (JsonNode s : doc().path("steps")) {
            String provider = s.path("address").path("provider").asText("");
            if (!presets.containsKey(provider)) {
                continue;
            }
            String want = presets.get(provider).replaceAll(".*:(\\d+)$", "$1");
            for (String text : textsOf(s)) {
                Matcher m = PORT.matcher(text);
                while (m.find()) {
                    String port = m.group(1) != null ? m.group(1) : m.group(2);
                    assertEquals(want, port, "step " + s.path("id").asText() + " prints port " + port
                            + " in '" + text + "'; the " + provider + " preset is " + presets.get(provider));
                    hits.merge(provider, 1, Integer::sum);
                }
            }
        }
        assertTrue(hits.getOrDefault("lmstudio", 0) > 0, "the LM Studio step names no port: " + hits);
        assertTrue(hits.getOrDefault("llamacpp", 0) > 0, "the llama.cpp step names no port: " + hits);
    }

    @Test
    void everyBrewLineNeedsHomebrewAndEveryCloneNeedsGit() throws IOException {
        JsonNode needs = doc().path("page").path("needs");
        assertTrue(needs.has("homebrew") && needs.has("git"), "steps.json page.needs lacks homebrew or git");
        int brew = 0;
        for (JsonNode s : doc().path("steps")) {
            var platforms = s.path("commands").fields();
            while (platforms.hasNext()) {
                var e = platforms.next();
                for (JsonNode c : e.getValue()) {
                    List<String> named = new ArrayList<>();
                    c.path("needs").forEach(n -> named.add(n.asText()));
                    String where = "step " + s.path("id").asText() + " " + e.getKey() + ": " + c.path("text").asText();
                    for (String line : c.path("text").asText().split("\n")) {
                        if (line.startsWith("brew ")) {
                            brew++;
                            assertFalse("linux".equals(e.getKey()), "a Homebrew line on Linux, " + where);
                            assertTrue(named.contains("homebrew"), "a brew line that does not name Homebrew, " + where);
                        }
                        if (line.startsWith("git clone")) {
                            assertTrue(named.contains("git"), "a clone that does not name git, " + where);
                        }
                    }
                }
            }
            for (JsonNode copy : s.path("script").path("copy")) {
                if (Files.readString(ROOT.resolve(copy.path("from").asText())).contains("command -v brew")) {
                    for (JsonNode c : s.path("commands").path("mac")) {
                        List<String> named = new ArrayList<>();
                        c.path("needs").forEach(n -> named.add(n.asText()));
                        assertTrue(named.contains("homebrew"), "step " + s.path("id").asText()
                                + " runs " + copy.path("from").asText() + ", which stops without Homebrew");
                    }
                }
            }
        }
        assertTrue(brew > 5, "only " + brew + " brew lines found");
    }

    /**
     * Round 3: the tracked page is {@code docs/local-setup/index.html} with
     * {@code scripts/} beside it, the layout the website and the jar serve,
     * so every script link resolves where the page is tracked.
     */
    @Test
    void theTrackedPageSitsBesideItsScriptsAndTheOldPlaceIsGone() throws IOException {
        assertFalse(Files.exists(ROOT.resolve("docs/LOCAL-SETUP.html")), "docs/LOCAL-SETUP.html is the old place");
        Matcher m = Pattern.compile("<a class=\"dl\" href=\"(scripts/[^\"]+)\"").matcher(Files.readString(PAGE));
        int links = 0;
        while (m.find()) {
            links++;
            assertTrue(Files.isRegularFile(PAGE.getParent().resolve(m.group(1))),
                    m.group(1) + " does not resolve beside " + rel(PAGE));
        }
        assertTrue(links > 10, "only " + links + " script links");
    }

    /** Round 3: the website and the app offer the SearXNG script under one name. */
    @Test
    void theSearxngScriptHasTheNameTheAppServes() throws IOException {
        String served = LocalSetupScriptController.ROUTE.substring(LocalSetupScriptController.ROUTE.lastIndexOf('/') + 1);
        String name = null;
        for (JsonNode copy : step("4.2").path("script").path("copy")) {
            if ("samples/09-searxng/install.sh".equals(copy.path("from").asText())) {
                name = copy.path("to").asText();
            }
        }
        assertEquals(served, name, "the page names the SearXNG script differently from the app");
        assertTrue(Files.isRegularFile(SCRIPTS.resolve(served)), "missing scripts/" + served);
        assertTrue(Files.isRegularFile(SCRIPTS.resolve("docker-compose.yml")), "the compose file is not beside the script");
        for (String platform : List.of("mac", "linux")) {
            List<String> lines = commandTexts(step("4.2"), platform);
            assertEquals("bash " + served, lines.get(lines.size() - 1), platform);
        }
    }

    /** Round 3: a size line names its platforms; a disk image is for macOS only. */
    @Test
    void aSizeLineIsForPlatformsTheStepCoversAndADiskImageIsMacOnly() throws IOException {
        int dmg = 0;
        for (JsonNode s : doc().path("steps")) {
            Set<String> covered = new TreeSet<>();
            s.path("platforms").forEach(p -> covered.add(p.asText()));
            for (JsonNode size : s.path("size")) {
                Set<String> on = new TreeSet<>();
                size.path("platforms").forEach(p -> on.add(p.asText()));
                String where = "step " + s.path("id").asText() + " size '" + size.path("text").asText() + "'";
                assertFalse(on.isEmpty(), where + " names no platforms");
                assertTrue(covered.containsAll(on), where + " is for a platform the step does not cover");
                if (size.path("text").asText().contains(".dmg")) {
                    dmg++;
                    assertEquals(Set.of("mac"), on, where);
                }
            }
        }
        assertEquals(2, dmg, "Ollama.dmg and Docker.dmg");
    }

    /** Round 3: a build line names cmake and a compiler, an ollama line names Ollama. */
    @Test
    void cmakeLinesNameBuildToolsAndOllamaLinesNameOllama() throws IOException {
        int cmake = 0;
        int ollama = 0;
        for (JsonNode s : doc().path("steps")) {
            var platforms = s.path("commands").fields();
            while (platforms.hasNext()) {
                var e = platforms.next();
                boolean installed = false;
                for (JsonNode c : e.getValue()) {
                    List<String> named = new ArrayList<>();
                    c.path("needs").forEach(n -> named.add(n.asText()));
                    String where = "step " + s.path("id").asText() + " " + e.getKey() + ": " + c.path("text").asText();
                    for (String line : c.path("text").asText().split("\n")) {
                        if (line.startsWith("cmake ")) {
                            cmake++;
                            assertTrue(named.contains("build-tools"), "a cmake line that does not name its tools, " + where);
                        }
                        if (line.startsWith("ollama ") && !installed) {
                            ollama++;
                            assertTrue(named.contains("ollama"), "an ollama line that does not name Ollama, " + where);
                        }
                    }
                    installed |= c.path("text").asText().startsWith("brew install ollama");
                }
            }
        }
        assertEquals(2, cmake);
        assertTrue(ollama > 0, "no ollama line without an install before it");
    }
}
