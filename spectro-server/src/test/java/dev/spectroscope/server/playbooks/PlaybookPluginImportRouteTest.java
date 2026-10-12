package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.playbook.AgentFile;
import dev.spectroscope.core.playbook.Finding;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 526: the Plugin tab's two routes. {@code GET /api/playbooks/plugin-sources} lists the Claude
 * Code plugins of this home by label; {@code POST /api/playbooks/import-plugin} copies the chosen
 * kinds of one of them into a registered playbook folder, maps each onto the playbook's format and
 * names what the format does not carry. The fixture plugin under {@code plugin-fixture/fixture}
 * carries all five kinds of a plugin (skills, agents, commands, hooks, MCP servers) and an
 * {@code .mcp.json}.
 */
class PlaybookPluginImportRouteTest {

    @TempDir Path tmp;

    private final ObjectMapper mapper = new ObjectMapper();
    private PlaybookFolders folders;
    private PlaybookController controller;
    private Path dir;
    private Path home;
    private Path spectroHome;
    private Path userSettings;
    private Path launch;
    private Path ledger;

    @BeforeEach
    void setUp() throws IOException {
        folders = new PlaybookFolders(tmp.resolve("playbooks.json"));
        home = Files.createDirectories(tmp.resolve("home"));
        spectroHome = Files.createDirectories(home.resolve(".spectro"));
        userSettings = spectroHome.resolve("settings.json");
        launch = Files.createDirectories(tmp.resolve("launch"));
        ledger = tmp.resolve("ledger/playbook-installs.json");
        controller = new PlaybookController(folders, PlaybookController.BUNDLE_ROOT, new InstallLedger(ledger),
                spectroHome, launch, userSettings);
        dir = Files.createDirectories(tmp.resolve("pb"));
        Files.writeString(dir.resolve("playbook.json"), PlaybookLoaderTest.MINIMAL);
        write(dir, "skills/spectropowers/brainstorming/SKILL.md", "---\nname: brainstorming\ndescription: d\n---\nbody\n");
        write(dir, "templates/spec.md", "# Goal\n");
        write(dir, "LICENSE", "MIT\n");
        write(dir, "PROVENANCE.md", "# Provenance\n\nmade here\n");
        folders.register(dir);
    }

    // ---- fixtures ------------------------------------------------------------------------------

    private static Path fixture() {
        try {
            return Path.of(PlaybookPluginImportRouteTest.class.getResource("/plugin-fixture/fixture").toURI());
        } catch (URISyntaxException bad) {
            throw new IllegalStateException(bad);
        }
    }

    private static Path write(Path base, String rel, String text) throws IOException {
        Path file = base.resolve(rel);
        Files.createDirectories(file.getParent());
        return Files.writeString(file, text);
    }

    private static void copyTree(Path from, Path to) throws IOException {
        try (Stream<Path> walk = Files.walk(from)) {
            for (Path p : walk.toList()) {
                Path target = to.resolve(from.relativize(p).toString());
                if (Files.isDirectory(p)) {
                    Files.createDirectories(target);
                } else {
                    Files.createDirectories(target.getParent());
                    Files.copy(p, target);
                }
            }
        }
    }

    private Path plugins() {
        return home.resolve(".claude").resolve("plugins");
    }

    /** The fixture copied to {@code ~/.claude/plugins/cache/<market>/<name>/<version>/}. */
    private Path seedCache(String market, String name, String version) throws IOException {
        Path folder = plugins().resolve("cache").resolve(market).resolve(name).resolve(version);
        copyTree(fixture(), folder);
        if (!name.equals("fixture")) {
            Path manifest = folder.resolve(".claude-plugin/plugin.json");
            Files.writeString(manifest, Files.readString(manifest).replace("\"name\": \"fixture\"", "\"name\": \"" + name + "\""));
        }
        return folder;
    }

