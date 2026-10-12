package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.playbook.ContentHash;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.SafeWalk;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 524: a playbook travels as a ZIP. The export streams a registered folder as
 * {@code <id>.playbook.zip}; the import takes the entries the browser read from such a file and
 * writes them into an empty folder through a staged folder and one move. Driven directly with
 * mock requests, like {@link PlaybookFilesRouteTest}.
 */
class PlaybookBundleRouteTest {

    private static final int MB = 1024 * 1024;

    @TempDir Path tmp;

    private final ObjectMapper mapper = new ObjectMapper();
    private PlaybookFolders folders;
    private PlaybookController controller;
    private Path dir;
    private Path home;
    private Path spectroHome;
    private Path userSettings;
    private Path launch;
    private Path ledgerFile;

    @BeforeEach
    void setUp() throws IOException {
        folders = new PlaybookFolders(tmp.resolve("playbooks.json"));
        home = Files.createDirectories(tmp.resolve("home"));
        spectroHome = Files.createDirectories(home.resolve(".spectro"));
        userSettings = spectroHome.resolve("settings.json");
        launch = Files.createDirectories(tmp.resolve("launch"));
        ledgerFile = tmp.resolve("ledger/playbook-installs.json");
        controller = new PlaybookController(folders, PlaybookController.BUNDLE_ROOT,
                new InstallLedger(ledgerFile), spectroHome, launch, userSettings);
        dir = Files.createDirectories(tmp.resolve("pb"));
        Files.writeString(dir.resolve("playbook.json"), PlaybookLoaderTest.MINIMAL);
        write(dir, "skills/spectropowers/brainstorming/SKILL.md", "---\nname: brainstorming\ndescription: d\n---\nbody\n");
        write(dir, "templates/spec.md", "# Goal\n");
        write(dir, "LICENSE", "MIT\n");
        write(dir, "PROVENANCE.md", "# Provenance\n\nmade here\n");
        folders.register(dir);
    }

    // ---- fixtures ------------------------------------------------------------------------------

    private static Path write(Path base, String rel, String text) throws IOException {
        Path file = base.resolve(rel);
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

    /** The body as JSON; a streamed body (the export's refusals) is written out and parsed. */
    private JsonNode json(ResponseEntity<?> response) {
        if (response.getBody() instanceof StreamingResponseBody stream) {
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                stream.writeTo(out);
                return mapper.readTree(out.toByteArray());
            } catch (IOException unreadable) {
                throw new java.io.UncheckedIOException(unreadable);
            }
        }
        return mapper.valueToTree(response.getBody());
    }

    private boolean linked(Path link, Path target) {
        try {
            Files.createSymbolicLink(link, target);
            return true;
        } catch (IOException | UnsupportedOperationException noLinks) {
            return false;
        }
    }

    /** The bytes of a 200 export. */
    private byte[] exported(Path folder) throws IOException {
        ResponseEntity<?> answer = controller.exportBundle(folder.toString(), local());
        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ((StreamingResponseBody) answer.getBody()).writeTo(out);
        return out.toByteArray();
    }

