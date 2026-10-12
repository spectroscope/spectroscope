package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.playbook.Finding;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 522: the four routes that open a registered playbook folder to the app
 * as a tree of text files. Driven directly with mock requests, like
 * {@link PlaybookFileRouteTest}.
 */
class PlaybookFilesRouteTest {

    private static final int MB = 1024 * 1024;

    @TempDir Path tmp;

    private final ObjectMapper mapper = new ObjectMapper();
    private PlaybookFolders folders;
    private PlaybookController controller;
    private Path dir;
    private Path userSettings;
    private Path spectroHome;

    /** The MINIMAL playbook with one agent file in its contents, so a delete can make a finding. */
    private static final String WITH_AGENT = PlaybookLoaderTest.MINIMAL.replace(
            "\"contents\": { \"skills\": [\"skills/spectropowers\"] }",
            "\"contents\": { \"skills\": [\"skills/spectropowers\"], \"agents\": [\"agents/reviewer.md\"] }");

    @BeforeEach
    void setUp() throws IOException {
        folders = new PlaybookFolders(tmp.resolve("playbooks.json"));
        spectroHome = tmp.resolve("home/.spectro");
        userSettings = spectroHome.resolve("settings.json");
        controller = new PlaybookController(folders, PlaybookController.BUNDLE_ROOT,
                new InstallLedger(tmp.resolve("home/playbook-installs.json")), spectroHome,
                Files.createDirectories(tmp.resolve("launch")), userSettings);
        assertTrue(WITH_AGENT.contains("agents/reviewer.md"), "premise: the fixture names the agent file");
        dir = Files.createDirectories(tmp.resolve("pb"));
        Files.writeString(dir.resolve("playbook.json"), WITH_AGENT);
        write("skills/spectropowers/brainstorming/SKILL.md", "---\nname: brainstorming\ndescription: d\n---\nbody\n");
        write("agents/reviewer.md", "a reviewer\n");
        write("templates/spec.md", "# Goal\n");
        write("LICENSE", "MIT\n");
        write("PROVENANCE.md", "made here\n");
        folders.register(dir);
    }

    private Path write(String rel, String text) throws IOException {
        Path file = dir.resolve(rel);
        Files.createDirectories(file.getParent());
        return Files.writeString(file, text);
    }

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    private static MockHttpServletRequest foreign() {
        MockHttpServletRequest remote = new MockHttpServletRequest();
        remote.setRemoteAddr("203.0.113.7");
        return remote;
    }

