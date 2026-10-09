package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.ToolGroup;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 466 at the door a browser session really goes through: the composer
 * gear's socket frame reaches the next run of an agent that is already built
 * and every child it spawns, the session moment seeds the switch from the
 * workspace's local scope, the frame that tells the gear what each group holds
 * is read off the belt the session built, and the drift guard of criterion 6
 * walks that same belt.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionToolGroupsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private String previousUserSettings;

    @BeforeEach
    void pinTheBackend() throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        previousUserSettings = Files.exists(file) ? Files.readString(file) : null;
        Files.createDirectories(file.getParent());
        Files.writeString(file, "{ \"provider\": \"ollama\", \"model\": \"qwen3:latest\" }");
    }

    @AfterEach
    void restoreTheBackend() throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        if (previousUserSettings == null) {
            Files.deleteIfExists(file);
        } else {
            Files.writeString(file, previousUserSettings);
        }
    }

    private static SessionConnection sessionIn(FakeSocket socket, Path workspace) {
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides(
                        null, null, null, null, null, workspace.toString())), null);
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        return connection;
    }

    /** A session whose folder is configured, connected and not yet prompted:
     *  only the connect-time workspace frame has gone out. */
    private static SessionConnection configuredAtConnect(FakeSocket socket, Path workspace) {
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides(
                        null, null, null, null, null, workspace.toString())), null);
        connection.start();
        return connection;
    }

    /** A session with no folder at all, connected and not yet prompted. */
    private static SessionConnection unpinnedAtConnect(FakeSocket socket) {
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(SpectroConfig.Overrides.none()), null);
        connection.start();
        return connection;
    }

    private static void writeLocal(Path workspace, String json) throws IOException {
        Path local = workspace.resolve(SpectroConfig.WS_LOCAL_SETTINGS);
        Files.createDirectories(local.getParent());
        Files.writeString(local, json);
    }

    private static List<String> names(List<ToolSpec> specs) {
        return specs.stream().map(ToolSpec::name).toList();
    }

    private static JsonNode lastFrame(FakeSocket socket, String type) throws IOException {
        JsonNode last = null;
        for (FakeSocket.Frame frame : socket.frames()) {
            JsonNode node = JSON.readTree(frame.payload());
            if (type.equals(node.path("type").asText())) {
                last = node;
            }
        }
        return last;
    }

    /**
     * The child half here reads the reader a child spawned in the next run
     * starts from. The child's real provider request is pinned in core, in
     * SubagentToolGroupsTest.
     */
    @Test
    void theGearFrameReachesTheNextRunAndTheReaderChildrenStartFrom(@TempDir Path workspace) {
        SessionConnection connection = sessionIn(new FakeSocket("ws-466-a", "ws://localhost/ws"), workspace);
        connection.adoptSessionConfig();
        connection.buildAgentOnce();

        List<String> before = names(connection.agent().toolSpecsForNextRun());
        assertThat(before).as("test premise: the session's belt carries both families")
                .anyMatch(name -> name.startsWith("browser_"))
                .anyMatch(name -> name.startsWith("launch_"));

        connection.onSetToolGroupsOff(JSON.valueToTree(List.of("browser", "launch")));

        List<String> after = names(connection.agent().toolSpecsForNextRun());
        assertThat(after).noneMatch(name -> name.startsWith("browser_"))
                .noneMatch(name -> name.startsWith("launch_"))
                .contains("read_file", "run_command", "web_fetch");
        assertThat(connection.subagents().childToolGroupsOff())
                .as("the reader a child of the next run starts from has them off as well")
                .isEqualTo(EnumSet.of(ToolGroup.BROWSER, ToolGroup.LAUNCH));
    }

    @Test
    void anUnknownGroupFromTheSocketIsRefusedAndChangesNothing(@TempDir Path workspace)
            throws IOException {
        FakeSocket socket = new FakeSocket("ws-466-b", "ws://localhost/ws");
        SessionConnection connection = sessionIn(socket, workspace);
        connection.onSetToolGroupsOff(JSON.valueToTree(List.of("browser")));

        connection.onSetToolGroupsOff(JSON.valueToTree(List.of("printer")));
        connection.onSetToolGroupsOff(JSON.readTree("\"browser\""));

        assertThat(lastFrame(socket, "tool_groups_info").path("off").toString())
                .isEqualTo("[\"browser\"]");
        assertThat(socket.frames()).anyMatch(frame -> frame.payload().contains("printer")
                && frame.payload().contains("\"error\""));
        connection.adoptSessionConfig();
        connection.buildAgentOnce();
        assertThat(connection.agent().toolGroupsOffNow()).isEqualTo(Set.of(ToolGroup.BROWSER));
    }

    @Test
    void theSessionMomentSeedsTheSwitchFromTheWorkspaceLocalScope(@TempDir Path workspace)
            throws IOException {
        Path local = workspace.resolve(SpectroConfig.WS_LOCAL_SETTINGS);
        Files.createDirectories(local.getParent());
        Files.writeString(local, "{ \"toolGroupsOff\": [\"mcp\", \"images\"] }");
        FakeSocket socket = new FakeSocket("ws-466-c", "ws://localhost/ws");
        SessionConnection connection = sessionIn(socket, workspace);

        connection.adoptSessionConfig();
        connection.buildAgentOnce();

        assertThat(connection.agent().toolGroupsOffNow())
                .isEqualTo(EnumSet.of(ToolGroup.MCP, ToolGroup.IMAGES));
        assertThat(names(connection.agent().toolSpecsForNextRun()))
                .doesNotContain("generate_image", "view_image")
                .contains("read_file");
        assertThat(lastFrame(socket, "tool_groups_info").path("off").toString())
                .as("the gear is told what the session moment decided")
                .isEqualTo("[\"images\",\"mcp\"]");
    }

    @Test
    void aLiveSwitchSurvivesTheSessionMoment(@TempDir Path workspace) throws IOException {
        Path local = workspace.resolve(SpectroConfig.WS_LOCAL_SETTINGS);
        Files.createDirectories(local.getParent());
        Files.writeString(local, "{ \"toolGroupsOff\": [\"mcp\"] }");
        SessionConnection connection = sessionIn(new FakeSocket("ws-466-d", "ws://localhost/ws"), workspace);

        connection.onSetToolGroupsOff(JSON.valueToTree(List.of("web")));
        connection.adoptSessionConfig();
        connection.buildAgentOnce();

        assertThat(connection.agent().toolGroupsOffNow()).isEqualTo(Set.of(ToolGroup.WEB));
    }

    @Test
    void theInfoFrameListsEveryGroupWithTheToolsTheSessionCarries(@TempDir Path workspace)
            throws IOException {
        FakeSocket socket = new FakeSocket("ws-466-e", "ws://localhost/ws");
        SessionConnection connection = sessionIn(socket, workspace);
        connection.adoptSessionConfig();
        connection.buildAgentOnce();
        connection.onSetToolGroupsOff(JSON.valueToTree(List.of()));

        JsonNode info = lastFrame(socket, "tool_groups_info");
        assertThat(info).as("a tool_groups_info frame was sent").isNotNull();
        List<String> groupNames = new ArrayList<>();
        Map<String, List<String>> tools = new LinkedHashMap<>();
        for (JsonNode group : info.path("groups")) {
            groupNames.add(group.path("name").asText());
            List<String> members = new ArrayList<>();
            group.path("tools").forEach(tool -> members.add(tool.asText()));
            tools.put(group.path("name").asText(), members);
        }
        assertThat(groupNames).isEqualTo(ToolGroup.wireNames());
        List<String> beltNames = connection.belt().specs().stream().map(ToolSpec::name).toList();
        for (ToolGroup group : ToolGroup.values()) {
            assertThat(tools.get(group.wireName()))
                    .as(group.wireName() + " lists exactly the belt's members, in belt order")
                    .isEqualTo(beltNames.stream().filter(group::holds).toList());
        }
    }

    /**
     * Before the first prompt the gear can only be told what the session WILL
     * carry; once the belt exists it is told what the belt holds. An MCP
     * server that never starts is where the two differ: it stands in as
     * {@code mcp__ghost__*} until the build, and holds no tool after it.
     */
    @Test
    void theHintFollowsTheBeltOnceTheSessionHasBuiltIt(@TempDir Path workspace) throws IOException {
        Path project = workspace.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(project.getParent());
        Files.writeString(project, """
                { "mcpServers": { "ghost": { "command": "/nonexistent/spectro-466-ghost" } } }""");
        FakeSocket socket = new FakeSocket("ws-466-h", "ws://localhost/ws");
        SessionConnection connection = sessionIn(socket, workspace);

        connection.adoptSessionConfig();
        assertThat(mcpHint(lastFrame(socket, "tool_groups_info")))
                .as("before the build: the configured server stands in")
                .isEqualTo("[\"mcp__ghost__*\"]");

        connection.buildAgentOnce();
        assertThat(mcpHint(lastFrame(socket, "tool_groups_info")))
                .as("after the build: what the belt really holds, and a server that never started holds nothing")
                .isEqualTo("[]");
    }

    private static String mcpHint(JsonNode info) {
        for (JsonNode group : info.path("groups")) {
            if ("mcp".equals(group.path("name").asText())) {
                return group.path("tools").toString();
            }
        }
        throw new AssertionError("no mcp group in " + info);
    }

    @Test
    void theSocketHandlerRoutesTheGearFrame() throws IOException {
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket socket = new FakeSocket("ws-466-route", "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);

        handler.handleTextMessage(socket, new org.springframework.web.socket.TextMessage(
                "{\"type\":\"set_tool_groups_off\",\"groups\":[\"launch\",\"browser\"]}"));

        assertThat(socket.textJoined()).doesNotContain("Unknown message type");
        assertThat(lastFrame(socket, "tool_groups_info").path("off").toString())
                .isEqualTo("[\"browser\",\"launch\"]");
    }

    /**
     * Criterion 6 over the belt the session REALLY built: the family sizes are
     * the card's, the total without MCP and skills is 34, and the ten tools
     * without a group are the card's. Group membership is read from the belt,
     * so a new browser_* tool joins its group without an edit; this test then
     * goes red on the browser count, because the sizes and the ten names are
     * the card's numbers, written out here on purpose.
     */
    @Test
    void theRealBeltSplitsIntoTheCardsGroups(@TempDir Path workspace) {
        SessionConnection connection = sessionIn(new FakeSocket("ws-466-f", "ws://localhost/ws"), workspace);
        connection.adoptSessionConfig();
        connection.buildAgentOnce();
        List<String> belt = connection.belt().specs().stream().map(ToolSpec::name)
                .filter(name -> !name.equals("use_skill") && !name.equals("read_skill_file"))
                .filter(name -> !name.startsWith("mcp__"))
                .toList();

        Map<String, Long> sizes = new LinkedHashMap<>();
        for (ToolGroup group : ToolGroup.values()) {
            sizes.put(group.wireName(), belt.stream().filter(group::holds).count());
        }
        Map<String, Long> expected = new LinkedHashMap<>();
        expected.put("browser", 7L);
        expected.put("launch", 5L);
        expected.put("images", 2L);
        expected.put("web", 3L);
        expected.put("agents", 2L);
        expected.put("roles", 5L);
        expected.put("mcp", 0L);
        assertThat(sizes).containsExactlyEntriesOf(expected);
        assertThat(belt).as("34 tools without MCP and skills").hasSize(34);
        assertThat(belt.stream().filter(name -> ToolGroup.of(name).isEmpty()).toList())
                .as("the tools that can never be switched off")
                .containsExactlyInAnyOrder("list_dir", "read_file", "write_file", "run_command",
                        "edit_file", "glob", "grep", "view_file", "update_plan", "ask_user_question");
    }

    /** Plays one empty turn and keeps the context_info it saw. */
    private static final class OneTurn implements LlmProvider {
        public String modelName() {
            return "fake-model-1";
        }

        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            return List.of(new PTextDelta("ok"), new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static int schemaPartChars(ToolRegistry registry, Set<ToolGroup> off) {
        Agent agent = new Agent(AgentOptions.builder()
                .provider(new OneTurn())
                .systemPrompt("measure")
                .registry(registry)
                .onPermission(request -> true)
                .introspection(true)
                .toolGroupsOff(() -> off)
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(events::add);
        }
        return events.stream().filter(RunEvent.ContextInfo.class::isInstance)
                .map(RunEvent.ContextInfo.class::cast).findFirst().orElseThrow()
                .parts().stream().filter(part -> "tool schemas".equals(part.label()))
                .findFirst().orElseThrow().chars();
    }

    /**
     * The non-functional criterion: a small local model can be handed the
     * standard file tools only, and the schema block then stays under 6,000
     * chars, read with the ring's own part reader over the session's real belt.
     */
    @Test
    void allSevenGroupsOffKeepsTheSchemaBlockUnderSixThousandChars(@TempDir Path workspace) {
        SessionConnection connection = sessionIn(new FakeSocket("ws-466-g", "ws://localhost/ws"), workspace);
        connection.adoptSessionConfig();
        connection.buildAgentOnce();
        ToolRegistry belt = connection.belt();

        int all = schemaPartChars(belt, Set.of());
        int browserAndLaunchOff = schemaPartChars(belt, EnumSet.of(ToolGroup.BROWSER, ToolGroup.LAUNCH));
        int allOff = schemaPartChars(belt, EnumSet.allOf(ToolGroup.class));
        System.out.println("card-466 tool schemas part chars: all=" + all
                + " browserAndLaunchOff=" + browserAndLaunchOff + " allOff=" + allOff
                + " tools=" + belt.specs().size()
                + " toolsAllOff=" + ToolGroup.visible(belt.specs(), EnumSet.allOf(ToolGroup.class)).size());

        assertThat(browserAndLaunchOff).isLessThan(all);
        assertThat(allOff).isLessThan(browserAndLaunchOff).isLessThan(6_000);
    }

    /**
     * Round three, AC3: a folder is pinned the moment the connection's
     * workspace frame names it, before any prompt. The gear must show that
     * folder's saved list from then on, not the list of the process config.
     */
    @Test
    void aConfiguredFolderSeedsTheSwitchAtConnectBeforeTheFirstPrompt(@TempDir Path workspace)
            throws IOException {
        writeLocal(workspace, "{ \"toolGroupsOff\": [\"browser\"] }");
        FakeSocket socket = new FakeSocket("ws-466-i", "ws://localhost/ws");
        configuredAtConnect(socket, workspace);

        JsonNode workspaceFrame = lastFrame(socket, "workspace_info");
        assertThat(workspaceFrame.path("configured").asBoolean())
                .as("test premise: the connect frame says the folder is pinned").isTrue();
        assertThat(workspaceFrame.path("resolved").asBoolean())
                .as("test premise: no run has resolved it yet").isFalse();
        assertThat(lastFrame(socket, "tool_groups_info").path("off").toString())
                .as("the folder's saved list, before the first prompt")
                .isEqualTo("[\"browser\"]");
    }

    @Test
    void pickingAFolderBeforeTheFirstPromptSeedsTheSwitchFromIt(@TempDir Path workspace)
            throws IOException {
        writeLocal(workspace, "{ \"toolGroupsOff\": [\"launch\"] }");
        FakeSocket socket = new FakeSocket("ws-466-j", "ws://localhost/ws");
        SessionConnection connection = unpinnedAtConnect(socket);
        assertThat(lastFrame(socket, "tool_groups_info").path("off").toString())
                .as("test premise: no folder, nothing off").isEqualTo("[]");

        connection.onSetWorkspace("set", workspace.toString());

        assertThat(lastFrame(socket, "tool_groups_info").path("off").toString())
                .isEqualTo("[\"launch\"]");
    }

    @Test
    void theGearSavesToTheLocalScopeOfAConfiguredFolderBeforeTheFirstPrompt(@TempDir Path workspace)
            throws IOException {
        FakeSocket socket = new FakeSocket("ws-466-k", "ws://localhost/ws");
        SessionConnection connection = configuredAtConnect(socket, workspace);

        connection.onSetToolGroupsOff(JSON.valueToTree(List.of("browser", "launch")), true);

        JsonNode saved = JSON.readTree(workspace.resolve(SpectroConfig.WS_LOCAL_SETTINGS).toFile());
        assertThat(saved.path("toolGroupsOff").toString()).isEqualTo("[\"browser\",\"launch\"]");
        JsonNode info = lastFrame(socket, "tool_groups_info");
        assertThat(info.path("off").toString()).isEqualTo("[\"browser\",\"launch\"]");
        assertThat(info.has("saveError")).as("a save that worked reports no error").isFalse();
        assertThat(lastFrame(socket, "workspace_info").path("resolved").asBoolean())
                .as("saving mints no session and resolves no folder").isFalse();
    }

    @Test
    void theGearSavesToTheFolderTheRunResolvedAfterTheFirstPrompt(@TempDir Path workspace)
            throws IOException {
        SessionConnection connection = sessionIn(new FakeSocket("ws-466-l", "ws://localhost/ws"), workspace);
        connection.adoptSessionConfig();
        connection.buildAgentOnce();

        connection.onSetToolGroupsOff(JSON.valueToTree(List.of("web")), true);

        JsonNode saved = JSON.readTree(workspace.resolve(SpectroConfig.WS_LOCAL_SETTINGS).toFile());
        assertThat(saved.path("toolGroupsOff").toString()).isEqualTo("[\"web\"]");
        assertThat(connection.agent().toolGroupsOffNow()).isEqualTo(Set.of(ToolGroup.WEB));
    }

    @Test
    void aSaveWithoutAPinnedFolderWritesNothingAndSaysSo() throws IOException {
        FakeSocket socket = new FakeSocket("ws-466-m", "ws://localhost/ws");
        SessionConnection connection = unpinnedAtConnect(socket);

        connection.onSetToolGroupsOff(JSON.valueToTree(List.of("browser")), true);

        JsonNode info = lastFrame(socket, "tool_groups_info");
        assertThat(info.path("off").toString())
                .as("the open session still switches").isEqualTo("[\"browser\"]");
        assertThat(info.path("saveError").asText()).contains("no pinned folder");
    }

    @Test
    void aSaveThatFailsReachesTheGearAndTheSwitchStillHolds(@TempDir Path workspace)
            throws IOException {
        // The local file's place is taken by a directory, so the write fails.
        Files.createDirectories(workspace.resolve(SpectroConfig.WS_LOCAL_SETTINGS));
        FakeSocket socket = new FakeSocket("ws-466-n", "ws://localhost/ws");
        SessionConnection connection = configuredAtConnect(socket, workspace);

        connection.onSetToolGroupsOff(JSON.valueToTree(List.of("images")), true);

        JsonNode info = lastFrame(socket, "tool_groups_info");
        assertThat(info.path("off").toString()).isEqualTo("[\"images\"]");
        assertThat(info.path("saveError").asText()).as("the failure is named").isNotBlank();
        assertThat(Files.isDirectory(workspace.resolve(SpectroConfig.WS_LOCAL_SETTINGS)))
                .as("nothing replaced the directory").isTrue();
    }

    @Test
    void theSocketHandlerPassesTheSaveFlag(@TempDir Path workspace) throws IOException {
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket socket = new FakeSocket("ws-466-route-save", "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);

        handler.handleTextMessage(socket, new org.springframework.web.socket.TextMessage(
                "{\"type\":\"set_tool_groups_off\",\"groups\":[\"web\"],\"save\":true}"));

        assertThat(lastFrame(socket, "tool_groups_info").has("saveError"))
                .as("the handler asked for a save, and a session without a folder answers why it did not")
                .isTrue();
    }

    /**
     * Criterion 6 over the belt the session really built: no registered tool
     * is claimed by two groups' name rules, and each tool's MCP twin
     * ({@code mcp__x__<name>}) belongs to the MCP group only. The names come
     * from the belt, so a tool added tomorrow is checked without an edit here.
     */
    @Test
    void eachToolOfTheRealBeltBelongsToAtMostOneGroup(@TempDir Path workspace) {
        SessionConnection connection = sessionIn(new FakeSocket("ws-466-o", "ws://localhost/ws"), workspace);
        connection.adoptSessionConfig();
        connection.buildAgentOnce();
        List<String> belt = connection.belt().specs().stream().map(ToolSpec::name).toList();
        assertThat(belt).as("test premise: the real belt").hasSizeGreaterThanOrEqualTo(34);

        for (String name : belt) {
            List<ToolGroup> holders = java.util.Arrays.stream(ToolGroup.values())
                    .filter(group -> group.holds(name)).toList();
            assertThat(holders).as(name + " is claimed by at most one group").hasSizeLessThanOrEqualTo(1);
            assertThat(ToolGroup.of(name)).as(name).isEqualTo(holders.stream().findFirst());
            String twin = name.startsWith("mcp__") ? name : "mcp__x__" + name;
            assertThat(ToolGroup.of(twin)).as(twin).contains(ToolGroup.MCP);
        }
    }
}