    /** A marketplace with the fixture under {@code plugins/fixture}, a remote entry and one that leaves the folder. */
    private Path seedMarketplace(String market) throws IOException {
        Path folder = plugins().resolve("marketplaces").resolve(market);
        copyTree(fixture(), folder.resolve("plugins/fixture"));
        Files.createDirectories(plugins().resolve("marketplaces").resolve("outside"));
        copyTree(fixture(), plugins().resolve("marketplaces").resolve("outside-plugin"));
        write(folder, ".claude-plugin/marketplace.json", """
                {"name": "%s", "plugins": [
                  {"name": "fixture", "version": "0.9.0", "source": "./plugins/fixture"},
                  {"name": "remote", "source": {"source": "url", "url": "https://example.com/remote.git"}},
                  {"name": "escape", "source": "../outside-plugin"}
                ]}
                """.formatted(market));
        return folder;
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

    private ObjectNode request(String root, String market, String name, String version, String... kinds) {
        ObjectNode body = mapper.createObjectNode().put("dir", dir.toString());
        ObjectNode plugin = body.putObject("plugin");
        if (root != null) {
            plugin.put("root", root);
        }
        plugin.put("marketplace", market).put("name", name).put("version", version);
        ArrayNode list = body.putArray("kinds");
        for (String kind : kinds) {
            list.add(kind);
        }
        return body;
    }

    private ResponseEntity<?> importFixture(String... kinds) {
        return controller.importPlugin(request(null, "test", "fixture", "1.0.0", kinds), local());
    }

    private static final String[] ALL = {"skills", "agents", "commands", "hooks"};

    private Playbook playbook() throws IOException {
        Playbook p = PlaybookReader.read(Files.readString(dir.resolve("playbook.json"))).playbook();
        assertNotNull(p, "the playbook still reads");
        return p;
    }

    /** Every file below the playbook folder with its hash, for "nothing was written". */
    private Map<String, String> snapshot() throws IOException {
        return snapshot(dir);
    }

    private static Map<String, String> snapshot(Path base) throws IOException {
        Map<String, String> out = new TreeMap<>();
        if (!Files.exists(base)) {
            return out;
        }
        try (Stream<Path> walk = Files.walk(base)) {
            for (Path p : walk.toList()) {
                String rel = base.relativize(p).toString();
                if (Files.isSymbolicLink(p)) {
                    out.put(rel, "link");
                } else if (Files.isDirectory(p)) {
                    out.put(rel + "/", "dir");
                } else {
                    out.put(rel, EditorView.sha256(Files.readAllBytes(p)));
                }
            }
        }
        return out;
    }

    /** Every regular file of the playbook folder with its text. */
    private Map<String, String> texts() throws IOException {
        Map<String, String> out = new TreeMap<>();
        try (Stream<Path> walk = Files.walk(dir)) {
            for (Path p : walk.filter(Files::isRegularFile).toList()) {
                out.put(dir.relativize(p).toString(), Files.readString(p, StandardCharsets.ISO_8859_1));
            }
        }
        return out;
    }

    /** The entry has no folder finding and the install preview lists it with a hash and no finding. */
    private void assertClean(String kind, String entry, String itemKind) throws IOException {
        Playbook p = playbook();
        List<String> listed = switch (kind) {
            case "skills" -> p.contents().skills();
            case "agents" -> p.contents().agents();
            case "hooks" -> p.contents().hooks();
            default -> p.contents().commands();
        };
        assertTrue(listed.contains(entry), kind + " lists " + entry + ": " + listed);
        List<Finding> folder = PlaybookLoader.contentsFindings(dir.toRealPath(), p.contents());
        assertEquals(List.of(), folder, "no folder finding");
        ResponseEntity<?> preview = controller.contents(dir.toString(), null, local());
        assertEquals(200, preview.getStatusCode().value());
        PlaybookContents.Preview shown = (PlaybookContents.Preview) preview.getBody();
        assertEquals(List.of(), shown.findings().stream()
                .filter(f -> f.path().startsWith(entry)).toList(), "no preview finding under " + entry);
        assertTrue(shown.items().stream().anyMatch(i -> i.kind().equals(itemKind) && i.source().startsWith(entry)
                        && i.sha256() != null && i.sha256().length() == 64),
                "the preview lists a " + itemKind + " from " + entry + " with its hash: " + shown.items());
    }

    private static List<String> texts(JsonNode array) {
        List<String> out = new ArrayList<>();
        array.forEach(n -> out.add(n.asText()));
        return out;
    }

    private static List<String> dropped(JsonNode answer) {
        List<String> out = new ArrayList<>();
        answer.path("dropped").forEach(d -> out.add(d.path("path").asText() + " " + d.path("field").asText("-")
                + " " + d.path("reason").asText()));
        return out;
    }

    private static List<String> droppedHooks(JsonNode answer) {
        List<String> out = new ArrayList<>();
        answer.path("droppedHooks").forEach(d -> out.add(d.path("event").asText() + " "
                + d.path("matcher").asText("*") + " " + d.path("reason").asText()));
        return out;
    }

    // ---- criterion 1: the sources --------------------------------------------------------------

    @Test
    void pluginSourcesListsThePluginsOfTheCacheAndTheMarketplacesByLabel() throws IOException {
        seedCache("test", "fixture", "1.0.0");
        seedMarketplace("market");

        ResponseEntity<?> answer = controller.pluginSources(dir.toString(), local());

        assertEquals(200, answer.getStatusCode().value());
        JsonNode rows = json(answer).path("plugins");
        List<String> seen = new ArrayList<>();
        rows.forEach(r -> seen.add(r.path("root").asText() + " " + r.path("marketplace").asText() + " "
                + r.path("name").asText() + " " + r.path("version").asText()));
        assertEquals(List.of("cache test fixture 1.0.0", "marketplace market fixture 1.0.0"), seen,
                "the cache plugin by its folders, the marketplace plugin by its entry and plugin.json; "
                        + "a remote entry and one that leaves the marketplace folder are not listed");
        JsonNode row = rows.get(0);
        assertEquals(2, row.path("kinds").path("skills").asInt(), row.toString());
        assertEquals(2, row.path("kinds").path("agents").asInt(), row.toString());
        assertEquals(3, row.path("kinds").path("commands").asInt(), row.toString());
        assertEquals(5, row.path("kinds").path("hooks").asInt(), row.toString());
        assertTrue(row.path("mcp").asBoolean(), "the row says the plugin carries MCP servers: " + row);
        assertTrue(row.path("licensed").asBoolean(), row.toString());
        assertTrue(row.path("description").asText().startsWith("A small plugin"), row.toString());
    }

    @Test
    void aHomeWithoutThePluginFoldersListsNothing() {
        ResponseEntity<?> answer = controller.pluginSources(dir.toString(), local());

        assertEquals(200, answer.getStatusCode().value());
        assertTrue(json(answer).path("plugins").isArray());
        assertEquals(0, json(answer).path("plugins").size());
    }

    @Test
    void theListingEchoesNoPathOfTheMachine() throws IOException {
        seedCache("test", "fixture", "1.0.0");
        seedMarketplace("market");

        String body = mapper.writeValueAsString(controller.pluginSources(dir.toString(), local()).getBody());

        assertFalse(body.contains(tmp.toString()), body);
        assertFalse(body.contains(tmp.toRealPath().toString()), body);
        assertFalse(body.contains("/plugins/"), body);
    }

    @Test
    void aLinkedPluginFolderIsNotListedAndNotImported() throws IOException {
        Path real = seedCache("test", "fixture", "1.0.0");
        Path linked = plugins().resolve("cache/test/linked");
        Files.createDirectories(linked);
        Files.createSymbolicLink(linked.resolve("1.0.0"), real);

        List<String> names = new ArrayList<>();
        json(controller.pluginSources(dir.toString(), local())).path("plugins")
                .forEach(r -> names.add(r.path("name").asText()));
        assertEquals(List.of("fixture"), names);

        Map<String, String> before = snapshot();
        ResponseEntity<?> answer = controller.importPlugin(request(null, "test", "linked", "1.0.0", "skills"), local());
        assertEquals(404, answer.getStatusCode().value());
        assertEquals(before, snapshot());
    }

    // ---- the fence -----------------------------------------------------------------------------

    @Test
    void bothRoutesAnswer404WithNoBodyForAForeignCallerAndAnUnregisteredFolder() throws IOException {
        seedCache("test", "fixture", "1.0.0");
        Map<String, String> before = snapshot();
        for (MockHttpServletRequest stranger : List.of(foreign(), crossSite())) {
            ResponseEntity<?> list = controller.pluginSources(dir.toString(), stranger);
            assertEquals(404, list.getStatusCode().value());
            assertEquals(null, list.getBody());
            ResponseEntity<?> imported = controller.importPlugin(request(null, "test", "fixture", "1.0.0", ALL),
                    stranger);
            assertEquals(404, imported.getStatusCode().value());
            assertEquals(null, imported.getBody());
        }
        Path other = Files.createDirectories(tmp.resolve("other"));
        Files.writeString(other.resolve("playbook.json"), PlaybookLoaderTest.MINIMAL);
        assertEquals(404, controller.pluginSources(other.toString(), local()).getStatusCode().value());
        ObjectNode body = request(null, "test", "fixture", "1.0.0", ALL).put("dir", other.toString());
        assertEquals(404, controller.importPlugin(body, local()).getStatusCode().value());
        assertEquals(before, snapshot());
        assertFalse(Files.exists(other.resolve("skills")));
    }

    @Test
    void theTwoRoutesAreMappedOnThePlaybookController() throws NoSuchMethodException {
        GetMapping get = PlaybookController.class.getMethod("pluginSources", String.class,
                jakarta.servlet.http.HttpServletRequest.class).getAnnotation(GetMapping.class);
        assertArrayEquals(new String[] {"/api/playbooks/plugin-sources"}, get.value());
        PostMapping post = PlaybookController.class.getMethod("importPlugin", JsonNode.class,
                jakarta.servlet.http.HttpServletRequest.class).getAnnotation(PostMapping.class);
        assertArrayEquals(new String[] {"/api/playbooks/import-plugin"}, post.value());
    }

    // ---- security: only the two known roots, only listed plugins -------------------------------

    @Test
    void aPluginThatIsNotListedAnswers404() throws IOException {
        seedCache("test", "fixture", "1.0.0");
        seedMarketplace("market");
        Map<String, String> before = snapshot();
        List<ObjectNode> unknown = List.of(
                request(null, "test", "nope", "1.0.0", "skills"),
                request(null, "test", "fixture", "2.0.0", "skills"),
                request(null, "other", "fixture", "1.0.0", "skills"),
                request(null, "test", "../test/fixture", "1.0.0", "skills"),
                request(null, "..", "cache", "test", "skills"),
                request("cache", "market", "fixture", "1.0.0", "skills"),
                request("marketplace", "market", "escape", "", "skills"),
                request("marketplace", "market", "remote", "", "skills"),
                request("elsewhere", "test", "fixture", "1.0.0", "skills"));
        for (ObjectNode body : unknown) {
            ResponseEntity<?> answer = controller.importPlugin(body, local());
            assertEquals(404, answer.getStatusCode().value(), body.toString());
            assertEquals(null, answer.getBody(), body.toString());
        }
        assertEquals(before, snapshot());
    }

    @Test
    void aMarketplacePluginImportsFromItsMarketplaceFolder() throws IOException {
        seedMarketplace("market");

        ResponseEntity<?> answer = controller.importPlugin(
                request("marketplace", "market", "fixture", "1.0.0", "skills"), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertTrue(Files.isRegularFile(dir.resolve("skills/fixture/alpha/SKILL.md")));
        String provenance = Files.readString(dir.resolve("PROVENANCE.md"));
        assertTrue(provenance.contains("market"), provenance);
    }

    // ---- criterion 2: the mapping per kind ------------------------------------------------------

    @Test
    void skillsLandAsOnePackNamedLikeThePluginWithItsLicence() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");

        ResponseEntity<?> answer = importFixture("skills");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(Files.readString(source.resolve("skills/alpha/SKILL.md")),
                Files.readString(dir.resolve("skills/fixture/alpha/SKILL.md")));
        assertEquals(Files.readString(source.resolve("skills/alpha/references/notes.md")),
                Files.readString(dir.resolve("skills/fixture/alpha/references/notes.md")));
        assertEquals(Files.readString(source.resolve("skills/beta/SKILL.md")),
                Files.readString(dir.resolve("skills/fixture/beta/SKILL.md")));
        for (String skill : List.of("alpha", "beta")) {
            assertEquals(Files.readString(source.resolve("LICENSE")),
                    Files.readString(dir.resolve("skills/fixture/" + skill + "/LICENSE")), skill);
        }
        assertEquals(List.of("skills/fixture/alpha", "skills/fixture/beta"),
                texts(json(answer).path("imported").path("skills")));
        assertFalse(Files.exists(dir.resolve("agents")), "only the chosen kind is copied");
        assertFalse(Files.exists(dir.resolve("commands")));
        assertFalse(Files.exists(dir.resolve("hooks")));
        assertClean("skills", "skills/fixture", "skill");
    }

    @Test
    void agentsKeepTheFourAllowedFieldsAndNameTheRest() throws IOException {
        seedCache("test", "fixture", "1.0.0");

        ResponseEntity<?> answer = importFixture("agents");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        String critic = Files.readString(dir.resolve("agents/critic.md"));
        assertEquals("""
                ---
                name: critic
                description: Reads a change and says what is wrong with it.
                type: worker
                ---

                You are the critic. Read the change, name each defect with its file and line, and stop.
                """, critic);
        String scout = Files.readString(dir.resolve("agents/scout.md"));
        assertTrue(scout.startsWith("""
                ---
                name: scout
                description: Looks around the repository and reports what it found.
                type: explore
                ---
                """), scout);
        for (String rel : List.of("agents/critic.md", "agents/scout.md")) {
            AgentFile.Read read = AgentFile.read(Files.readString(dir.resolve(rel)), rel);
            assertNotNull(read.agent(), rel);
            assertEquals(List.of(), read.findings(), rel);
        }
        List<String> dropped = dropped(json(answer));
        assertTrue(dropped.contains("agents/critic.md tools set-by-others"), dropped.toString());
        assertTrue(dropped.contains("agents/critic.md model set-by-others"), dropped.toString());
        assertTrue(dropped.contains("agents/critic.md color not-a-playbook-field"), dropped.toString());
        assertTrue(dropped.contains("agents/critic.md mcpServers refused"), dropped.toString());
        assertTrue(dropped.contains("agents/scout.md effort not-a-playbook-field"), dropped.toString());
        assertEquals(5, dropped.size(), dropped.toString());
        assertEquals(List.of("agents/critic.md", "agents/scout.md"), playbook().contents().agents());
        assertClean("agents", "agents/critic.md", "agent");
        assertClean("agents", "agents/scout.md", "agent");
    }

    @Test
    void anAgentWithoutAValidTypeIsAWorkerAndSaysSo() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        write(source, "agents/odd.md", "---\nname: odd\ndescription: An odd one.\ntype: manager\n---\n\nBe odd.\n");

        ResponseEntity<?> answer = importFixture("agents");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertTrue(Files.readString(dir.resolve("agents/odd.md")).contains("\ntype: worker\n"));
        assertTrue(dropped(json(answer)).contains("agents/odd.md type type"), dropped(json(answer)).toString());
    }