    private static MockHttpServletRequest crossSite() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("Origin", "http://evil.example");
        return request;
    }

    private JsonNode json(ResponseEntity<?> response) {
        return mapper.valueToTree(response.getBody());
    }

    private String writeBody(String path, String text, String baseHash) {
        ObjectNode body = mapper.createObjectNode().put("dir", dir.toString()).put("path", path).put("text", text);
        if (baseHash != null) {
            body.put("baseHash", baseHash);
        }
        return body.toString();
    }

    private ResponseEntity<?> put(String path, String text, String baseHash) {
        return controller.writeFile(writeBody(path, text, baseHash), local());
    }

    private String hashOf(String rel) throws IOException {
        return EditorView.sha256(Files.readAllBytes(dir.resolve(rel)));
    }

    private static List<String> paths(List<?> nodes, ObjectMapper mapper) {
        List<String> out = new ArrayList<>();
        for (Object node : nodes) {
            JsonNode n = mapper.valueToTree(node);
            out.add((n.path("dir").asBoolean() ? "d " : "f ") + n.path("path").asText());
            out.addAll(paths(mapper.convertValue(n.path("children"), List.class), mapper));
        }
        return out;
    }

    private List<String> treePaths(ResponseEntity<?> response) {
        return paths(mapper.convertValue(json(response).path("entries"), List.class), mapper);
    }

    private List<String> tempFiles() throws IOException {
        try (Stream<Path> walk = Files.walk(dir)) {
            return walk.map(p -> p.getFileName().toString()).filter(n -> n.endsWith(".tmp")).toList();
        }
    }

    private boolean linked(Path link, Path target) {
        try {
            Files.createSymbolicLink(link, target);
            return true;
        } catch (IOException | UnsupportedOperationException refused) {
            return false;
        }
    }

    private static void assertBlank404(ResponseEntity<?> response) {
        assertEquals(404, response.getStatusCode().value());
        assertNull(response.getBody(), "a refusal echoes nothing: " + response.getBody());
    }

    // The scenario.

    @Test
    void theTreeOfTheSpectroCopyReadsWritesAndFencesTheHash() throws Exception {
        Path target = Files.createDirectories(tmp.resolve("work/mine"));
        ResponseEntity<?> copied = controller.copy("spectro",
                mapper.createObjectNode().put("dir", target.toString()), local());
        assertEquals(200, copied.getStatusCode().value(), String.valueOf(copied.getBody()));
        String root = String.valueOf(((Map<?, ?>) copied.getBody()).get("dir"));

        ResponseEntity<?> tree = controller.tree(root, local());
        assertEquals(200, tree.getStatusCode().value());
        List<String> top = new ArrayList<>();
        json(tree).path("entries").forEach(n -> top.add(n.path("name").asText()));
        assertTrue(top.containsAll(List.of("playbook.json", "templates", "skills", "docs", "LICENSE", "PROVENANCE.md")),
                top.toString());
        assertTrue(treePaths(tree).contains("f skills/spectropowers/brainstorming/SKILL.md"), treePaths(tree).toString());
        assertFalse(json(tree).path("truncated").asBoolean(true), "the tree lists the whole pack");
        List<String> onDisk;
        try (Stream<Path> walk = Files.walk(Path.of(root))) {
            onDisk = walk.filter(Files::isRegularFile)
                    .map(p -> "f " + Path.of(root).relativize(p).toString().replace('\\', '/')).sorted().toList();
        }
        assertTrue(onDisk.stream().anyMatch(p -> p.split("/").length == 5), "premise: the pack has depth 5 files");
        assertEquals(onDisk, treePaths(tree).stream().filter(p -> p.startsWith("f ")).sorted().toList());

        String five = "skills/spectropowers/using-spectropowers/references/codex-tools.md";
        ResponseEntity<?> readFive = controller.readFile(root, five, local());
        assertEquals(200, readFive.getStatusCode().value());
        ObjectNode fiveBody = mapper.createObjectNode().put("dir", root).put("path", five)
                .put("text", json(readFive).path("text").asText() + "\nA line.\n")
                .put("baseHash", json(readFive).path("sha256").asText());
        assertEquals(200, controller.writeFile(fiveBody.toString(), local()).getStatusCode().value());
        assertTrue(Files.readString(Path.of(root, five)).endsWith("\nA line.\n"));

        String rel = "skills/spectropowers/brainstorming/SKILL.md";
        ResponseEntity<?> read = controller.readFile(root, rel, local());
        assertEquals(200, read.getStatusCode().value());
        String text = json(read).path("text").asText();
        String hash = json(read).path("sha256").asText();
        assertEquals(EditorView.sha256(Files.readAllBytes(Path.of(root, rel))), hash);
        assertEquals(Files.readString(Path.of(root, rel)), text);

        String edited = text + "\nOne more line.\n";
        ObjectNode body = mapper.createObjectNode().put("dir", root).put("path", rel).put("text", edited)
                .put("baseHash", hash);
        ResponseEntity<?> saved = controller.writeFile(body.toString(), local());
        assertEquals(200, saved.getStatusCode().value(), String.valueOf(saved.getBody()));
        assertEquals(edited, Files.readString(Path.of(root, rel)));
        assertEquals(EditorView.sha256(edited.getBytes(StandardCharsets.UTF_8)), json(saved).path("sha256").asText());

        ResponseEntity<?> stale = controller.writeFile(body.put("text", "lost").toString(), local());
        assertEquals(409, stale.getStatusCode().value());
        assertEquals(EditorView.sha256(edited.getBytes(StandardCharsets.UTF_8)), json(stale).path("diskHash").asText());
        assertEquals(edited, Files.readString(Path.of(root, rel)));
    }

    // Criterion 1: the tree.

    @Test
    void treeAnswersTheFileNodeShapeTheFilesPanelReads() throws Exception {
        ResponseEntity<?> tree = controller.tree(dir.toString(), local());

        assertEquals(200, tree.getStatusCode().value());
        JsonNode body = json(tree);
        assertFalse(body.path("truncated").asBoolean(true));
        JsonNode first = body.path("entries").get(0);
        assertEquals("agents", first.path("name").asText(), "folders come first: " + body);
        assertTrue(first.path("dir").asBoolean());
        JsonNode reviewer = first.path("children").get(0);
        assertEquals("reviewer.md", reviewer.path("name").asText());
        assertEquals("agents/reviewer.md", reviewer.path("path").asText());
        assertFalse(reviewer.path("dir").asBoolean());
        assertEquals(Files.size(dir.resolve("agents/reviewer.md")), reviewer.path("size").asLong());
        assertTrue(reviewer.path("children").isArray());
        assertTrue(treePaths(tree).containsAll(List.of("f playbook.json", "f LICENSE", "f PROVENANCE.md",
                "f templates/spec.md", "f skills/spectropowers/brainstorming/SKILL.md")), treePaths(tree).toString());
    }

    @Test
    void treeListsALinkAsAFindingAndNotAsAnEntry() throws Exception {
        Path outside = Files.writeString(tmp.resolve("secret.txt"), "do not list");
        assumeTrue(linked(dir.resolve("templates/notes.md"), outside), "the file system refuses links");

        ResponseEntity<?> tree = controller.tree(dir.toString(), local());

        assertFalse(treePaths(tree).contains("f templates/notes.md"), treePaths(tree).toString());
        List<String> findings = new ArrayList<>();
        json(tree).path("findings").forEach(f -> findings.add(f.path("path").asText() + " " + f.path("message").asText()));
        assertEquals(List.of("templates/notes.md a symbolic link"), findings);
    }

    @Test
    void treeStopsAtTheLoadersFileCountAndDepthAndSaysSo() throws Exception {
        for (int i = 0; i < PlaybookLoader.MAX_FILES; i++) {
            write("docs/n" + i + ".md", "x");
        }

        ResponseEntity<?> tree = controller.tree(dir.toString(), local());

        long files = treePaths(tree).stream().filter(p -> p.startsWith("f ")).count();
        assertEquals(PlaybookLoader.MAX_FILES, files);
        assertTrue(json(tree).path("truncated").asBoolean());
        assertTrue(json(tree).path("capped").asBoolean(), "the tree says the file count stopped it");
    }

    @Test
    void theLoaderWalksSixLevels() {
        assertEquals(6, PlaybookLoader.WALK_DEPTH, "card 525's fix round raised the walk from 4 to 6");
    }

    @Test
    void treeStopsAtTheLoadersDepth() throws Exception {
        write("skills/spectropowers/brainstorming/scripts/a/b/run.sh", "echo\n");

        ResponseEntity<?> tree = controller.tree(dir.toString(), local());

        assertTrue(treePaths(tree).contains("d skills/spectropowers/brainstorming/scripts/a/b"), treePaths(tree).toString());
        assertFalse(treePaths(tree).stream().anyMatch(p -> p.endsWith("run.sh")), treePaths(tree).toString());
        assertTrue(json(tree).path("truncated").asBoolean());
        assertFalse(json(tree).path("capped").asBoolean(true));
        List<String> deeper = new ArrayList<>();
        json(tree).path("deeper").forEach(n -> deeper.add(n.asText()));
        assertEquals(List.of("skills/spectropowers/brainstorming/scripts/a/b"), deeper,
                "the tree names the folder at the limit that holds more");
    }

    @Test
    void treeListsAFileAtTheLoadersDepth() throws Exception {
        write("skills/spectropowers/brainstorming/scripts/a/run.sh", "echo\n");

        ResponseEntity<?> tree = controller.tree(dir.toString(), local());

        assertTrue(treePaths(tree).contains("f skills/spectropowers/brainstorming/scripts/a/run.sh"),
                treePaths(tree).toString());
        assertFalse(json(tree).path("truncated").asBoolean(true));
        assertEquals(0, json(tree).path("deeper").size());
    }

    @Test
    void aWholeTreeSaysItIsNeitherCappedNorDeeper() throws Exception {
        JsonNode body = json(controller.tree(dir.toString(), local()));

        assertTrue(body.path("capped").isBoolean(), body.toString());
        assertFalse(body.path("capped").asBoolean());
        assertTrue(body.path("deeper").isArray(), body.toString());
        assertEquals(0, body.path("deeper").size());
    }

    @Test
    void readAndWriteServeAFileAtDepthSixAndHideOneAtDepthSeven() throws Exception {
        String six = "skills/spectropowers/brainstorming/scripts/a/run.sh";
        write(six, "echo six\n");
        write("skills/spectropowers/brainstorming/scripts/a/b/run.sh", "echo seven\n");

        ResponseEntity<?> read = controller.readFile(dir.toString(), six, local());
        assertEquals(200, read.getStatusCode().value());
        assertEquals("echo six\n", json(read).path("text").asText());
        ResponseEntity<?> saved = put(six, "echo 6\n", hashOf(six));
        assertEquals(200, saved.getStatusCode().value(), String.valueOf(saved.getBody()));
        assertEquals("echo 6\n", Files.readString(dir.resolve(six)));

        assertBlank404(controller.readFile(dir.toString(), "skills/spectropowers/brainstorming/scripts/a/b/run.sh",
                local()));
    }

    @Test
    void theDepthSentencesNameTheLoadersDepth() throws Exception {
        Map<Integer, String[]> words = Map.of(6, new String[] {"six", "sechs"});
        String[] word = words.get(PlaybookLoader.WALK_DEPTH);
        assertTrue(word != null, "no number word for the walk depth " + PlaybookLoader.WALK_DEPTH);
        ResponseEntity<?> deep = put("a/b/c/d/e/f/g.md", "x", "");
        assertEquals("too-deep", json(deep).path("reason").asText());
        assertTrue(json(deep).path("message").asText().contains(PlaybookLoader.WALK_DEPTH + " levels"),
                json(deep).toString());
        String i18n = webStrings();
        assumeTrue(i18n != null, "not running from a source checkout");
        for (String key : List.of("pbb.truncated", "pbb.reason.too-deep")) {
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"" + java.util.regex.Pattern.quote(key)
                    + "\":\\s*\\{\\s*de:\\s*\"((?:[^\"\\\\]|\\\\.)*)\",\\s*en:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")
                    .matcher(i18n);
            assertTrue(m.find(), "no strings for " + key);
            assertTrue(m.group(1).contains(word[1] + " Ebenen"), key + " de: " + m.group(1));
            assertTrue(m.group(2).contains(word[0] + " levels"), key + " en: " + m.group(2));
        }
    }

    /** The web strings, or null outside a source checkout. */
    private static String webStrings() throws IOException {
        for (Path at = Path.of("").toAbsolutePath(); at != null; at = at.getParent()) {
            Path i18n = at.resolve("spectro-web/src/i18n/i18n.ts");
            if (Files.isRegularFile(at.resolve("settings.gradle.kts")) && Files.isRegularFile(i18n)) {
                return Files.readString(i18n);
            }
        }
        return null;
    }

    @Test
    void treeOfAnUnregisteredFolderIs404WithoutThePath() throws Exception {
        Path stranger = Files.createDirectories(tmp.resolve("stranger"));
        Files.writeString(stranger.resolve("playbook.json"), WITH_AGENT);

        assertBlank404(controller.tree(stranger.toString(), local()));
        assertBlank404(controller.tree(dir.resolve("skills").toString(), local()));
        assertBlank404(controller.tree("", local()));
    }

    @Test
    void treeForAForeignCallerIs404() {
        assertBlank404(controller.tree(dir.toString(), foreign()));
        assertBlank404(controller.tree(dir.toString(), crossSite()));
    }

    // Criterion 2: the read.

    @Test
    void readAnswersTheTextAndItsHash() throws Exception {
        ResponseEntity<?> read = controller.readFile(dir.toString(), "templates/spec.md", local());

        assertEquals(200, read.getStatusCode().value());
        assertEquals("# Goal\n", json(read).path("text").asText());
        assertEquals(hashOf("templates/spec.md"), json(read).path("sha256").asText());
        assertEquals("templates/spec.md", json(read).path("path").asText());
    }

    @Test
    void readOfAFileWithANulByteInTheFirst8kIs415() throws Exception {
        byte[] bytes = new byte[100];
        bytes[50] = 0;
        Files.write(dir.resolve("templates/logo.png"), bytes);

        ResponseEntity<?> read = controller.readFile(dir.toString(), "templates/logo.png", local());

        assertEquals(415, read.getStatusCode().value());
        assertEquals("binary", json(read).path("reason").asText());
        assertFalse(json(read).path("message").asText().isBlank());
    }

    @Test
    void readOfAFileWithANulByteOnlyAfter8kIsText() throws Exception {
        byte[] bytes = new byte[9000];
        java.util.Arrays.fill(bytes, (byte) 'a');
        bytes[8500] = 0;
        Files.write(dir.resolve("templates/late.md"), bytes);

        assertEquals(200, controller.readFile(dir.toString(), "templates/late.md", local()).getStatusCode().value());
    }

    @Test
    void readOfAFileThatIsNotUtf8Is415() throws Exception {
        Files.write(dir.resolve("templates/latin.md"), new byte[] {'a', (byte) 0xE4, 'b'});

        ResponseEntity<?> read = controller.readFile(dir.toString(), "templates/latin.md", local());

        assertEquals(415, read.getStatusCode().value());
    }

    @Test
    void readOfAFileOver1MbIs413() throws Exception {
        Files.writeString(dir.resolve("docs-big.md"), "x".repeat(MB + 1));

        ResponseEntity<?> read = controller.readFile(dir.toString(), "docs-big.md", local());

        assertEquals(413, read.getStatusCode().value());
        assertEquals("too-large", json(read).path("reason").asText());
        assertEquals(200, controller.readFile(dir.toString(), "LICENSE", local()).getStatusCode().value());
    }

    @Test
    void readRefusesDotDot() throws Exception {
        Files.writeString(tmp.resolve("secret.txt"), "secret");
        assertBlank404(controller.readFile(dir.toString(), "../secret.txt", local()));
        assertBlank404(controller.readFile(dir.toString(), "templates/../../secret.txt", local()));
        assertBlank404(controller.readFile(dir.toString(), "templates/../LICENSE", local()));
    }

    @Test
    void readRefusesAnAbsolutePath() throws Exception {
        Path secret = Files.writeString(tmp.resolve("secret.txt"), "secret");
        assertBlank404(controller.readFile(dir.toString(), secret.toString(), local()));
        assertBlank404(controller.readFile(dir.toString(), dir.resolve("LICENSE").toString(), local()));
        assertBlank404(controller.readFile(dir.toString(), "/LICENSE", local()));
    }

    @Test
    void readRefusesASymbolicLink() throws Exception {
        Path secret = Files.writeString(tmp.resolve("secret.txt"), "secret");
        assumeTrue(linked(dir.resolve("templates/secret.md"), secret), "the file system refuses links");
        assumeTrue(linked(dir.resolve("templates/inner.md"), dir.resolve("LICENSE")), "the file system refuses links");

        assertBlank404(controller.readFile(dir.toString(), "templates/secret.md", local()));
        assertBlank404(controller.readFile(dir.toString(), "templates/inner.md", local()));
    }

    @Test
    void readRefusesAFileBehindALinkedFolder() throws Exception {
        Path elsewhere = Files.createDirectories(tmp.resolve("elsewhere"));
        Files.writeString(elsewhere.resolve("secret.md"), "secret");
        assumeTrue(linked(dir.resolve("docs"), elsewhere), "the file system refuses links");

        assertBlank404(controller.readFile(dir.toString(), "docs/secret.md", local()));
    }

    @Test
    void readRefusesAFolderAMissingFileAndAnOddPath() throws Exception {
        assertBlank404(controller.readFile(dir.toString(), "templates", local()));
        assertBlank404(controller.readFile(dir.toString(), "templates/none.md", local()));
        assertBlank404(controller.readFile(dir.toString(), "templates//spec.md", local()));
        assertBlank404(controller.readFile(dir.toString(), "./LICENSE", local()));
        assertBlank404(controller.readFile(dir.toString(), "templates\\spec.md", local()));
        assertBlank404(controller.readFile(dir.toString(), "", local()));
    }

    @Test
    void readOfAnUnregisteredFolderOrForAForeignCallerIs404() throws Exception {
        Path stranger = Files.createDirectories(tmp.resolve("stranger"));
        Files.writeString(stranger.resolve("LICENSE"), "MIT");

        assertBlank404(controller.readFile(stranger.toString(), "LICENSE", local()));
        assertBlank404(controller.readFile(dir.toString(), "LICENSE", foreign()));
        assertBlank404(controller.readFile(dir.toString(), "LICENSE", crossSite()));
    }

    // Criterion 3: the write.

    @Test
    void writeReplacesTheFileAtomicallyAndKeepsItsMode() throws Exception {
        Path file = dir.resolve("templates/spec.md");
        boolean posix = Files.getFileAttributeView(file, PosixFileAttributeView.class) != null;
        Set<PosixFilePermission> mode = PosixFilePermissions.fromString("rwxr-x---");
        if (posix) {
            Files.setPosixFilePermissions(file, mode);
        }

        ResponseEntity<?> saved = put("templates/spec.md", "# Goal\n\n# Scope\n", hashOf("templates/spec.md"));

        assertEquals(200, saved.getStatusCode().value(), String.valueOf(saved.getBody()));
        assertEquals("# Goal\n\n# Scope\n", Files.readString(file));
        assertEquals(hashOf("templates/spec.md"), json(saved).path("sha256").asText());
        assertEquals(List.of(), tempFiles(), "no temp file is left behind");
        if (posix) {
            assertEquals(mode, Files.getPosixFilePermissions(file));
        }
    }

    @Test
    void writeWithAStaleHashIs409WithTheDiskHash() throws Exception {
        String old = hashOf("templates/spec.md");
        Files.writeString(dir.resolve("templates/spec.md"), "# Goal\nchanged outside\n");

        ResponseEntity<?> saved = put("templates/spec.md", "mine", old);

        assertEquals(409, saved.getStatusCode().value());
        assertEquals(hashOf("templates/spec.md"), json(saved).path("diskHash").asText());
        assertEquals("# Goal\nchanged outside\n", Files.readString(dir.resolve("templates/spec.md")));
    }

    @Test
    void writeOfANewFileWantsAnEmptyBaseHashAndRefusesToOverwriteWithIt() throws Exception {
        ResponseEntity<?> created = put("templates/plan.md", "# Plan\n", "");
        assertEquals(200, created.getStatusCode().value(), String.valueOf(created.getBody()));
        assertEquals("# Plan\n", Files.readString(dir.resolve("templates/plan.md")));

        ResponseEntity<?> again = put("templates/plan.md", "other", "");
        assertEquals(409, again.getStatusCode().value());
        assertEquals(hashOf("templates/plan.md"), json(again).path("diskHash").asText());
        assertEquals("# Plan\n", Files.readString(dir.resolve("templates/plan.md")));

        ResponseEntity<?> gone = put("templates/none.md", "x", hashOf("templates/plan.md"));
        assertEquals(409, gone.getStatusCode().value());
        assertEquals("", json(gone).path("diskHash").asText("absent"));
        assertFalse(Files.exists(dir.resolve("templates/none.md")));
    }

    @Test
    void writeWithoutABaseHashIs400() {
        assertEquals(400, put("templates/plan.md", "x", null).getStatusCode().value());
        assertEquals(400, controller.writeFile("not json", local()).getStatusCode().value());
        assertFalse(Files.exists(dir.resolve("templates/plan.md")));
    }

    @Test
    void writeCreatesMissingParentFoldersInsideThePlaybook() throws Exception {
        ResponseEntity<?> saved = put("skills/spectropowers/reviewing/SKILL.md", "---\nname: reviewing\n---\n", "");

        assertEquals(200, saved.getStatusCode().value(), String.valueOf(saved.getBody()));
        assertTrue(Files.isRegularFile(dir.resolve("skills/spectropowers/reviewing/SKILL.md")));
    }

    @Test
    void writeRefusesPlaybookJson() throws Exception {
        byte[] before = Files.readAllBytes(dir.resolve("playbook.json"));

        ResponseEntity<?> saved = put("playbook.json", "{}", hashOf("playbook.json"));

        assertEquals(400, saved.getStatusCode().value());
        assertEquals("own-route", json(saved).path("reason").asText());
        assertArrayEquals(before, Files.readAllBytes(dir.resolve("playbook.json")));
    }

    @Test
    void writeRefusesAPathWhoseSegmentsBreakTheLoadersRule() throws Exception {
        for (String bad : List.of("skills/-pack/SKILL.md", "skills/a b/SKILL.md", ".hidden.md", "templates/.env",
                "templates/spec.md.", "templates/x..md", "skills/pa:ck/SKILL.md", "templates/a$.md")) {
            ResponseEntity<?> saved = put(bad, "x", "");
            assertEquals(400, saved.getStatusCode().value(), bad);
            assertEquals("name", json(saved).path("reason").asText(), bad);
        }
        try (Stream<Path> walk = Files.walk(dir)) {
            assertEquals(6L, walk.filter(Files::isRegularFile).count(), "a refused request writes nothing");
        }
    }

    @Test
    void everyFileOfTheShippedPackPassesTheSegmentRule() throws Exception {
        Map<String, ?> pack = controller.bundled("spectro");
        assertTrue(pack.size() > 40, "premise: the pack is there: " + pack.size());
        List<String> broken = pack.keySet().stream().filter(rel -> !PlaybookFiles.nameOk(rel)).toList();
        assertEquals(List.of(), broken);
    }

    @Test
    void writeRefusesAPathDeeperThanTheLoaderWalks() throws Exception {
        ResponseEntity<?> saved = put("skills/spectropowers/brainstorming/scripts/a/b/run.sh", "echo\n", "");

        assertEquals(400, saved.getStatusCode().value());
        assertEquals("too-deep", json(saved).path("reason").asText());
        assertFalse(Files.exists(dir.resolve("skills/spectropowers/brainstorming/scripts")));
    }

    @Test
    void writeRefusesAFileThatWouldTakeTheFolderOver200Files() throws Exception {
        for (int i = 6; i < PlaybookLoader.MAX_FILES; i++) {
            write("docs/n" + i + ".md", "x");
        }
        try (Stream<Path> walk = Files.walk(dir)) {
            assertEquals(PlaybookLoader.MAX_FILES, walk.filter(Files::isRegularFile).count(), "premise: exactly at the cap");
        }

        ResponseEntity<?> created = put("docs/one-more.md", "x", "");
        assertEquals(413, created.getStatusCode().value());
        assertEquals("too-many-files", json(created).path("reason").asText());
        assertFalse(Files.exists(dir.resolve("docs/one-more.md")));

        assertEquals(200, put("docs/n7.md", "y", hashOf("docs/n7.md")).getStatusCode().value(),
                "replacing a file at the cap adds none");
    }

    @Test
    void writeRefusesAFileThatWouldTakeTheFolderOver24Mb() throws Exception {
        long present;
        try (Stream<Path> walk = Files.walk(dir)) {
            present = walk.filter(Files::isRegularFile).mapToLong(p -> p.toFile().length()).sum();
        }
        try (RandomAccessFile big = new RandomAccessFile(dir.resolve("docs-big.bin").toFile(), "rw")) {
            big.setLength(PlaybookFiles.MAX_FOLDER_BYTES - present - 500);
        }

        ResponseEntity<?> created = put("templates/plan.md", "x".repeat(1000), "");

        assertEquals(413, created.getStatusCode().value());
        assertEquals("folder-too-large", json(created).path("reason").asText());
        assertFalse(Files.exists(dir.resolve("templates/plan.md")));
        assertEquals(200, put("templates/plan.md", "x", "").getStatusCode().value(), "a small one still fits");
    }

    @Test
    void writeRefusesATextOver1MbAndATextWithANulByte() throws Exception {
        String hash = hashOf("templates/spec.md");

        ResponseEntity<?> big = put("templates/spec.md", "x".repeat(MB + 1), hash);
        assertEquals(413, big.getStatusCode().value());
        assertEquals("too-large", json(big).path("reason").asText());

        ResponseEntity<?> nul = put("templates/spec.md", "a\u0000b", hash);
        assertEquals(415, nul.getStatusCode().value());
        assertEquals("binary", json(nul).path("reason").asText());
        assertEquals("# Goal\n", Files.readString(dir.resolve("templates/spec.md")));
    }

    @Test
    void writeNeverFollowsASymbolicLink() throws Exception {
        Path outside = Files.writeString(tmp.resolve("outside.md"), "theirs");
        assumeTrue(linked(dir.resolve("templates/linked.md"), outside), "the file system refuses links");

        assertBlank404(put("templates/linked.md", "mine", EditorView.sha256("theirs".getBytes(StandardCharsets.UTF_8))));
        assertEquals("theirs", Files.readString(outside));
        assertTrue(Files.isSymbolicLink(dir.resolve("templates/linked.md")));
    }

    @Test
    void writeNeverGoesThroughALinkedFolder() throws Exception {
        Path elsewhere = Files.createDirectories(tmp.resolve("elsewhere"));
        assumeTrue(linked(dir.resolve("docs"), elsewhere), "the file system refuses links");

        assertBlank404(put("docs/new.md", "mine", ""));
        assertBlank404(put("docs/deeper/new.md", "mine", ""));
        try (Stream<Path> listing = Files.list(elsewhere)) {
            assertEquals(0L, listing.count(), "nothing was written outside the folder");
        }
    }

    @Test
    void writeRefusesDotDotAndAnAbsolutePath() throws Exception {
        assertBlank404(put("../escape.md", "x", ""));
        assertBlank404(put("templates/../../escape.md", "x", ""));
        assertBlank404(put(tmp.resolve("escape.md").toString(), "x", ""));
        assertFalse(Files.exists(tmp.resolve("escape.md")));
    }

    @Test
    void writeOntoAFolderIsRefused() throws Exception {
        ResponseEntity<?> saved = put("templates", "x", "");
        assertEquals(400, saved.getStatusCode().value());
        assertEquals("folder", json(saved).path("reason").asText());
        assertTrue(Files.isDirectory(dir.resolve("templates")));
    }

    @Test
    void writeOfAnUnregisteredFolderOrForAForeignCallerIs404() throws Exception {
        Path stranger = Files.createDirectories(tmp.resolve("stranger"));
        ObjectNode body = mapper.createObjectNode().put("dir", stranger.toString()).put("path", "x.md")
                .put("text", "x").put("baseHash", "");
        assertBlank404(controller.writeFile(body.toString(), local()));
        assertFalse(Files.exists(stranger.resolve("x.md")));

        String mine = writeBody("templates/plan.md", "x", "");
        assertBlank404(controller.writeFile(mine, foreign()));
        assertBlank404(controller.writeFile(mine, crossSite()));
        assertFalse(Files.exists(dir.resolve("templates/plan.md")));
    }

    // Criterion 3: the delete.

    @Test
    void deleteRemovesOneTextFile() throws Exception {
        ResponseEntity<?> deleted = controller.deleteFile(dir.toString(), "templates/spec.md", local());

        assertEquals(200, deleted.getStatusCode().value());
        assertFalse(Files.exists(dir.resolve("templates/spec.md")));
        assertTrue(Files.isDirectory(dir.resolve("templates")));
    }

    @Test
    void deleteRefusesAFolder() throws Exception {
        ResponseEntity<?> deleted = controller.deleteFile(dir.toString(), "templates", local());

        assertEquals(400, deleted.getStatusCode().value());
        assertEquals("folder", json(deleted).path("reason").asText());
        assertTrue(Files.isRegularFile(dir.resolve("templates/spec.md")));
    }

    @Test
    void deleteRefusesPlaybookJson() {
        assertProtected("playbook.json");
    }

    @Test
    void deleteRefusesTheLicense() {
        assertProtected("LICENSE");
    }

    @Test
    void deleteRefusesTheProvenance() {
        assertProtected("PROVENANCE.md");
    }

    private void assertProtected(String name) {
        ResponseEntity<?> deleted = controller.deleteFile(dir.toString(), name, local());
        assertEquals(400, deleted.getStatusCode().value(), name);
        assertEquals("protected", json(deleted).path("reason").asText(), name);
        assertTrue(Files.isRegularFile(dir.resolve(name)), name);
    }

    @Test
    void deleteRefusesABinaryFile() throws Exception {
        Files.write(dir.resolve("templates/logo.png"), new byte[] {1, 0, 2});

        ResponseEntity<?> deleted = controller.deleteFile(dir.toString(), "templates/logo.png", local());

        assertEquals(415, deleted.getStatusCode().value());
        assertTrue(Files.exists(dir.resolve("templates/logo.png")));
    }

    @Test
    void deleteRefusesASymbolicLinkAndKeepsItsTarget() throws Exception {
        Path outside = Files.writeString(tmp.resolve("outside.md"), "theirs");
        assumeTrue(linked(dir.resolve("templates/linked.md"), outside), "the file system refuses links");

        assertBlank404(controller.deleteFile(dir.toString(), "templates/linked.md", local()));
        assertTrue(Files.isSymbolicLink(dir.resolve("templates/linked.md")));
        assertEquals("theirs", Files.readString(outside));
    }

    @Test
    void deleteRefusesDotDotAndAForeignCaller() throws Exception {
        Path outside = Files.writeString(tmp.resolve("outside.md"), "theirs");

        assertBlank404(controller.deleteFile(dir.toString(), "../outside.md", local()));
        assertBlank404(controller.deleteFile(dir.toString(), outside.toString(), local()));
        assertBlank404(controller.deleteFile(dir.toString(), "templates/spec.md", foreign()));
        assertBlank404(controller.deleteFile(dir.toString(), "templates/spec.md", crossSite()));
        assertBlank404(controller.deleteFile(tmp.toString(), "outside.md", local()));
        assertTrue(Files.exists(outside));
        assertTrue(Files.exists(dir.resolve("templates/spec.md")));
    }

    // Criterion 4: the reader and validator stay in force.

    private List<String> draftFindings() {
        EditorView view = (EditorView) controller.getDraft(dir.toString(), null).getBody();
        return view.loaded().findings().stream().map(f -> f.path() + ": " + f.message()).toList();
    }

    @Test
    void aDeleteOfAContentsPathShowsAsAFindingInTheNextDraft() throws Exception {
        assertFalse(draftFindings().stream().anyMatch(f -> f.startsWith("contents.agents[0]")), draftFindings().toString());

        assertEquals(200, controller.deleteFile(dir.toString(), "agents/reviewer.md", local()).getStatusCode().value());

        assertTrue(draftFindings().contains("contents.agents[0]: does not exist in the playbook folder"),
                draftFindings().toString());
    }

    @Test
    void aWriteUnderHooksAddsNoPermission() throws Exception {
        List<String> before = draftFindings();
        String hooks = "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"*\",\"hooks\":[{\"type\":\"command\",\"command\":\"echo hi\"}]}]}}";

        assertEquals(200, put("hooks/hooks.json", hooks, "").getStatusCode().value());

        assertEquals(before, draftFindings(), "the draft answers as it did");
        assertFalse(Files.exists(userSettings), "no hook reached the settings");
        assertFalse(Files.exists(spectroHome), "nothing was installed");
    }

    @Test
    void aRefusedPlaybookJsonWriteLeavesTheDraftAsItWas() throws Exception {
        List<String> before = draftFindings();
        String hash = ((EditorView) controller.getDraft(dir.toString(), null).getBody()).diskHash();

        assertEquals(400, put("playbook.json", "{ broken", hash).getStatusCode().value());

        assertEquals(before, draftFindings());
        assertEquals(hash, ((EditorView) controller.getDraft(dir.toString(), null).getBody()).diskHash());
    }

    // Criterion 5: the routes are mapped and fenced.

    @Test
    void theFourRoutesAreMappedOnThePlaybookController() throws Exception {
        assertEquals(List.of("/api/playbooks/tree"), List.of(PlaybookController.class
                .getMethod("tree", String.class, jakarta.servlet.http.HttpServletRequest.class)
                .getAnnotation(org.springframework.web.bind.annotation.GetMapping.class).value()));
        assertEquals(List.of("/api/playbooks/read"), List.of(PlaybookController.class
                .getMethod("readFile", String.class, String.class, jakarta.servlet.http.HttpServletRequest.class)
                .getAnnotation(org.springframework.web.bind.annotation.GetMapping.class).value()));
        assertEquals(List.of("/api/playbooks/write"), List.of(PlaybookController.class
                .getMethod("writeFile", String.class, jakarta.servlet.http.HttpServletRequest.class)
                .getAnnotation(org.springframework.web.bind.annotation.PutMapping.class).value()));
        assertEquals(List.of("/api/playbooks/file-at"), List.of(PlaybookController.class
                .getMethod("deleteFile", String.class, String.class, jakarta.servlet.http.HttpServletRequest.class)
                .getAnnotation(org.springframework.web.bind.annotation.DeleteMapping.class).value()));
        for (String route : List.of("/api/playbooks/tree", "/api/playbooks/read", "/api/playbooks/write",
                "/api/playbooks/file-at")) {
            assertFalse(dev.spectroscope.server.web.ApiLocalFence.isOpen(route), route + " stays behind the fence");
        }
    }

    @Test
    void theTreeAnswersFindingsAsTheCoreRecord() throws Exception {
        assumeTrue(linked(dir.resolve("loop"), dir), "the file system refuses links");
        ResponseEntity<?> tree = controller.tree(dir.toString(), local());
        PlaybookFiles.TreeView view = (PlaybookFiles.TreeView) tree.getBody();
        assertEquals(List.of(new Finding("loop", "a symbolic link")), view.findings());
    }

    // Fix round: the protected files are matched on identity, not on spelling.

    private List<String> rootNames() throws IOException {
        try (Stream<Path> list = Files.list(dir)) {
            return list.map(p -> p.getFileName().toString()).sorted().toList();
        }
    }

    @Test
    void writeRefusesACaseVariantOfPlaybookJson() throws Exception {
        byte[] before = Files.readAllBytes(dir.resolve("playbook.json"));
        List<String> names = rootNames();

        for (String variant : List.of("PLAYBOOK.JSON", "Playbook.json", "playbook.JSON", "PLAYBOOK.json")) {
            ResponseEntity<?> saved = put(variant, "{ broken", hashOf("playbook.json"));
            assertEquals(400, saved.getStatusCode().value(), variant);
            assertEquals("own-route", json(saved).path("reason").asText(), variant);
        }

        assertArrayEquals(before, Files.readAllBytes(dir.resolve("playbook.json")), "playbook.json is unchanged");
        assertEquals(names, rootNames(), "no file was added next to playbook.json");
    }

    @Test
    void deleteRefusesACaseVariantOfEachProtectedFile() throws Exception {
        Map<String, byte[]> before = Map.of(
                "playbook.json", Files.readAllBytes(dir.resolve("playbook.json")),
                "LICENSE", Files.readAllBytes(dir.resolve("LICENSE")),
                "PROVENANCE.md", Files.readAllBytes(dir.resolve("PROVENANCE.md")));

        for (String variant : List.of("PLAYBOOK.JSON", "Playbook.json", "PLAYBOOK.json", "license", "License",
                "Provenance.md", "provenance.MD")) {
            ResponseEntity<?> deleted = controller.deleteFile(dir.toString(), variant, local());
            assertEquals(400, deleted.getStatusCode().value(), variant);
            assertEquals("protected", json(deleted).path("reason").asText(), variant);
        }

        for (Map.Entry<String, byte[]> file : before.entrySet()) {
            assertTrue(rootNames().contains(file.getKey()), file.getKey() + " is still there under its own name");
            assertArrayEquals(file.getValue(), Files.readAllBytes(dir.resolve(file.getKey())), file.getKey());
        }
    }

    @Test
    void aCaseVariantIsRefusedEvenWhereNoFileAnswersToIt() throws Exception {
        // What a case-sensitive file system sees: the variant names no file on disk.
        Files.delete(dir.resolve("playbook.json"));
        Files.delete(dir.resolve("LICENSE"));

        ResponseEntity<?> saved = put("Playbook.json", "{}", "");
        assertEquals(400, saved.getStatusCode().value());
        assertEquals("own-route", json(saved).path("reason").asText());
        ResponseEntity<?> deleted = controller.deleteFile(dir.toString(), "license", local());
        assertEquals(400, deleted.getStatusCode().value());
        assertEquals("protected", json(deleted).path("reason").asText());

        assertFalse(rootNames().stream().anyMatch(n -> n.equalsIgnoreCase("playbook.json")), rootNames().toString());
        assertEquals(200, put("notes.md", "x", "").getStatusCode().value(), "another root file is still written");
    }

    @Test
    void aHardLinkToPlaybookJsonIsNeitherWrittenNorRemoved() throws Exception {
        Path alias = dir.resolve("alias.json");
        try {
            Files.createLink(alias, dir.resolve("playbook.json"));
        } catch (IOException | UnsupportedOperationException refused) {
            assumeTrue(false, "the file system refuses hard links");
        }
        byte[] before = Files.readAllBytes(dir.resolve("playbook.json"));

        ResponseEntity<?> saved = put("alias.json", "{ broken", hashOf("alias.json"));
        assertEquals(400, saved.getStatusCode().value());
        assertEquals("own-route", json(saved).path("reason").asText());

        ResponseEntity<?> deleted = controller.deleteFile(dir.toString(), "alias.json", local());
        assertEquals(400, deleted.getStatusCode().value());
        assertEquals("protected", json(deleted).path("reason").asText());

        assertTrue(Files.isSameFile(alias, dir.resolve("playbook.json")), "the link is still there");
        assertArrayEquals(before, Files.readAllBytes(dir.resolve("playbook.json")));
        assertEquals(200, controller.deleteFile(dir.toString(), "agents/reviewer.md", local()).getStatusCode().value(),
                "a plain file is still removed");
    }

    // Fix round: a write onto a file over 1 MB is refused before the hash is compared.

    @Test
    void writeOntoAnExistingFileOver1MbIs413WithoutADiskHash() throws Exception {
        Path big = dir.resolve("templates/big.md");
        byte[] bytes = "x".repeat(MB + 10).getBytes(StandardCharsets.UTF_8);
        Files.write(big, bytes);
        String fullHash = EditorView.sha256(bytes);
        String prefixHash = EditorView.sha256(java.util.Arrays.copyOf(bytes, MB + 1));

        for (String hash : List.of(fullHash, prefixHash, "")) {
            ResponseEntity<?> saved = put("templates/big.md", "small", hash);
            assertEquals(413, saved.getStatusCode().value(), hash);
            assertEquals("too-large", json(saved).path("reason").asText(), hash);
            assertTrue(json(saved).path("diskHash").isMissingNode(), "no hash is handed out: " + saved.getBody());
        }

        assertArrayEquals(bytes, Files.readAllBytes(big), "the large file is unchanged");
        assertEquals(200, put("templates/spec.md", "# Goal\nsmall\n", hashOf("templates/spec.md")).getStatusCode().value(),
                "a file under 1 MB is still written");
    }

    // Fix round: the body cap of the write route.

    @Test
    void aWriteBodyOverTheCapIs413AndWritesNothing() throws Exception {
        String head = writeBody("templates/plan.md", "x", "");
        String pad = "y".repeat(PlaybookController.MAX_WRITE_BODY_BYTES + 1 - head.length() - ",\"pad\":\"\"".length());
        String body = head.substring(0, head.length() - 1) + ",\"pad\":\"" + pad + "\"}";
        assertEquals(PlaybookController.MAX_WRITE_BODY_BYTES + 1, body.getBytes(StandardCharsets.UTF_8).length,
                "premise: the body is one byte over the cap");
        assertTrue(mapper.readTree(body).path("pad").isTextual(), "premise: the body is valid JSON a parser would take");

        ResponseEntity<?> saved = controller.writeFile(body, local());

        assertEquals(413, saved.getStatusCode().value());
        assertEquals("too-large", json(saved).path("reason").asText());
        assertFalse(Files.exists(dir.resolve("templates/plan.md")), "nothing was written");
    }

    @Test
    void aWriteBodyOfA1MbTextOfEscapedCharactersIsAccepted() throws Exception {
        String text = "\u0001".repeat(MB);
        String body = writeBody("templates/plan.md", text, "");
        assertTrue(body.getBytes(StandardCharsets.UTF_8).length > 6 * MB, "premise: every character takes six bytes");

        ResponseEntity<?> saved = controller.writeFile(body, local());

        assertEquals(200, saved.getStatusCode().value(), String.valueOf(saved.getBody()));
        assertEquals(MB, Files.size(dir.resolve("templates/plan.md")));
    }
}