    /** The entries of a zip in order, name to bytes. */
    private static Map<String, byte[]> unzip(byte[] zip) throws IOException {
        Map<String, byte[]> out = new LinkedHashMap<>();
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zip), StandardCharsets.UTF_8)) {
            ZipEntry entry;
            while ((entry = in.getNextEntry()) != null) {
                out.put(entry.getName(), in.readAllBytes());
            }
        }
        return out;
    }

    /** What the browser posts for a zip: the top folder stripped, text or base64 per entry. */
    private ArrayNode entriesOf(byte[] zip) throws IOException {
        ArrayNode entries = mapper.createArrayNode();
        for (Map.Entry<String, byte[]> e : unzip(zip).entrySet()) {
            String rel = e.getKey().substring(e.getKey().indexOf('/') + 1);
            String text = PlaybookFiles.textOf(e.getValue());
            ObjectNode node = entries.addObject().put("path", rel);
            if (text != null) {
                node.put("text", text);
            } else {
                node.put("base64", Base64.getEncoder().encodeToString(e.getValue()));
            }
        }
        return entries;
    }

    private ArrayNode entriesOf(Path folder) throws IOException {
        return entriesOf(exported(folder));
    }

    private ResponseEntity<?> importInto(Path target, ArrayNode entries) {
        ObjectNode body = mapper.createObjectNode().put("dir", target.toString());
        body.set("entries", entries);
        return controller.importBundle(body.toString(), local());
    }

    private static ObjectNode textEntry(ObjectMapper mapper, String path, String text) {
        return mapper.createObjectNode().put("path", path).put("text", text);
    }

    /** A valid bundle (the fixture folder's entries) plus {@code extra}. */
    private ArrayNode validPlus(ObjectNode... extra) throws IOException {
        ArrayNode entries = entriesOf(dir);
        for (ObjectNode e : extra) {
            entries.add(e);
        }
        return entries;
    }

    private Path emptyTarget(String name) throws IOException {
        return Files.createDirectories(tmp.resolve("targets").resolve(name));
    }

    /** Every name below a folder; the empty list for an empty folder. */
    private static List<String> listing(Path folder) throws IOException {
        try (Stream<Path> walk = Files.walk(folder)) {
            return walk.filter(p -> !p.equals(folder)).map(p -> folder.relativize(p).toString()).sorted().toList();
        }
    }

    /** The names directly in a folder, sorted. */
    private static List<String> names(Path folder) throws IOException {
        try (Stream<Path> list = Files.list(folder)) {
            return list.map(p -> p.getFileName().toString()).sorted().toList();
        }
    }

    /** A refusal: the status, and the target and its parent hold nothing new. */
    private void assertRefused(int status, String reason, Path target, ResponseEntity<?> answer) throws IOException {
        assertEquals(status, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(reason, json(answer).path("reason").asText(), String.valueOf(answer.getBody()));
        assertFalse(json(answer).path("message").asText().isBlank(), "a refusal carries a sentence");
        assertEquals(List.of(), listing(target), "the target stays empty");
        assertTrue(names(target.getParent()).stream().noneMatch(n -> n.startsWith(".")),
                "no staged folder is left beside the target: " + names(target.getParent()));
        assertFalse(folders.read().folders().contains(target.toRealPath().toString()), "nothing is registered");
    }

    private static String treeHash(Path folder) throws IOException {
        return ContentHash.tree(SafeWalk.walk(folder, folder));
    }

    // ---- AC1: the export -----------------------------------------------------------------------

    @Test
    void exportStreamsEveryFileUnderOneTopFolderNamedAfterTheId() throws IOException {
        Map<String, byte[]> entries = unzip(exported(dir));

        List<String> expected = SafeWalk.walk(dir, dir).files().stream().map(f -> "p/" + f).toList();
        assertEquals(expected, new ArrayList<>(entries.keySet()), "every file, in the walk's order, under p/");
        for (String rel : SafeWalk.walk(dir, dir).files()) {
            assertArrayEquals(Files.readAllBytes(dir.resolve(rel)), entries.get("p/" + rel), rel);
        }
    }

    @Test
    void exportOfTheSameFolderGivesTheSameBytesTwice() throws IOException {
        byte[] first = exported(dir);
        try (Stream<Path> walk = Files.walk(dir)) {
            for (Path p : walk.filter(Files::isRegularFile).toList()) {
                Files.setLastModifiedTime(p, FileTime.fromMillis(1_000_000_000_000L));
            }
        }

        byte[] second = exported(dir);

        assertArrayEquals(first, second, "the same folder gives the same bytes, whatever the file times");
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(second))) {
            ZipEntry e;
            while ((e = in.getNextEntry()) != null) {
                assertEquals(java.time.LocalDateTime.of(1980, 1, 1, 0, 0), e.getTimeLocal(), e.getName());
            }
        }
    }

    @Test
    void exportNamesTheFileAndSetsNosniff() {
        ResponseEntity<?> answer = controller.exportBundle(dir.toString(), local());

        assertEquals(200, answer.getStatusCode().value());
        assertEquals("application/zip", String.valueOf(answer.getHeaders().getContentType()));
        assertEquals("nosniff", answer.getHeaders().getFirst("X-Content-Type-Options"));
        assertEquals("attachment; filename=\"p.playbook.zip\"", answer.getHeaders().getFirst("Content-Disposition"));
    }

    @Test
    void theExportGoesThroughSpringMvcAsAZipAndARefusalAsJson() throws Exception {
        // The handler's return value must be one Spring MVC can write: a mock call on the controller
        // cannot see that, the live check of 2026-10-11 answered 500 "No converter" for it.
        org.springframework.test.web.servlet.MockMvc mvc =
                org.springframework.test.web.servlet.setup.MockMvcBuilders.standaloneSetup(controller).build();
        org.springframework.test.web.servlet.MvcResult started = mvc.perform(
                org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                        .get("http://127.0.0.1/api/playbooks/export").param("dir", dir.toString())).andReturn();
        org.springframework.test.web.servlet.MvcResult done = started.getRequest().isAsyncStarted()
                ? mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch(started)).andReturn()
                : started;

        assertEquals(200, done.getResponse().getStatus());
        assertEquals("application/zip", done.getResponse().getContentType());
        assertEquals("nosniff", done.getResponse().getHeader("X-Content-Type-Options"));
        assertTrue(unzip(done.getResponse().getContentAsByteArray()).containsKey("p/playbook.json"));

        Files.write(dir.resolve("templates/logo.png"), new byte[] {(byte) 0x89, 'P', 'N', 'G', 0, 0, 1});
        org.springframework.test.web.servlet.MvcResult refusedStart = mvc.perform(
                org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                        .get("http://127.0.0.1/api/playbooks/export").param("dir", dir.toString())).andReturn();
        org.springframework.test.web.servlet.MvcResult refused = refusedStart.getRequest().isAsyncStarted()
                ? mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch(refusedStart)).andReturn()
                : refusedStart;
        assertEquals(409, refused.getResponse().getStatus());
        assertTrue(String.valueOf(refused.getResponse().getContentType()).startsWith("application/json"),
                refused.getResponse().getContentType());
        JsonNode body = mapper.readTree(refused.getResponse().getContentAsByteArray());
        assertEquals("refused", body.path("reason").asText());
        assertTrue(body.path("findings").toString().contains("templates/logo.png"), body.toString());
    }

    @Test
    void exportRefusesAFolderWithASymlinkWith409AndTheFinding() throws IOException {
        Path outside = write(tmp, "outside/secret.txt", "secret\n");
        assumeTrue(linked(dir.resolve("templates/link.md"), outside), "symlinks are supported here");

        ResponseEntity<?> answer = controller.exportBundle(dir.toString(), local());

        assertEquals(409, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertTrue(json(answer).path("findings").toString().contains("templates/link.md"), json(answer).toString());
        assertEquals("application/json", String.valueOf(answer.getHeaders().getContentType()),
                "the answer is the refusal, no byte of the folder is sent");
    }

    @Test
    void exportNeverFollowsALinkedFolderOutOfTheRegisteredFolder() throws IOException {
        write(tmp, "outside/secret.txt", "secret\n");
        assumeTrue(linked(dir.resolve("docs"), tmp.resolve("outside")), "symlinks are supported here");

        ResponseEntity<?> answer = controller.exportBundle(dir.toString(), local());

        assertEquals(409, answer.getStatusCode().value());
        assertTrue(json(answer).path("findings").toString().contains("docs"), json(answer).toString());
        assertFalse(json(answer).toString().contains("secret\\n"), "the linked content never travels");
    }

    @Test
    void exportRefusesAFileTheImportWouldRefuse() throws IOException {
        Files.write(dir.resolve("templates/logo.png"), new byte[] {(byte) 0x89, 'P', 'N', 'G', 0, 0, 1});

        ResponseEntity<?> answer = controller.exportBundle(dir.toString(), local());

        assertEquals(409, answer.getStatusCode().value());
        assertTrue(json(answer).path("findings").toString().contains("templates/logo.png"), json(answer).toString());
    }

    @Test
    void exportLeavesOutFinderMetadata() throws IOException {
        Files.write(dir.resolve(".DS_Store"), new byte[] {0, 0, 0, 1, 'B', 'u', 'd', '1'});

        Map<String, byte[]> entries = unzip(exported(dir));

        assertFalse(entries.containsKey("p/.DS_Store"), entries.keySet().toString());
        assertTrue(entries.containsKey("p/playbook.json"));
    }

    @Test
    void exportOfAFolderThatIsNotRegisteredIsHidden() throws IOException {
        Path other = Files.createDirectories(tmp.resolve("other"));
        Files.writeString(other.resolve("playbook.json"), PlaybookLoaderTest.MINIMAL);

        ResponseEntity<?> answer = controller.exportBundle(other.toString(), local());

        assertEquals(404, answer.getStatusCode().value());
        assertEquals(null, answer.getBody());
    }

    @Test
    void exportIsHiddenFromAForeignCallerAndAForeignOrigin() {
        assertEquals(404, controller.exportBundle(dir.toString(), foreign()).getStatusCode().value());
        assertEquals(404, controller.exportBundle(dir.toString(), crossSite()).getStatusCode().value());
    }

    // ---- AC3: the import -----------------------------------------------------------------------

    @Test
    void importWritesTheEntriesRegistersTheFolderAndAnswersTheLoadedView() throws IOException {
        Path target = emptyTarget("copy");
        byte[] picture = new byte[] {(byte) 0x89, 'P', 'N', 'G', 0, 0, 1, 2};
        ArrayNode entries = validPlus(mapper.createObjectNode().put("path", "docs/logo.png")
                .put("base64", Base64.getEncoder().encodeToString(picture)));

        ResponseEntity<?> answer = importInto(target, entries);

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("p", json(answer).path("playbook").path("id").asText());
        assertEquals(target.toRealPath().toString(), json(answer).path("dir").asText());
        assertEquals("[]", json(answer).path("findings").toString());
        assertTrue(folders.read().folders().contains(target.toRealPath().toString()), "the folder is registered");
        assertArrayEquals(picture, Files.readAllBytes(target.resolve("docs/logo.png")));
        assertEquals("# Goal\n", Files.readString(target.resolve("templates/spec.md"), StandardCharsets.UTF_8));
    }

    @Test
    void importWritesATextEntryAsUtf8() throws IOException {
        Path target = emptyTarget("utf8");
        String text = "Grüße, \u00e9t\u00e9 \uD83D\uDE00\r\nline two\n";

        assertEquals(200, importInto(target, validPlus(textEntry(mapper, "templates/notes.md", text)))
                .getStatusCode().value());

        assertArrayEquals(text.getBytes(StandardCharsets.UTF_8), Files.readAllBytes(target.resolve("templates/notes.md")));
    }

    @Test
    void importIntoAFolderThatIsNotEmptyIs409AndWritesNothing() throws IOException {
        Path target = emptyTarget("busy");
        Files.writeString(target.resolve("mine.txt"), "mine\n");

        ResponseEntity<?> answer = importInto(target, validPlus());

        assertEquals(409, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("not-empty", json(answer).path("reason").asText());
        assertEquals(List.of("mine.txt"), listing(target));
        assertEquals(List.of("busy"), names(target.getParent()));
    }

    @Test
    void importIntoAFolderThatDoesNotExistOrIsRelativeIsRefused() throws IOException {
        ObjectNode missing = mapper.createObjectNode().put("dir", tmp.resolve("nope").toString());
        missing.set("entries", validPlus());
        assertEquals(400, controller.importBundle(missing.toString(), local()).getStatusCode().value());
        assertFalse(Files.exists(tmp.resolve("nope")), "a missing folder is not created");

        ObjectNode relative = mapper.createObjectNode().put("dir", "targets/rel");
        relative.set("entries", validPlus());
        assertEquals(400, controller.importBundle(relative.toString(), local()).getStatusCode().value());
    }

    @Test
    void importRefusesZipSlipPathsAndWritesNothing() throws IOException {
        List<String> slips = List.of("../evil.md", "templates/../../evil.md", "/etc/evil.md", "templates\\evil.md",
                "templates//evil.md", "./templates/evil.md", "templates/evil.md/", "", "C:/evil.md",
                "templates/.hidden.md", "templates/sp ace.md", "temp lates/a.md", "templates/a\u0000.md");
        for (String slip : slips) {
            Path target = emptyTarget("slip" + slips.indexOf(slip));
            ResponseEntity<?> answer = importInto(target, validPlus(textEntry(mapper, slip, "x\n")));
            assertRefused(400, "path", target, answer);
            assertFalse(Files.exists(tmp.resolve("evil.md")), slip);
            assertFalse(Files.exists(tmp.resolve("targets/evil.md")), slip);
        }
    }

    /** A path under templates/ with exactly {@code levels} parts, the file being the last. */
    private static String pathOfLevels(int levels) {
        StringBuilder path = new StringBuilder("templates");
        for (int i = 2; i < levels; i++) {
            path.append("/d").append(i);
        }
        return path.append("/deep.md").toString();
    }

    @Test
    void importRefusesAnEntryDeeperThanTheWalkDepthAndNamesIt() throws IOException {
        // Card 524, depth limit of 2026-10-11: the loader, the tree and the file routes stop at
        // WALK_DEPTH, so a file below it would be written but never seen or counted again.
        String deep = pathOfLevels(PlaybookLoader.WALK_DEPTH + 1);
        assertEquals(PlaybookLoader.WALK_DEPTH + 1, deep.split("/").length, "premise: one level past the walk");
        Path target = emptyTarget("deep");

        ResponseEntity<?> answer = importInto(target, validPlus(textEntry(mapper, deep, "x\n")));

        assertRefused(400, "too-deep", target, answer);
        String message = json(answer).path("message").asText();
        assertTrue(message.contains(deep), "the refusal names the entry: " + message);
        assertTrue(message.contains(PlaybookLoader.WALK_DEPTH + " levels"), "and the depth: " + message);
        assertFalse(message.contains("loader"), "plain words, the ZIP import shows this sentence: " + message);
    }

    @Test
    void importWritesAnEntryAtTheWalkDepth() throws IOException {
        String atDepth = pathOfLevels(PlaybookLoader.WALK_DEPTH);
        assertEquals(PlaybookLoader.WALK_DEPTH, atDepth.split("/").length, "premise: exactly at the walk depth");
        Path target = emptyTarget("atdepth");

        ResponseEntity<?> answer = importInto(target, validPlus(textEntry(mapper, atDepth, "x\n")));

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("x\n", Files.readString(target.resolve(atDepth)));
    }

    @Test
    void exportRefusesAFileDeeperThanTheImportReads() throws IOException {
        String deep = pathOfLevels(PlaybookLoader.WALK_DEPTH + 1);
        write(dir, deep, "x\n");

        ResponseEntity<?> answer = controller.exportBundle(dir.toString(), local());

        assertEquals(409, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertTrue(json(answer).path("findings").toString().contains(deep), json(answer).toString());
        assertTrue(json(answer).path("findings").toString().contains(PlaybookLoader.WALK_DEPTH + " levels"),
                json(answer).toString());
        assertFalse(json(answer).path("findings").toString().contains("loader"), json(answer).toString());
    }

    @Test
    void importRefusesTwoEntriesThatNameTheSameFileInAnyCase() throws IOException {
        Path target = emptyTarget("twice");

        ResponseEntity<?> answer = importInto(target, validPlus(textEntry(mapper, "templates/Spec.md", "other\n")));

        assertRefused(400, "duplicate", target, answer);
    }

    @Test
    void importRefusesAPathThatIsBothAFileAndAFolder() throws IOException {
        Path target = emptyTarget("both");

        ResponseEntity<?> answer = importInto(target, validPlus(textEntry(mapper, "templates", "a file named like a folder\n")));

        assertRefused(400, "duplicate", target, answer);
    }

    @Test
    void importRefusesABase64EntryOutsideDocs() throws IOException {
        Path target = emptyTarget("bin");
        ObjectNode bin = mapper.createObjectNode().put("path", "templates/logo.png")
                .put("base64", Base64.getEncoder().encodeToString(new byte[] {0, 1, 2}));

        assertRefused(400, "binary", target, importInto(target, validPlus(bin)));
    }

    @Test
    void importRefusesABase64EntryOverTwoMegabytes() throws IOException {
        Path target = emptyTarget("bigbin");
        ObjectNode bin = mapper.createObjectNode().put("path", "docs/big.bin")
                .put("base64", Base64.getEncoder().encodeToString(new byte[2 * MB + 1]));

        assertRefused(413, "too-large", target, importInto(target, validPlus(bin)));
    }

    @Test
    void aBase64EntryOfExactlyTwoMegabytesUnderDocsIsWritten() throws IOException {
        Path target = emptyTarget("edgebin");
        ObjectNode bin = mapper.createObjectNode().put("path", "docs/edge.bin")
                .put("base64", Base64.getEncoder().encodeToString(new byte[2 * MB]));

        assertEquals(200, importInto(target, validPlus(bin)).getStatusCode().value());
        assertEquals(2L * MB, Files.size(target.resolve("docs/edge.bin")));
    }

    @Test
    void importRefusesATextEntryWithANulByte() throws IOException {
        Path target = emptyTarget("nul");

        assertRefused(415, "binary", target, importInto(target, validPlus(textEntry(mapper, "templates/n.md", "a\u0000b"))));
    }

    @Test
    void importRefusesMoreThanTwoHundredEntries() throws IOException {
        Path target = emptyTarget("many");
        ArrayNode entries = validPlus();
        for (int i = entries.size(); i <= PlaybookLoader.MAX_FILES; i++) {
            entries.add(textEntry(mapper, "templates/t" + i + ".md", "x\n"));
        }
        assertEquals(PlaybookLoader.MAX_FILES + 1, entries.size(), "premise: one entry over the cap");

        assertRefused(413, "too-many-files", target, importInto(target, entries));
    }

    @Test
    void importRefusesABundleOverTwentyFourMegabytes() throws IOException {
        Path target = emptyTarget("huge");
        ArrayNode entries = validPlus();
        String twoMb = "x".repeat(2 * MB);
        for (int i = 0; i < 12; i++) {
            entries.add(textEntry(mapper, "templates/big" + i + ".md", twoMb));
        }

        assertRefused(413, "too-large", target, importInto(target, entries));
    }

    @Test
    void importRefusesABundleWithoutPlaybookJson() throws IOException {
        Path target = emptyTarget("nopb");
        ArrayNode entries = mapper.createArrayNode();
        entries.add(textEntry(mapper, "templates/spec.md", "# Goal\n"));

        assertRefused(400, "no-playbook", target, importInto(target, entries));
    }

    @Test
    void importRefusesAPlaybookThatCarriesAKeyAndWritesNothing() throws IOException {
        List<String> keys = List.of("\"apiKey\": \"sk-x\"", "\"baseUrl\": \"http://10.0.0.1:1234\"",
                "\"mcpServers\": {}", "\"hooks\": []");
        for (String refused : keys) {
            Path target = emptyTarget("key" + keys.indexOf(refused));
            String json = PlaybookLoaderTest.MINIMAL.replaceFirst("\\{ \"schema_version\": 1,",
                    "{ \"schema_version\": 1, " + refused + ",");
            assertTrue(json.contains(refused), "premise: the fixture carries " + refused);
            ArrayNode entries = mapper.createArrayNode();
            for (JsonNode e : validPlus()) {
                entries.add("playbook.json".equals(e.path("path").asText())
                        ? textEntry(mapper, "playbook.json", json) : e);
            }

            ResponseEntity<?> answer = importInto(target, entries);

            assertRefused(422, "findings", target, answer);
            assertTrue(json(answer).path("findings").toString().contains("refused"), answer.getBody().toString());
        }
    }

    @Test
    void importRefusesAPlaybookWhoseContentsAreMissingFromTheBundle() throws IOException {
        // The reader accepts this file; only the staged copy shows that contents names a folder the
        // bundle does not carry. So this pins the check after the staged write, before the move.
        Path target = emptyTarget("missing");
        ArrayNode entries = mapper.createArrayNode();
        for (JsonNode e : validPlus()) {
            if (!e.path("path").asText().startsWith("skills/")) {
                entries.add(e);
            }
        }

        ResponseEntity<?> answer = importInto(target, entries);

        assertRefused(422, "findings", target, answer);
        assertTrue(json(answer).path("findings").toString().contains("contents.skills[0]"), answer.getBody().toString());
    }

    @Test
    void everyRefusalBeforeTheStagedWriteLeavesTheDiskUntouched() throws IOException {
        // The parent of the target cannot be written, so the staged folder cannot be made: a refusal
        // that comes from the checks in memory still answers its own status, and one that came after
        // a write attempt would answer 500. This pins that paths, duplicates, sizes, the reader and
        // the empty folder rule are all decided before a byte of the bundle reaches the disk.
        Path locked = Files.createDirectories(tmp.resolve("locked"));
        Path target = Files.createDirectories(locked.resolve("t"));
        Path busy = Files.createDirectories(locked.resolve("busy"));
        Files.writeString(busy.resolve("mine.txt"), "mine\n");
        PosixFileAttributeView view = Files.getFileAttributeView(locked, PosixFileAttributeView.class);
        assumeTrue(view != null, "posix permissions are supported here");
        String keyed = PlaybookLoaderTest.MINIMAL.replaceFirst("\\{ \"schema_version\": 1,",
                "{ \"schema_version\": 1, \"apiKey\": \"sk-x\",");
        ArrayNode withKey = mapper.createArrayNode();
        for (JsonNode e : validPlus()) {
            withKey.add("playbook.json".equals(e.path("path").asText()) ? textEntry(mapper, "playbook.json", keyed) : e);
        }
        ArrayNode many = validPlus();
        for (int i = many.size(); i <= PlaybookLoader.MAX_FILES; i++) {
            many.add(textEntry(mapper, "templates/t" + i + ".md", "x\n"));
        }
        Map<String, ArrayNode> cases = new LinkedHashMap<>();
        cases.put("path", validPlus(textEntry(mapper, "../evil.md", "x\n")));
        cases.put("duplicate", validPlus(textEntry(mapper, "templates/SPEC.md", "x\n")));
        cases.put("too-deep", validPlus(textEntry(mapper, pathOfLevels(PlaybookLoader.WALK_DEPTH + 1), "x\n")));
        cases.put("binary", validPlus(mapper.createObjectNode().put("path", "templates/b.bin").put("base64", "AAEC")));
        cases.put("too-large", validPlus(mapper.createObjectNode().put("path", "docs/b.bin")
                .put("base64", Base64.getEncoder().encodeToString(new byte[2 * MB + 1]))));
        cases.put("too-many-files", many);
        cases.put("findings", withKey);
        Set<PosixFilePermission> before = Files.getPosixFilePermissions(locked);
        Files.setPosixFilePermissions(locked, PosixFilePermissions.fromString("r-xr-xr-x"));
        try {
            for (Map.Entry<String, ArrayNode> c : cases.entrySet()) {
                ResponseEntity<?> answer = importInto(target, c.getValue());
                assertEquals(c.getKey(), json(answer).path("reason").asText(), c.getKey() + ": " + answer.getBody());
            }
            assertEquals("not-empty", json(importInto(busy, validPlus())).path("reason").asText());
            assertEquals("failed", json(importInto(target, validPlus())).path("reason").asText(),
                    "premise: a bundle that passes every check does need the parent to be writable");
        } finally {
            Files.setPosixFilePermissions(locked, before);
        }
        assertEquals(List.of("busy", "t"), names(locked));
        assertEquals(List.of(), listing(target));
    }

    @Test
    void theStagedFolderIsMovedOnlyOntoAFolderThatIsStillEmpty() throws IOException {
        Path staged = Files.createDirectories(tmp.resolve("targets/.staged"));
        Files.writeString(staged.resolve("playbook.json"), "{}");
        Path target = emptyTarget("raced");
        Files.writeString(target.resolve("late.txt"), "came in between\n");

        assertFalse(PlaybookBundle.moveOnto(staged, target), "a folder that filled up meanwhile is not replaced");

        assertEquals(List.of("late.txt"), listing(target));
        Path empty = emptyTarget("calm");
        assertTrue(PlaybookBundle.moveOnto(staged, empty));
        assertEquals(List.of("playbook.json"), listing(empty));
        assertFalse(Files.exists(staged));
    }

    @Test
    void importInstallsNothing() throws IOException {
        write(spectroHome, "hooks/guard.sh", "#!/bin/sh\necho guard\n");
        Files.writeString(userSettings, """
                { "hooks": [ { "event": "pre_tool_use", "command": "bash %s/guard.sh" } ] }
                """.formatted(spectroHome.resolve("hooks")));
        assertEquals(200, controller.importHooks(mapper.createObjectNode().put("dir", dir.toString()), local())
                .getStatusCode().value());
        // The colleague's machine: no hooks in the settings, so an installed hook would show.
        Files.writeString(userSettings, "{}\n");
        String settingsBefore = Files.readString(userSettings);
        List<String> homeBefore = listing(spectroHome);
        Path target = emptyTarget("noinstall");

        assertEquals(200, importInto(target, entriesOf(dir)).getStatusCode().value());

        assertEquals(settingsBefore, Files.readString(userSettings), "the settings are not touched");
        assertEquals(homeBefore, listing(spectroHome), "no skill and no hook script is installed");
        assertFalse(Files.exists(ledgerFile), "the install ledger records nothing");
        ResponseEntity<?> preview = controller.contents(target.toString(), null, local());
        PlaybookContents.Preview shown = (PlaybookContents.Preview) preview.getBody();
        assertNotNull(shown);
        assertTrue(shown.items().stream().anyMatch(i -> i.kind().equals("hook")), shown.items().toString());
        assertTrue(shown.items().stream().filter(i -> i.kind().equals("hook")).allMatch(i -> i.state().equals("new")),
                "the install preview lists the hooks as not installed: " + shown.items());
    }

    @Test
    void importIsHiddenFromAForeignCallerAndAForeignOrigin() throws IOException {
        Path target = emptyTarget("fenced");
        ObjectNode body = mapper.createObjectNode().put("dir", target.toString());
        body.set("entries", validPlus());

        assertEquals(404, controller.importBundle(body.toString(), foreign()).getStatusCode().value());
        assertEquals(404, controller.importBundle(body.toString(), crossSite()).getStatusCode().value());
        assertEquals(List.of(), listing(target));
    }

    @Test
    void importRefusesABodyThatIsNotTheShape() throws IOException {
        Path target = emptyTarget("shape");
        assertEquals(400, controller.importBundle("not json", local()).getStatusCode().value());
        assertEquals(400, controller.importBundle(mapper.createObjectNode().put("dir", target.toString()).toString(),
                local()).getStatusCode().value());
        ArrayNode neither = validPlus(mapper.createObjectNode().put("path", "templates/x.md"));
        assertRefused(400, "bad-request", target, importInto(target, neither));
        ArrayNode badBase64 = validPlus(mapper.createObjectNode().put("path", "docs/x.bin").put("base64", "!!!"));
        assertRefused(400, "bad-request", target, importInto(target, badBase64));
    }

    // ---- AC4: the round trip -------------------------------------------------------------------

    @Test
    void theSpectroCopyRoundTripsWithTheSameTreeHash() throws IOException {
        Path source = Files.createDirectories(tmp.resolve("spectro-copy"));
        ResponseEntity<?> copied = controller.copy("spectro", mapper.createObjectNode().put("dir", source.toString()),
                local());
        assertEquals(200, copied.getStatusCode().value(), String.valueOf(copied.getBody()));
        assertTrue(SafeWalk.walk(source, source).files().size() > 50, "premise: the whole pack was copied");
        Path target = emptyTarget("spectro-again");

        ResponseEntity<?> answer = importInto(target, entriesOf(source));

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(treeHash(source), treeHash(target));
        assertEquals("spectro", json(answer).path("playbook").path("id").asText());
    }

    @Test
    void aFolderWithAnImportedSkillPackAndHooksRoundTripsWithItsContents() throws IOException {
        write(spectroHome, "skills/mypack/alpha/SKILL.md", "---\nname: alpha\ndescription: the alpha skill\n---\nDo alpha.\n");
        ObjectNode skills = mapper.createObjectNode().put("dir", dir.toString());
        skills.putArray("items").addObject().put("source", "installed").put("pack", "mypack").put("name", "alpha");
        assertEquals(200, controller.importSkills(skills, local()).getStatusCode().value());
        write(spectroHome, "hooks/guard.sh", "#!/bin/sh\necho guard\n");
        Files.writeString(userSettings, """
                { "hooks": [ { "event": "pre_tool_use", "matcher": "run_command", "command": "bash %s/guard.sh" } ] }
                """.formatted(spectroHome.resolve("hooks")));
        assertEquals(200, controller.importHooks(mapper.createObjectNode().put("dir", dir.toString()), local())
                .getStatusCode().value());
        Playbook before = PlaybookReader.read(Files.readString(dir.resolve("playbook.json"))).playbook();
        assertTrue(before.contents().hooks().contains("hooks/hooks.json"), "premise: the hooks are listed");
        Path target = emptyTarget("assembled");

        assertEquals(200, importInto(target, entriesOf(dir)).getStatusCode().value());

        assertEquals(treeHash(dir), treeHash(target));
        Playbook after = PlaybookReader.read(Files.readString(target.resolve("playbook.json"))).playbook();
        assertEquals(before.contents(), after.contents());
        assertEquals(List.of(), PlaybookLoader.contentsFindings(target.toRealPath(), after.contents()));
    }

    // ---- card 538: a credential in a hook command ------------------------------------------------

    /** The playbook.json of the fixture with hooks/hooks.json listed. */
    private static String withHooksListed() {
        return PlaybookLoaderTest.MINIMAL.replace("\"contents\": { \"skills\": [\"skills/spectropowers\"] }",
                "\"contents\": { \"skills\": [\"skills/spectropowers\"], \"hooks\": [\"hooks/hooks.json\"] }");
    }

    /** A hooks file whose second entry's command, on line 4, runs {@code echo <value>}. */
    private String hooksWith(String value) throws IOException {
        return "[\n  {\"event\": \"pre_tool_use\", \"command\": \"echo plain\"},\n  {\"event\": \"post_tool_use\",\n"
                + "   \"command\": " + mapper.writeValueAsString("echo " + value) + "}\n]\n";
    }

    private void listHooks(String hooksJson) throws IOException {
        Files.writeString(dir.resolve("playbook.json"), withHooksListed());
        write(dir, "hooks/hooks.json", hooksJson);
    }

    /** The refusal names the file, the line and the rule, and carries no part of the value. */
    private void assertNamesLineAndRule(JsonNode body, String rule, String value) {
        String text = body.toString();
        assertTrue(body.path("message").asText().contains("hooks/hooks.json"), text);
        assertTrue(body.path("message").asText().contains("line 4"), text);
        assertTrue(body.path("message").asText().contains(rule), text);
        assertEquals("hooks/hooks.json:4", body.path("findings").get(0).path("path").asText(), text);
        assertTrue(body.path("findings").get(0).path("message").asText().contains(rule), text);
        String tail = value.substring(value.length() - 12);
        assertFalse(text.contains(value) || text.contains(tail), "the refusal never carries the value: " + text);
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("dev.spectroscope.server.playbooks.HookTokenVectors#families")
    void exportRefusesAHookCommandWithACredentialWith422AndStreamsNothing(String rule, String value) throws IOException {
        listHooks(hooksWith(value));

        ResponseEntity<?> answer = controller.exportBundle(dir.toString(), local());

        assertEquals(422, answer.getStatusCode().value(), String.valueOf(json(answer)));
        assertEquals("application/json", String.valueOf(answer.getHeaders().getContentType()));
        assertEquals("token", json(answer).path("reason").asText());
        assertNamesLineAndRule(json(answer), rule, value);
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("dev.spectroscope.server.playbooks.HookTokenVectors#families")
    void importRefusesAHookCommandWithACredentialWith422AndWritesNothing(String rule, String value) throws IOException {
        listHooks(hooksWith("plain-words"));
        ArrayNode entries = entriesOf(dir);
        for (JsonNode entry : entries) {
            if (entry.path("path").asText().equals("hooks/hooks.json")) {
                ((ObjectNode) entry).put("text", hooksWith(value));
            }
        }
        Path target = emptyTarget("token-" + rule);

        ResponseEntity<?> answer = importInto(target, entries);

        assertRefused(422, "token", target, answer);
        assertNamesLineAndRule(json(answer), rule, value);
    }

    @Test
    void importAsksTheHooksFileInAnyCaseOfItsName() throws IOException {
        String value = HookTokenVectors.BY_RULE.get("slack-token");
        listHooks(hooksWith("plain-words"));
        ArrayNode entries = mapper.createArrayNode();
        for (JsonNode entry : entriesOf(dir)) {
            if (entry.path("path").asText().equals("hooks/hooks.json")) {
                entries.add(textEntry(mapper, "Hooks/Hooks.json", hooksWith(value)));
            } else {
                entries.add(entry);
            }
        }
        Path target = emptyTarget("upper");

        ResponseEntity<?> answer = importInto(target, entries);

        assertRefused(422, "token", target, answer);
        assertTrue(json(answer).path("message").asText().startsWith("Hooks/Hooks.json line 4"), String.valueOf(json(answer)));
    }

    @Test
    void aHookCommandThatOnlyTalksAboutAKeyStillTravels() throws IOException {
        listHooks(hooksWith("bearer authentication is the preferred mechanism"));
        Path target = emptyTarget("prose");

        ResponseEntity<?> imported = importInto(target, entriesOf(dir));

        assertEquals(200, imported.getStatusCode().value(), String.valueOf(imported.getBody()));
        assertEquals(Files.readString(dir.resolve("hooks/hooks.json")), Files.readString(target.resolve("hooks/hooks.json")));
    }

    @Test
    void aHooksFileThatIsNotJsonIsSearchedLineByLine() throws IOException {
        String broken = hooksWith(HookTokenVectors.BY_RULE.get("bearer")).replace("]\n", "");
        listHooks(broken);

        ResponseEntity<?> answer = controller.exportBundle(dir.toString(), local());

        assertEquals(422, answer.getStatusCode().value(), String.valueOf(json(answer)));
        assertNamesLineAndRule(json(answer), "bearer", HookTokenVectors.BY_RULE.get("bearer"));
    }

    // ---- card 538 restart review: the matcher, a field name, and more than one hit ---------------

    /** A hooks file whose second entry, from line 3, carries {@code value} as its matcher on line 4. */
    private String hooksWithMatcher(String value) throws IOException {
        return "[\n  {\"event\": \"pre_tool_use\", \"command\": \"echo plain\"},\n  {\"event\": \"post_tool_use\",\n"
                + "   \"matcher\": " + mapper.writeValueAsString(value) + ", \"command\": \"echo ok\"}\n]\n";
    }

    @Test
    void exportAndImportRefuseACredentialInTheMatcherAndNameTheField() throws IOException {
        String value = HookTokenVectors.BY_RULE.get("github-pat");
        listHooks(hooksWithMatcher(value));

        ResponseEntity<?> exported = controller.exportBundle(dir.toString(), local());

        assertEquals(422, exported.getStatusCode().value(), String.valueOf(json(exported)));
        assertNamesLineAndRule(json(exported), "github-pat", value);
        assertTrue(json(exported).path("findings").get(0).path("message").asText().contains("matcher"),
                String.valueOf(json(exported)));

        listHooks(hooksWithMatcher("run_command"));
        ArrayNode entries = entriesOf(dir);
        for (JsonNode entry : entries) {
            if (entry.path("path").asText().equals("hooks/hooks.json")) {
                ((ObjectNode) entry).put("text", hooksWithMatcher(value));
            }
        }
        Path target = emptyTarget("matcher");

        ResponseEntity<?> imported = importInto(target, entries);

        assertRefused(422, "token", target, imported);
        assertNamesLineAndRule(json(imported), "github-pat", value);
    }

    @Test
    void aCredentialAsAFieldNameIsRefusedAndTheNameIsNotEchoed() throws IOException {
        String value = HookTokenVectors.BY_RULE.get("slack-token");
        listHooks("[\n  {\"event\": \"pre_tool_use\", \"command\": \"echo plain\"},\n  {\"event\": \"post_tool_use\",\n"
                + "   " + mapper.writeValueAsString(value) + ": \"x\", \"command\": \"echo ok\"}\n]\n");

        ResponseEntity<?> answer = controller.exportBundle(dir.toString(), local());

        assertEquals(422, answer.getStatusCode().value(), String.valueOf(json(answer)));
        assertNamesLineAndRule(json(answer), "slack-token", value);
    }

    @Test
    void twoHitsAreNamedAsTheFirstAndOneMore() throws IOException {
        String bearer = HookTokenVectors.BY_RULE.get("bearer");
        listHooks("[\n  {\"event\": \"pre_tool_use\", \"command\": \"echo plain\"},\n  {\"event\": \"post_tool_use\",\n"
                + "   \"command\": " + mapper.writeValueAsString("echo " + bearer) + "},\n"
                + "  {\"event\": \"post_tool_use\", \"command\": " + mapper.writeValueAsString("echo " + bearer) + "}\n]\n");

        ResponseEntity<?> answer = controller.exportBundle(dir.toString(), local());

        assertEquals(422, answer.getStatusCode().value(), String.valueOf(json(answer)));
        assertNamesLineAndRule(json(answer), "bearer", bearer);
        assertEquals(2, json(answer).path("findings").size(), String.valueOf(json(answer)));
        assertTrue(json(answer).path("message").asText().contains("(and 1 more)"), String.valueOf(json(answer)));
    }
}