    @Test
    void commandsLandAsPromptFilesAndANestedOneIsNamed() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");

        ResponseEntity<?> answer = importFixture("commands");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(Files.readString(source.resolve("commands/ship.md")),
                Files.readString(dir.resolve("commands/ship.md")), "a command with a description is copied as it is");
        String quick = Files.readString(dir.resolve("commands/quick.md"));
        assertEquals("---\ndescription: Summarise the open changes in three lines.\n---\n\n"
                + Files.readString(source.resolve("commands/quick.md")), quick,
                "a command without a description gets its first line as one, as Claude Code shows it");
        assertFalse(Files.exists(dir.resolve("commands/ns")));
        assertTrue(dropped(json(answer)).contains("commands/ns/deep.md - nested"), dropped(json(answer)).toString());
        assertEquals(List.of("commands/quick.md", "commands/ship.md"), playbook().contents().commands());
        assertClean("commands", "commands/ship.md", "command");
        assertClean("commands", "commands/quick.md", "command");
    }

    @Test
    void hooksMapPreAndPostToolUseAndNameTheRest() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        JsonNode hooks = mapper.readTree(Files.readString(dir.resolve("hooks/hooks.json")));
        assertEquals(mapper.readTree("""
                [ {"event": "pre_tool_use", "matcher": "Bash", "command": "\\"{hooks}/guard.sh\\" --strict",
                   "timeoutSeconds": 10},
                  {"event": "post_tool_use", "matcher": "Edit|Write", "command": "echo fixture-post"} ]
                """), hooks);
        assertEquals(Files.readString(source.resolve("hooks/guard.sh")), Files.readString(dir.resolve("hooks/guard.sh")));
        List<String> dropped = droppedHooks(json(answer));
        assertEquals(List.of("PreToolUse Bash type", "SessionStart startup event", "UserPromptSubmit * event"),
                dropped);
        assertEquals(List.of("hooks/hooks.json"), playbook().contents().hooks());
        assertEquals(List.of("hooks/guard.sh"), texts(json(answer).path("imported").path("scripts")));
        assertClean("hooks", "hooks/hooks.json", "hook");
    }

    @Test
    void aHookThatNamesAPluginFileThatIsNotCopiedIsDroppedAndNamed() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        Files.writeString(source.resolve("hooks/hooks.json"), """
                {"hooks": {"PreToolUse": [{"matcher": "Read", "hooks": [
                  {"type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/missing.sh"},
                  {"type": "command", "command": "$CLAUDE_PLUGIN_ROOT/hooks"},
                  {"type": "command", "command": "echo ${CLAUDE_PLUGIN_DATA}"}]}]}}
                """);

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("PreToolUse Read plugin-root", "PreToolUse Read plugin-root", "PreToolUse Read plugin-root"),
                droppedHooks(json(answer)));
        assertFalse(Files.exists(dir.resolve("hooks")), "no hook was left, so no hooks.json is written");
        assertTrue(playbook().contents().hooks().isEmpty());
    }

    @Test
    void hooksAreAddedToAHooksJsonThePlaybookHasAndAScriptOfTheSameNameWithOtherTextIsRefused() throws IOException {
        seedCache("test", "fixture", "1.0.0");
        write(dir, "hooks/hooks.json", "[ {\"event\": \"pre_tool_use\", \"matcher\": \"Write\", \"command\": \"echo mine\"} ]\n");

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        JsonNode hooks = mapper.readTree(Files.readString(dir.resolve("hooks/hooks.json")));
        assertEquals(3, hooks.size(), hooks.toString());
        assertEquals("echo mine", hooks.get(0).path("command").asText());

        ResponseEntity<?> again = importFixture("hooks");
        assertEquals(200, again.getStatusCode().value());
        assertEquals(3, mapper.readTree(Files.readString(dir.resolve("hooks/hooks.json"))).size(),
                "the same entries are not added twice");

        Files.writeString(dir.resolve("hooks/guard.sh"), "#!/bin/sh\necho mine\n");
        Map<String, String> before = snapshot();
        ResponseEntity<?> clash = importFixture("hooks");
        assertEquals(409, clash.getStatusCode().value());
        assertEquals("exists", json(clash).path("reason").asText());
        assertEquals(before, snapshot());
    }

    // ---- criterion 2: MCP servers, the licence, provenance --------------------------------------

    @Test
    void nothingFromMcpServersOrAnMcpJsonIsWrittenAndTheAnswerNamesIt() throws IOException {
        seedCache("test", "fixture", "1.0.0");

        ResponseEntity<?> answer = importFixture(ALL);

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        for (Map.Entry<String, String> file : texts().entrySet()) {
            assertFalse(file.getKey().endsWith(".mcp.json"), file.getKey());
            for (String name : List.of("fixture-plugin-json-server", "fixture-dot-mcp-server", "fixture-skill-mcp-server",
                    "fixture-agent-mcp-server", "mcpServers")) {
                assertFalse(file.getValue().contains(name), file.getKey() + " carries " + name);
            }
        }
        assertEquals(List.of(".claude-plugin/plugin.json#mcpServers", ".mcp.json", "skills/beta/.mcp.json"),
                texts(json(answer).path("notCopied")));
    }

    @Test
    void anUnlicensedPluginCopiesNothing() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        Files.delete(source.resolve("LICENSE"));
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importFixture(ALL);

        assertEquals(400, answer.getStatusCode().value());
        assertEquals("unlicensed", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
        assertFalse(json(controller.pluginSources(dir.toString(), local())).path("plugins").get(0)
                .path("licensed").asBoolean());
    }

    @Test
    void theLicenceAlsoTravelsBesideAgentsCommandsAndHooks() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");

        assertEquals(200, importFixture("agents").getStatusCode().value());

        assertEquals(Files.readString(source.resolve("LICENSE")), Files.readString(dir.resolve("LICENSE.fixture")));
        assertEquals("MIT\n", Files.readString(dir.resolve("LICENSE")), "the playbook's own licence stays");
    }

    @Test
    void provenanceGetsOneLinePerImportedKind() throws IOException {
        seedCache("test", "fixture", "1.0.0");

        assertEquals(200, importFixture(ALL).getStatusCode().value());

        String provenance = Files.readString(dir.resolve("PROVENANCE.md"));
        assertTrue(provenance.startsWith("# Provenance\n\nmade here\n"), provenance);
        List<String> lines = provenance.lines().filter(l -> l.startsWith("- ")).toList();
        assertEquals(4, lines.size(), provenance);
        for (String line : lines) {
            assertTrue(line.contains("plugin fixture 1.0.0") && line.contains("marketplace test"), line);
        }
        assertTrue(lines.get(0).startsWith("- skills/fixture: "), lines.toString());
        assertTrue(lines.get(1).startsWith("- agents/critic.md, agents/scout.md: "), lines.toString());
        assertTrue(lines.get(2).startsWith("- commands/quick.md, commands/ship.md: "), lines.toString());
        assertTrue(lines.get(3).startsWith("- hooks/hooks.json, hooks/guard.sh: "), lines.toString());
    }

    @Test
    void aSecondImportAnswersAlreadyAndOtherContentAtTheTargetIs409() throws IOException {
        seedCache("test", "fixture", "1.0.0");
        assertEquals(200, importFixture(ALL).getStatusCode().value());
        Map<String, String> once = snapshot();

        ResponseEntity<?> again = importFixture("skills", "agents", "commands");
        assertEquals(200, again.getStatusCode().value());
        assertEquals(List.of("skills/fixture/alpha", "skills/fixture/beta", "agents/critic.md", "agents/scout.md",
                "commands/quick.md", "commands/ship.md"), texts(json(again).path("already")));
        assertEquals(once, snapshot(), "nothing changed, PROVENANCE.md included");

        Files.writeString(dir.resolve("agents/critic.md"), "---\nname: critic\ndescription: mine\ntype: worker\n---\n\nMine.\n");
        Map<String, String> before = snapshot();
        ResponseEntity<?> taken = importFixture("agents");
        assertEquals(409, taken.getStatusCode().value());
        assertEquals("exists", json(taken).path("reason").asText());
        assertEquals(before, snapshot());
    }

    // ---- criterion 3: the caps and refusals of card 523 ----------------------------------------

    @Test
    void aPluginWhoseSkillsPassTheFileCapIsRefusedBeforeAnyByteIsRead() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        for (int i = 0; i < PlaybookLoader.MAX_FILES; i++) {
            write(source, "skills/alpha/many/f" + i + ".md", "x\n");
        }
        Files.setPosixFilePermissions(source.resolve("skills/alpha/many/f0.md"), Set.of());
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importFixture("skills");

        assertEquals(413, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("too-many-files", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
    }

    @Test
    void aPluginWhoseSkillsPassTheByteCapIsRefusedBeforeAnyByteIsRead() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        Path blob = source.resolve("skills/alpha/blob.bin");
        try (RandomAccessFile sparse = new RandomAccessFile(blob.toFile(), "rw")) {
            sparse.setLength(PlaybookFiles.MAX_FOLDER_BYTES + 1);
        }
        Files.setPosixFilePermissions(blob, Set.of());
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importFixture("skills");

        assertEquals(413, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("folder-too-large", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
    }

    @Test
    void aFolderThatWouldPassTheFileCapWithThePluginIsRefusedAndNothingIsWritten() throws IOException {
        seedCache("test", "fixture", "1.0.0");
        for (int i = 0; i < PlaybookLoader.MAX_FILES - 8; i++) {
            write(dir, "docs/d" + i + ".md", "x\n");
        }
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importFixture(ALL);

        assertEquals(413, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("too-many-files", json(answer).path("reason").asText());
        assertTrue(json(answer).path("message").asText().endsWith("Nothing was copied."),
                "the import's own count answers before the first file, not the file route halfway through: "
                        + answer.getBody());
        assertEquals(before, snapshot());
    }

    @Test
    void aPluginFileDeeperThanTheLoaderWalksIsRefused() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        write(source, "skills/alpha/a/b/c/deep.md", "deep\n");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importFixture("skills");

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("too-deep", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
    }

    @Test
    void aPluginNamedLikeThePlaybookIdIsRefusedForItsSkills() throws IOException {
        seedCache("test", "p", "1.0.0");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = controller.importPlugin(request(null, "test", "p", "1.0.0", "skills"), local());

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("pack-is-playbook-id", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
    }

    @Test
    void namesOutsideTheSegmentRuleAreRefused() throws IOException {
        seedCache("test", "bad.name", "1.0.0");
        Map<String, String> before = snapshot();
        ResponseEntity<?> plugin = controller.importPlugin(request(null, "test", "bad.name", "1.0.0", "skills"), local());
        assertEquals(400, plugin.getStatusCode().value(), String.valueOf(plugin.getBody()));
        assertEquals("name", json(plugin).path("reason").asText());
        ResponseEntity<?> agents = controller.importPlugin(request(null, "test", "bad.name", "1.0.0", "agents"), local());
        assertEquals(400, agents.getStatusCode().value(), "the plugin's name is checked for every kind, not only "
                + "where it becomes a pack: " + agents.getBody());
        assertEquals("name", json(agents).path("reason").asText());

        Path source = seedCache("test", "fixture", "1.0.0");
        write(source, "agents/Bad Name.md", "---\nname: Bad Name\ndescription: d\n---\n\nBody.\n");
        ResponseEntity<?> agent = importFixture("agents");
        assertEquals(400, agent.getStatusCode().value(), String.valueOf(agent.getBody()));
        assertEquals("name", json(agent).path("reason").asText());
        assertEquals(before, snapshot());
    }

    @Test
    void aSkillWhoseSkillMdNamesAnotherSkillIsRefused() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        Files.writeString(source.resolve("skills/beta/SKILL.md"), "---\nname: gamma\ndescription: d\n---\nbody\n");
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importFixture("skills");

        assertEquals(400, answer.getStatusCode().value());
        assertEquals("name", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
    }

    @Test
    void aLinkInThePluginIsRefusedAndNothingIsCopied() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        Path secret = write(tmp, "secret.txt", "secret\n");
        Files.createSymbolicLink(source.resolve("skills/alpha/linked.md"), secret);
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importFixture("skills");

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("link", json(answer).path("reason").asText());
        assertEquals(before, snapshot());

        Files.delete(source.resolve("skills/alpha/linked.md"));
        Files.delete(source.resolve("agents/scout.md"));
        Files.createSymbolicLink(source.resolve("agents/scout.md"), secret);
        ResponseEntity<?> agent = importFixture("agents");
        assertEquals(400, agent.getStatusCode().value(), String.valueOf(agent.getBody()));
        assertEquals("link", json(agent).path("reason").asText());

        Files.delete(source.resolve("agents/scout.md"));
        Files.delete(source.resolve("hooks/guard.sh"));
        Files.createSymbolicLink(source.resolve("hooks/guard.sh"), secret);
        ResponseEntity<?> hook = importFixture("hooks");
        assertEquals(400, hook.getStatusCode().value(), String.valueOf(hook.getBody()));
        assertEquals("link", json(hook).path("reason").asText());
        assertEquals(before, snapshot());
    }

    @Test
    void aLinkOnTheWayToTheTargetIsRefused() throws IOException {
        seedCache("test", "fixture", "1.0.0");
        Path elsewhere = Files.createDirectories(tmp.resolve("elsewhere"));
        Files.createSymbolicLink(dir.resolve("agents"), elsewhere);
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importFixture("agents");

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("link", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
        assertEquals(Map.of(), snapshot(elsewhere).entrySet().stream().filter(e -> !e.getKey().equals("/"))
                .collect(java.util.stream.Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue)));
    }

    /** Replaces the plugin's hooks.json with one PostToolUse command hook per command, matcher Edit. */
    private void postHooks(Path plugin, String... commands) throws IOException {
        ObjectNode root = mapper.createObjectNode();
        ArrayNode handlers = root.putObject("hooks").putArray("PostToolUse").addObject().put("matcher", "Edit")
                .putArray("hooks");
        for (String command : commands) {
            handlers.addObject().put("type", "command").put("command", command);
        }
        Files.writeString(plugin.resolve("hooks/hooks.json"), mapper.writeValueAsString(root));
    }

    /** No file below the playbook folder carries an MCP server of the fixture, by field or by name. */
    private void assertNoMcpServer() throws IOException {
        for (Map.Entry<String, String> file : texts().entrySet()) {
            for (String mark : List.of("mcpServers", "fixture-plugin-json-server", "fixture-dot-mcp-server",
                    "fixture-skill-mcp")) {
                assertFalse(file.getValue().contains(mark), file.getKey() + " carries " + mark);
            }
        }
    }

    /** The commands of the playbook's hooks/hooks.json, in order. */
    private List<String> hookCommands() throws IOException {
        List<String> out = new ArrayList<>();
        mapper.readTree(Files.readString(dir.resolve("hooks/hooks.json"))).forEach(e -> out.add(e.path("command").asText()));
        return out;
    }

    @Test
    void aHookThatRunsAFileOfThePluginManifestFolderIsLeftOutAndNoMcpServerLands() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        postHooks(source, "jq . ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json", "echo kept");

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("PostToolUse Edit plugin-root"), droppedHooks(json(answer)));
        assertEquals(List.of("echo kept"), hookCommands());
        assertFalse(Files.exists(dir.resolve("hooks/plugin.json")), "the manifest is not copied as a hook script");
        assertEquals(List.of(), texts(json(answer).path("imported").path("scripts")));
        assertTrue(texts(json(answer).path("notCopied")).contains(".claude-plugin/plugin.json#mcpServers"));
        assertNoMcpServer();
    }

    @Test
    void aHookThatRunsAnMcpFileOfThePluginIsLeftOutAndNoMcpServerLands() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        write(source, "skills/beta/.mcp.json", "{\"mcpServers\": {\"fixture-skill-mcp\": {\"command\": \"node\"}}}\n");
        write(source, "scripts/servers.mcp.json", "{\"mcpServers\": {\"fixture-skill-mcp\": {\"command\": \"node\"}}}\n");
        postHooks(source, "cat ${CLAUDE_PLUGIN_ROOT}/.mcp.json", "cat ${CLAUDE_PLUGIN_ROOT}/skills/beta/.mcp.json",
                "cat $CLAUDE_PLUGIN_ROOT/scripts/servers.mcp.json", "echo kept");

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("PostToolUse Edit plugin-root", "PostToolUse Edit plugin-root",
                "PostToolUse Edit plugin-root"), droppedHooks(json(answer)));
        assertEquals(List.of("echo kept"), hookCommands());
        assertEquals(List.of(), texts(json(answer).path("imported").path("scripts")));
        assertNoMcpServer();
    }

    @Test
    void aHookThatRunsAFileNamedHooksJsonIsLeftOutAndThePlaybookListStays() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        write(source, "scripts/hooks.json", "{\"note\": \"a script file of the same name\"}\n");
        postHooks(source, "cat ${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json", "cat ${CLAUDE_PLUGIN_ROOT}/scripts/hooks.json",
                "echo kept");

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("PostToolUse Edit plugin-root", "PostToolUse Edit plugin-root"),
                droppedHooks(json(answer)));
        assertTrue(mapper.readTree(Files.readString(dir.resolve("hooks/hooks.json"))).isArray());
        assertEquals(List.of("echo kept"), hookCommands());
        assertEquals(List.of("hooks/hooks.json"), playbook().contents().hooks());
    }

    /**
     * The file at {@code spelled} below the plugin: on a case-insensitive disk it is the file at
     * {@code real}, elsewhere it is made as a copy of it, so the spelling reaches the same text on
     * every disk.
     */
    private static void spelled(Path plugin, String real, String spelled) throws IOException {
        Path at = plugin.resolve(spelled);
        if (!Files.exists(at)) {
            Files.createDirectories(at.getParent());
            Files.copy(plugin.resolve(real), at);
        }
    }

    @Test
    void aHookThatRunsAnUpperCaseSpellingOfTheManifestOrAnMcpFileIsLeftOut() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        spelled(source, ".claude-plugin/plugin.json", ".CLAUDE-PLUGIN/plugin.json");
        spelled(source, ".mcp.json", ".MCP.JSON");
        write(source, "scripts/Servers.MCP.JSON", "{\"note\": \"a server file by its name\"}\n");
        write(source, "sub/.Claude-Plugin/notes.sh", "echo notes\n");
        postHooks(source, "jq . ${CLAUDE_PLUGIN_ROOT}/.CLAUDE-PLUGIN/plugin.json", "cat ${CLAUDE_PLUGIN_ROOT}/.MCP.JSON",
                "cat ${CLAUDE_PLUGIN_ROOT}/scripts/Servers.MCP.JSON", "sh ${CLAUDE_PLUGIN_ROOT}/sub/.Claude-Plugin/notes.sh",
                "echo kept");

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("PostToolUse Edit plugin-root", "PostToolUse Edit plugin-root",
                "PostToolUse Edit plugin-root", "PostToolUse Edit plugin-root"), droppedHooks(json(answer)));
        assertEquals(List.of("echo kept"), hookCommands());
        assertEquals(List.of(), texts(json(answer).path("imported").path("scripts")));
        assertEquals(Set.of("hooks/hooks.json"), Set.copyOf(texts().keySet().stream()
                .filter(k -> k.startsWith("hooks/")).toList()));
        assertNoMcpServer();
    }

    @Test
    void aHookThatRunsAnUpperCaseHooksJsonIsLeftOutAndThePlaybookListStays() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        write(source, "scripts/Hooks.Json", "{\"note\": \"a script file of the same name\"}\n");
        postHooks(source, "cat ${CLAUDE_PLUGIN_ROOT}/hooks/HOOKS.JSON", "cat ${CLAUDE_PLUGIN_ROOT}/scripts/Hooks.Json",
                "echo kept");
        spelled(source, "hooks/hooks.json", "hooks/HOOKS.JSON");

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("PostToolUse Edit plugin-root", "PostToolUse Edit plugin-root"),
                droppedHooks(json(answer)));
        assertEquals(List.of("echo kept"), hookCommands());
        assertEquals(List.of("hooks/hooks.json"), playbook().contents().hooks());
    }

    @Test
    void aHookThatRunsThePluginsOwnHooksFileUnderAnotherNameIsLeftOut() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        postHooks(source, "sh ${CLAUDE_PLUGIN_ROOT}/scripts/run.sh", "echo kept");
        Files.createDirectories(source.resolve("scripts"));
        Files.createLink(source.resolve("scripts/run.sh"), source.resolve("hooks/hooks.json"));

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("PostToolUse Edit plugin-root"), droppedHooks(json(answer)));
        assertEquals(List.of("echo kept"), hookCommands());
        assertFalse(Files.exists(dir.resolve("hooks/run.sh")), "the plugin's hook list is not copied as a script");
    }

    @Test
    void aHookScriptThatHoldsMcpServersUnderAnyNameIsLeftOutAndAPlainOneIsCopied() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        write(source, "scripts/servers.json", "{\"mcpServers\": {\"fixture-skill-mcp\": {\"command\": \"node\"}}}\n");
        write(source, "scripts/mixed.sh", "#!/bin/sh\n# MCPSERVERS fixture-skill-mcp\necho hi\n");
        write(source, "scripts/plain.sh", "#!/bin/sh\necho plain\n");
        postHooks(source, "cat ${CLAUDE_PLUGIN_ROOT}/scripts/servers.json", "sh $CLAUDE_PLUGIN_ROOT/scripts/mixed.sh",
                "sh ${CLAUDE_PLUGIN_ROOT}/scripts/plain.sh");

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("PostToolUse Edit plugin-root", "PostToolUse Edit plugin-root"),
                droppedHooks(json(answer)));
        assertEquals(List.of("sh {hooks}/plain.sh"), hookCommands());
        assertEquals(List.of("hooks/plain.sh"), texts(json(answer).path("imported").path("scripts")));
        assertEquals("#!/bin/sh\necho plain\n", Files.readString(dir.resolve("hooks/plain.sh")));
        assertFalse(Files.exists(dir.resolve("hooks/servers.json")));
        assertFalse(Files.exists(dir.resolve("hooks/mixed.sh")));
        assertNoMcpServer();
        for (String text : texts().values()) {
            assertFalse(text.toLowerCase(java.util.Locale.ROOT).contains("mcpservers"), text);
        }
    }

    @Test
    void aSkillFileNamedAsAnMcpFileOrHoldingMcpServersIsNotCopiedAndTheAnswerNamesIt() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        write(source, "skills/alpha/Extra.MCP.JSON", "{\"note\": \"a server file by its name\"}\n");
        write(source, "skills/alpha/servers.json", "{\"McpServers\": {\"fixture-skill-mcp\": {\"command\": \"node\"}}}\n");
        write(source, "skills/alpha/plain.json", "{\"note\": \"kept\"}\n");
        Files.write(source.resolve("skills/alpha/wide.json"),
                "{\"mcpServers\": {}}".getBytes(StandardCharsets.UTF_16LE));

        ResponseEntity<?> answer = importFixture("skills");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of(".claude-plugin/plugin.json#mcpServers", ".mcp.json", "skills/alpha/Extra.MCP.JSON",
                "skills/alpha/servers.json", "skills/alpha/wide.json", "skills/beta/.mcp.json"),
                texts(json(answer).path("notCopied")));
        assertFalse(Files.exists(dir.resolve("skills/fixture/alpha/wide.json")));
        assertEquals("{\"note\": \"kept\"}\n", Files.readString(dir.resolve("skills/fixture/alpha/plain.json")));
        assertTrue(Files.exists(dir.resolve("skills/fixture/alpha/SKILL.md")));
        for (Map.Entry<String, String> file : texts().entrySet()) {
            assertFalse(file.getKey().toLowerCase(java.util.Locale.ROOT).endsWith(".mcp.json"), file.getKey());
            assertFalse(file.getValue().toLowerCase(java.util.Locale.ROOT).contains("mcpservers"), file.getKey());
        }
    }

    // ---- MCP files the manifest names, escapes, hard links, links that lead nowhere -------------

    /** A server file in the flat form: no mcpServers key, so only its identity gives it away. */
    private static final String FLAT = "{\"fixture-skill-mcp\": {\"command\": \"node\"}}\n";

    /** Sets the manifest's mcpServers to a JSON value: a path, a list of paths or an object. */
    private void manifestMcp(Path plugin, String value) throws IOException {
        Path manifest = plugin.resolve(".claude-plugin/plugin.json");
        ObjectNode root = (ObjectNode) mapper.readTree(Files.readString(manifest));
        root.set("mcpServers", mapper.readTree(value));
        Files.writeString(manifest, mapper.writeValueAsString(root));
    }

    @Test
    void aHookThatRunsAnMcpFileTheManifestNamesIsLeftOutUnderAnyName() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        manifestMcp(source, "\"./config/tools.json\"");
        write(source, "config/tools.json", FLAT);
        Files.createDirectories(source.resolve("scripts"));
        Files.createLink(source.resolve("scripts/tools.sh"), source.resolve("config/tools.json"));
        write(source, "scripts/plain.sh", "echo plain\n");
        postHooks(source, "cat ${CLAUDE_PLUGIN_ROOT}/config/tools.json", "sh ${CLAUDE_PLUGIN_ROOT}/scripts/tools.sh",
                "sh ${CLAUDE_PLUGIN_ROOT}/scripts/plain.sh");

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("PostToolUse Edit plugin-root", "PostToolUse Edit plugin-root"),
                droppedHooks(json(answer)));
        assertEquals(List.of("sh {hooks}/plain.sh"), hookCommands());
        assertEquals(List.of("hooks/plain.sh"), texts(json(answer).path("imported").path("scripts")));
        assertTrue(texts(json(answer).path("notCopied")).contains("config/tools.json"), String.valueOf(answer.getBody()));
        assertNoMcpServer();
    }

    @Test
    void aSkillFileTheManifestNamesAsAnMcpFileIsNotCopiedAndTheAnswerNamesItOnce() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        manifestMcp(source, "[\"./skills/alpha/tools.json\", \"config/more.json\"]");
        write(source, "skills/alpha/tools.json", FLAT);
        write(source, "config/more.json", FLAT);
        Files.createLink(source.resolve("skills/alpha/data.json"), source.resolve("config/more.json"));
        write(source, "skills/alpha/plain.json", "{\"note\": \"kept\"}\n");

        ResponseEntity<?> answer = importFixture("skills");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of(".claude-plugin/plugin.json#mcpServers", ".mcp.json", "config/more.json",
                "skills/alpha/data.json", "skills/alpha/tools.json", "skills/beta/.mcp.json"),
                texts(json(answer).path("notCopied")));
        assertFalse(Files.exists(dir.resolve("skills/fixture/alpha/tools.json")));
        assertFalse(Files.exists(dir.resolve("skills/fixture/alpha/data.json")));
        assertEquals("{\"note\": \"kept\"}\n", Files.readString(dir.resolve("skills/fixture/alpha/plain.json")));
        assertTrue(Files.exists(dir.resolve("skills/fixture/alpha/SKILL.md")));
        assertNoMcpServer();
    }

    @Test
    void aCommandOrAnAgentTheManifestNamesAsAnMcpFileIsNotCopiedAndTheAnswerNamesIt() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        manifestMcp(source, "[\"${CLAUDE_PLUGIN_ROOT}/commands/servers.md\", \"./agents/servers.md\"]");
        write(source, "commands/servers.md", FLAT);
        write(source, "agents/servers.md", FLAT);

        ResponseEntity<?> answer = importFixture("agents", "commands");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        List<String> notCopied = texts(json(answer).path("notCopied"));
        assertTrue(notCopied.containsAll(List.of("agents/servers.md", "commands/servers.md")), notCopied.toString());
        assertFalse(Files.exists(dir.resolve("commands/servers.md")));
        assertFalse(Files.exists(dir.resolve("agents/servers.md")));
        assertTrue(Files.isRegularFile(dir.resolve("commands/ship.md")));
        assertTrue(Files.isRegularFile(dir.resolve("agents/critic.md")));
        assertEquals(2, playbook().contents().agents().size());
        assertNoMcpServer();
    }

    @Test
    void aJsonEscapeDoesNotHideMcpServersFromTheHookRuleOrTheSkillRule() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        write(source, "scripts/servers.json", "{\"mcp\\u0053ervers\": {\"fixture-skill-mcp\": {\"command\": \"node\"}}}\n");
        write(source, "skills/alpha/esc.json", "{\"\\u006D\\u0063p\\u0053ervers\": {\"fixture-skill-mcp\": {}}}\n");
        postHooks(source, "cat ${CLAUDE_PLUGIN_ROOT}/scripts/servers.json", "echo kept");

        ResponseEntity<?> answer = importFixture("hooks", "skills");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("PostToolUse Edit plugin-root"), droppedHooks(json(answer)));
        assertEquals(List.of("echo kept"), hookCommands());
        assertTrue(texts(json(answer).path("notCopied")).contains("skills/alpha/esc.json"), String.valueOf(answer.getBody()));
        assertFalse(Files.exists(dir.resolve("hooks/servers.json")));
        assertFalse(Files.exists(dir.resolve("skills/fixture/alpha/esc.json")));
        assertNoMcpServer();
    }

    @Test
    void aHardLinkToAnyMcpFileOfThePluginIsNoHookScriptAndNoSkillFile() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        write(source, "skills/beta/.mcp.json", FLAT);
        write(source, "deep/Nested/Extra.MCP.JSON", FLAT);
        Files.createDirectories(source.resolve("scripts"));
        Files.createLink(source.resolve("scripts/run.sh"), source.resolve("skills/beta/.mcp.json"));
        Files.createLink(source.resolve("scripts/deep.sh"), source.resolve("deep/Nested/Extra.MCP.JSON"));
        Files.createLink(source.resolve("skills/alpha/data.json"), source.resolve("skills/beta/.mcp.json"));
        write(source, "scripts/plain.sh", "echo plain\n");
        postHooks(source, "sh ${CLAUDE_PLUGIN_ROOT}/scripts/run.sh", "sh ${CLAUDE_PLUGIN_ROOT}/scripts/deep.sh",
                "sh ${CLAUDE_PLUGIN_ROOT}/scripts/plain.sh");

        ResponseEntity<?> answer = importFixture("hooks", "skills");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("PostToolUse Edit plugin-root", "PostToolUse Edit plugin-root"),
                droppedHooks(json(answer)));
        assertEquals(List.of("sh {hooks}/plain.sh"), hookCommands());
        assertTrue(texts(json(answer).path("notCopied")).contains("skills/alpha/data.json"), String.valueOf(answer.getBody()));
        assertFalse(Files.exists(dir.resolve("hooks/run.sh")));
        assertFalse(Files.exists(dir.resolve("hooks/deep.sh")));
        assertFalse(Files.exists(dir.resolve("skills/fixture/alpha/data.json")));
        assertNoMcpServer();
    }

    @Test
    void aManifestPathWithDotDotThatStaysInThePluginStillNamesAnMcpFile() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        write(source, "reenter.json", FLAT);
        write(source, "inner.json", FLAT);
        Files.createDirectories(source.resolve("sub"));
        write(source.getParent(), "outside.json", FLAT);
        manifestMcp(source, "[\"../1.0.0/reenter.json\", \"./sub/../inner.json\", \"../outside.json\", \"/etc/hosts\"]");
        postHooks(source, "cat ${CLAUDE_PLUGIN_ROOT}/reenter.json", "cat ${CLAUDE_PLUGIN_ROOT}/inner.json", "echo kept");

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("PostToolUse Edit plugin-root", "PostToolUse Edit plugin-root"),
                droppedHooks(json(answer)));
        assertEquals(List.of("echo kept"), hookCommands());
        List<String> notCopied = texts(json(answer).path("notCopied"));
        assertTrue(notCopied.containsAll(List.of("inner.json", "reenter.json")), notCopied.toString());
        assertFalse(notCopied.stream().anyMatch(n -> n.contains("outside") || n.contains("hosts")),
                "a path outside the plugin is not read and not named: " + notCopied);
        assertFalse(Files.exists(dir.resolve("hooks/reenter.json")));
        assertFalse(Files.exists(dir.resolve("hooks/inner.json")));
        assertNoMcpServer();
    }

    @Test
    void aManifestPathWithABackslashOrADoubleSlashNamesTheFileEitherWay() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        write(source, "cfg/a.json", FLAT);
        write(source, "cfg/b.json", FLAT);
        manifestMcp(source, "[\"./cfg//a.json\", \"cfg\\\\b.json\"]");
        postHooks(source, "cat ${CLAUDE_PLUGIN_ROOT}/cfg/a.json", "cat ${CLAUDE_PLUGIN_ROOT}/cfg/b.json", "echo kept");

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("PostToolUse Edit plugin-root", "PostToolUse Edit plugin-root"),
                droppedHooks(json(answer)));
        assertEquals(List.of("echo kept"), hookCommands());
        assertTrue(texts(json(answer).path("notCopied")).containsAll(List.of("cfg/a.json", "cfg/b.json")),
                String.valueOf(answer.getBody()));
        assertFalse(Files.exists(dir.resolve("hooks/b.json")));
        assertNoMcpServer();
    }

    @Test
    void aManifestPathThroughALinkedFolderNamesTheFileTheLinkReaches() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        write(source, "cfg/a.json", FLAT);
        Files.createSymbolicLink(source.resolve("alias"), Path.of("cfg"));
        manifestMcp(source, "\"./alias/a.json\"");
        postHooks(source, "cat ${CLAUDE_PLUGIN_ROOT}/cfg/a.json", "echo kept");

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("PostToolUse Edit plugin-root"), droppedHooks(json(answer)));
        assertEquals(List.of("echo kept"), hookCommands());
        assertFalse(Files.exists(dir.resolve("hooks/a.json")));
        assertNoMcpServer();
    }

    @Test
    void aCommandThatIsAHardLinkOfTheManifestIsNotCopied() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        Files.createLink(source.resolve("commands/evil.md"), source.resolve(".claude-plugin/plugin.json"));

        ResponseEntity<?> answer = importFixture("commands");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertTrue(texts(json(answer).path("notCopied")).contains("commands/evil.md"), String.valueOf(answer.getBody()));
        assertFalse(Files.exists(dir.resolve("commands/evil.md")));
        assertTrue(Files.isRegularFile(dir.resolve("commands/ship.md")), "positive: the other commands are copied");
        assertNoMcpServer();
    }

    @Test
    void aDanglingMcpLinkAtThePluginRootLeavesTheImportDone() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        Files.delete(source.resolve(".mcp.json"));
        Files.createSymbolicLink(source.resolve(".mcp.json"), source.resolve("nowhere.json"));
        write(source, "scripts/plain.sh", "echo plain\n");
        postHooks(source, "sh ${CLAUDE_PLUGIN_ROOT}/scripts/plain.sh");

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("sh {hooks}/plain.sh"), hookCommands());
        assertEquals("echo plain\n", Files.readString(dir.resolve("hooks/plain.sh")));
        assertTrue(texts(json(answer).path("notCopied")).contains(".mcp.json"));
    }

    @Test
    void theFileAnMcpLinkOfThePluginPointsAtIsNoHookScript() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        Files.delete(source.resolve(".mcp.json"));
        write(source, "config/real.json", FLAT);
        Files.createSymbolicLink(source.resolve(".mcp.json"), Path.of("config/real.json"));
        postHooks(source, "cat ${CLAUDE_PLUGIN_ROOT}/config/real.json", "echo kept");

        ResponseEntity<?> answer = importFixture("hooks");

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("PostToolUse Edit plugin-root"), droppedHooks(json(answer)));
        assertEquals(List.of("echo kept"), hookCommands());
        assertFalse(Files.exists(dir.resolve("hooks/real.json")));
        assertNoMcpServer();
    }

    @Test
    void aMarketplacePluginWithoutAManifestFolderStillImportsItsHookScript() throws IOException {
        Path market = seedMarketplace("market");
        Path plugin = market.resolve("plugins/fixture");
        try (Stream<Path> walk = Files.walk(plugin.resolve(".claude-plugin"))) {
            for (Path p : walk.sorted(java.util.Comparator.reverseOrder()).toList()) {
                Files.delete(p);
            }
        }
        write(plugin, "scripts/plain.sh", "echo plain\n");
        postHooks(plugin, "sh ${CLAUDE_PLUGIN_ROOT}/scripts/plain.sh");

        ResponseEntity<?> answer = controller.importPlugin(
                request("marketplace", "market", "fixture", "0.9.0", "hooks"), local());

        assertEquals(200, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals(List.of("sh {hooks}/plain.sh"), hookCommands());
        assertEquals("echo plain\n", Files.readString(dir.resolve("hooks/plain.sh")));
    }

    @Test
    void aLicenceThatIsAnMcpFileOfThePluginCountsAsNoLicence() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        write(source, "skills/beta/.mcp.json", FLAT);
        Files.delete(source.resolve("LICENSE"));
        Files.createLink(source.resolve("LICENSE"), source.resolve("skills/beta/.mcp.json"));
        Map<String, String> before = snapshot();

        ResponseEntity<?> answer = importFixture("skills");

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("unlicensed", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
    }

    @Test
    void aFolderOfThePluginThatCannotBeReadRefusesTheImportBeforeAnyWrite() throws IOException {
        Path source = seedCache("test", "fixture", "1.0.0");
        Path locked = Files.createDirectories(source.resolve("vendor/locked"));
        write(locked, "servers.mcp.json", FLAT);
        Map<String, String> before = snapshot();
        Set<java.nio.file.attribute.PosixFilePermission> mode = Files.getPosixFilePermissions(locked);
        Files.setPosixFilePermissions(locked, java.nio.file.attribute.PosixFilePermissions.fromString("---------"));
        ResponseEntity<?> answer;
        try {
            org.junit.jupiter.api.Assumptions.assumeFalse(Files.isReadable(locked), "this user reads any folder");
            answer = importFixture("commands");
        } finally {
            Files.setPosixFilePermissions(locked, mode);
        }

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("plugin-unreadable", json(answer).path("reason").asText());
        assertEquals(before, snapshot());
    }

    @Test
    void aLinkOnTheWayToATextTargetIsRefusedBeforeTheImportWritesAnything() throws IOException {
        seedCache("test", "fixture", "1.0.0");
        Path elsewhere = Files.createDirectories(tmp.resolve("elsewhere"));
        Files.createSymbolicLink(dir.resolve("agents"), elsewhere);
        Map<String, String> before = snapshot();
        Set<java.nio.file.attribute.PosixFilePermission> mode = Files.getPosixFilePermissions(dir);
        Files.setPosixFilePermissions(dir, java.nio.file.attribute.PosixFilePermissions.fromString("r-xr-xr-x"));
        ResponseEntity<?> answer;
        try {
            answer = importFixture("skills", "agents");
        } finally {
            Files.setPosixFilePermissions(dir, mode);
        }

        assertEquals(400, answer.getStatusCode().value(), String.valueOf(answer.getBody()));
        assertEquals("link", json(answer).path("reason").asText());
        assertTrue(json(answer).path("message").asText().startsWith("agents/"), String.valueOf(answer.getBody()));
        assertEquals(before, snapshot());
    }

    @Test
    void anUnknownOrMissingKindIsABadRequest() throws IOException {
        seedCache("test", "fixture", "1.0.0");
        Map<String, String> before = snapshot();

        ResponseEntity<?> unknown = importFixture("skills", "mcpServers");
        assertEquals(400, unknown.getStatusCode().value());
        assertEquals("kind", json(unknown).path("reason").asText());
        ResponseEntity<?> none = importFixture();
        assertEquals(400, none.getStatusCode().value());
        assertEquals("bad-request", json(none).path("reason").asText());
        assertEquals(before, snapshot());
    }

    @Test
    void aFailureBeforeThePlaybookFileIsWrittenTakesEverythingBack() throws IOException {
        seedCache("test", "fixture", "1.0.0");
        Map<String, String> before = snapshot();
        PlaybookImports failing = new PlaybookImports(spectroHome, launch.resolve(".spectro/skills"), launch,
                userSettings).midway(() -> {
                    throw new IOException("injected");
                });

        ObjectNode body = request(null, "test", "fixture", "1.0.0", ALL);
        try {
            failing.importPlugin(dir.toRealPath(), body);
        } catch (IOException expected) {
            assertEquals("injected", expected.getMessage());
        }

        assertEquals(before, snapshot());
    }

    // ---- security: the install confirm stays the only way in ------------------------------------

    @Test
    void theImportInstallsNothingAndThePreviewShowsHooksAndAgentsAsNew() throws IOException {
        seedCache("test", "fixture", "1.0.0");
        Map<String, String> spectro = snapshot(spectroHome);

        assertEquals(200, importFixture(ALL).getStatusCode().value());

        assertEquals(spectro, snapshot(spectroHome), "nothing under ~/.spectro: no skill, no agent, no settings");
        assertFalse(Files.exists(userSettings));
        assertFalse(Files.exists(ledger));
        PlaybookContents.Preview shown = (PlaybookContents.Preview) controller.contents(dir.toString(), null, local())
                .getBody();
        List<String> states = shown.items().stream()
                .filter(i -> i.kind().equals("hook") || i.kind().equals("agent"))
                .map(i -> i.kind() + " " + i.state()).toList();
        assertEquals(List.of("hook new", "hook new", "agent new", "agent new"), states);
    }

    // ---- the scenario ----------------------------------------------------------------------------

    @Test
    void scenarioAPluginIntoAPlaybook() throws IOException {
        seedCache("test", "fixture", "1.0.0");

        ResponseEntity<?> first = importFixture("skills", "commands");
        assertEquals(200, first.getStatusCode().value(), String.valueOf(first.getBody()));
        assertTrue(Files.isRegularFile(dir.resolve("skills/fixture/alpha/SKILL.md")));
        assertTrue(playbook().contents().skills().contains("skills/fixture"));
        assertTrue(Files.isRegularFile(dir.resolve("commands/ship.md")));
        assertTrue(playbook().contents().commands().containsAll(List.of("commands/ship.md", "commands/quick.md")));
        String provenance = Files.readString(dir.resolve("PROVENANCE.md"));
        assertTrue(provenance.contains("plugin fixture 1.0.0"), provenance);

        ResponseEntity<?> second = importFixture("hooks");
        assertEquals(200, second.getStatusCode().value(), String.valueOf(second.getBody()));
        JsonNode hooks = mapper.readTree(Files.readString(dir.resolve("hooks/hooks.json")));
        hooks.forEach(h -> assertTrue(Set.of("pre_tool_use", "post_tool_use").contains(h.path("event").asText()), h.toString()));
        assertEquals(3, json(second).path("droppedHooks").size());
    }
}
