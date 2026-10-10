package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.ToolGroup;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 493 at the door a browser session goes through: the composer gear's
 * {@code set_local_mode} frame applies the Local mode switch to the session in
 * memory at once, writes the values into the pinned folder's local file, and
 * gives every key back what it held when it is switched off.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionLocalModeTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private String previousUserSettings;

    @BeforeEach
    void pinTheBackend() throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        previousUserSettings = Files.exists(file) ? Files.readString(file) : null;
        Files.createDirectories(file.getParent());
        Files.writeString(file, "{ \"provider\": \"ollama\", \"model\": \"qwen2.5:7b\" }");
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

    private static SessionConnection unpinned(FakeSocket socket) {
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(SpectroConfig.Overrides.none()), null);
        connection.start();
        return connection;
    }

    private static SessionConnection built(SessionConnection connection) {
        connection.adoptSessionConfig();
        connection.buildAgentOnce();
        return connection;
    }

    private static void writeLocal(Path workspace, String json) throws IOException {
        Path local = workspace.resolve(SpectroConfig.WS_LOCAL_SETTINGS);
        Files.createDirectories(local.getParent());
        Files.writeString(local, json);
    }

    private static JsonNode readLocal(Path workspace) throws IOException {
        Path local = workspace.resolve(SpectroConfig.WS_LOCAL_SETTINGS);
        return Files.exists(local) ? JSON.readTree(local.toFile()) : JSON.createObjectNode();
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

    private static JsonNode row(JsonNode info, String key) {
        for (JsonNode row : info.path("rows")) {
            if (key.equals(row.path("key").asText())) {
                return row;
            }
        }
        throw new AssertionError("no row " + key + " in " + info);
    }

    private static JsonNode on() {
        return JSON.createObjectNode().put("type", "set_local_mode").put("on", true);
    }

    private static JsonNode off() {
        return JSON.createObjectNode().put("type", "set_local_mode").put("on", false);
    }

    private static JsonNode edit(String key, Object value) {
        ObjectNode frame = JSON.createObjectNode().put("type", "set_local_mode");
        frame.putObject("values").set(key, JSON.valueToTree(value));
        return frame;
    }

    private static List<String> names(List<ToolSpec> specs) {
        return specs.stream().map(ToolSpec::name).toList();
    }

    /** Refreshes what the top of a prompt refreshes, without running one. */
    private static void topOfPrompt(SessionConnection connection) {
        connection.refreshSessionsPerChat();
        connection.refreshCareParagraph();
        connection.refreshReadShare();
    }

    @Test
    void switchingOnAppliesEveryValueToTheOpenSessionAtOnce(@TempDir Path workspace) throws IOException {
        FakeSocket socket = new FakeSocket("ws-493-a", "ws://localhost/ws");
        SessionConnection connection = built(sessionIn(socket, workspace));
        assertThat(connection.agent().sessionsPerChat()).as("premise: no count").isNull();

        connection.onSetLocalMode(on());

        assertThat(connection.agent().sessionsPerChat()).isEqualTo(3);
        assertThat(connection.agent().readSharePercent()).isEqualTo(10);
        assertThat(connection.agent().careParagraphForNextRun()).contains("Work in small steps.");
        assertThat(names(connection.agent().toolSpecsForNextRun()))
                .noneMatch(name -> name.startsWith("browser_") || name.startsWith("launch_"))
                .doesNotContain("generate_image", "view_image")
                .contains("web_fetch", "spawn_agent", "read_file");
        JsonNode info = lastFrame(socket, "local_mode_info");
        assertThat(info.path("on").asBoolean()).isTrue();
        assertThat(row(info, "sessionsPerChat").path("value").asInt()).isEqualTo(3);
        assertThat(row(info, "sessionsPerChat").path("changed").asBoolean()).isFalse();
        assertThat(lastFrame(socket, "tool_groups_info").path("off").toString())
                .isEqualTo("[\"browser\",\"launch\",\"images\",\"roles\"]");
    }

    @Test
    void aPinnedFolderKeepsTheValuesAndTheRecordOfWhatTheSwitchWrote(@TempDir Path workspace)
            throws IOException {
        SessionConnection connection = built(sessionIn(new FakeSocket("ws-493-b", "ws://localhost/ws"), workspace));
        connection.onSetLocalMode(on());
        JsonNode saved = readLocal(workspace);
        assertThat(saved.path("sessionsPerChat").asInt()).isEqualTo(3);
        assertThat(saved.path("readSharePercent").asInt()).isEqualTo(10);
        assertThat(saved.path("careParagraph").asText()).isEqualTo("on");
        assertThat(saved.path("toolGroupsOff").toString()).isEqualTo("[\"browser\",\"launch\",\"images\",\"roles\"]");
        assertThat(saved.path("localModeKeys").size()).isEqualTo(4);
    }

    @Test
    void anEditShowsChangedReachesTheChatAndAResetBringsThePresetBack(@TempDir Path workspace)
            throws IOException {
        FakeSocket socket = new FakeSocket("ws-493-c", "ws://localhost/ws");
        SessionConnection connection = built(sessionIn(socket, workspace));
        connection.onSetLocalMode(on());
        connection.onSetLocalMode(edit("sessionsPerChat", 2));

        assertThat(connection.agent().sessionsPerChat()).isEqualTo(2);
        assertThat(row(lastFrame(socket, "local_mode_info"), "sessionsPerChat").path("changed").asBoolean())
                .isTrue();
        assertThat(readLocal(workspace).path("sessionsPerChat").asInt()).isEqualTo(2);

        ObjectNode reset = JSON.createObjectNode().put("type", "set_local_mode");
        reset.putArray("reset").add("sessionsPerChat");
        connection.onSetLocalMode(reset);
        assertThat(connection.agent().sessionsPerChat()).isEqualTo(3);
        assertThat(row(lastFrame(socket, "local_mode_info"), "sessionsPerChat").path("changed").asBoolean())
                .isFalse();
    }

    /** The card's scenario: switch on, edit the count to 2, switch off. */
    @Test
    void switchingOffRestoresWhatTheChatHadAndKeepsAKeySetByHand(@TempDir Path workspace)
            throws IOException {
        writeLocal(workspace, "{ \"careParagraph\": \"on\" }");
        FakeSocket socket = new FakeSocket("ws-493-d", "ws://localhost/ws");
        SessionConnection connection = built(sessionIn(socket, workspace));
        topOfPrompt(connection);
        connection.onSetLocalMode(on());
        connection.onSetLocalMode(edit("sessionsPerChat", 2));
        connection.onSetLocalMode(off());
        topOfPrompt(connection);

        assertThat(connection.agent().sessionsPerChat()).isNull();
        assertThat(connection.agent().readSharePercent()).isEqualTo(25);
        assertThat(connection.agent().toolSpecsForNextRun()).isEqualTo(connection.belt().specs());
        assertThat(connection.agent().careParagraphForNextRun())
                .as("the care paragraph the operator set by hand before switching on")
                .contains("Work in small steps.");
        JsonNode saved = readLocal(workspace);
        assertThat(saved.path("careParagraph").asText()).as("a hand-set key left the file").isEqualTo("on");
        assertThat(saved.has("sessionsPerChat")).isFalse();
        assertThat(saved.has("readSharePercent")).isFalse();
        assertThat(saved.has("toolGroupsOff")).isFalse();
        assertThat(saved.has("localModeKeys")).isFalse();
        assertThat(lastFrame(socket, "local_mode_info").path("on").asBoolean()).isFalse();

        connection.onSetLocalMode(on());
        assertThat(connection.agent().sessionsPerChat())
                .as("the edit made in Local mode comes back with it").isEqualTo(2);
    }

    @Test
    void theSessionMomentDoesNotUndoASwitchMadeBeforeTheFirstPrompt(@TempDir Path workspace) {
        SessionConnection connection = sessionIn(new FakeSocket("ws-493-e", "ws://localhost/ws"), workspace);
        connection.onSetLocalMode(on());
        built(connection);
        topOfPrompt(connection);
        assertThat(connection.agent().sessionsPerChat()).isEqualTo(3);
        assertThat(connection.agent().readSharePercent()).isEqualTo(10);
        assertThat(connection.agent().careParagraphForNextRun()).contains("Work in small steps.");
        assertThat(connection.subagents().childToolGroupsOff())
                .isEqualTo(EnumSet.of(ToolGroup.BROWSER, ToolGroup.LAUNCH, ToolGroup.IMAGES, ToolGroup.ROLES));
    }

    /** Criterion 9: the agent can write the local file; the open chat keeps
     *  the values its session holds. */
    @Test
    void anAgentEditingTheLocalFileDoesNotMoveTheValuesTheChatHolds(@TempDir Path workspace)
            throws IOException {
        SessionConnection connection = built(sessionIn(new FakeSocket("ws-493-f", "ws://localhost/ws"), workspace));
        connection.onSetLocalMode(on());
        writeLocal(workspace, "{ \"sessionsPerChat\": 6, \"readSharePercent\": 50,"
                + " \"careParagraph\": \"off\", \"toolGroupsOff\": [] }");
        topOfPrompt(connection);
        built(connection);
        assertThat(connection.agent().sessionsPerChat()).isEqualTo(3);
        assertThat(connection.agent().readSharePercent()).isEqualTo(10);
        assertThat(connection.agent().careParagraphForNextRun()).contains("Work in small steps.");
        assertThat(names(connection.agent().toolSpecsForNextRun())).noneMatch(name -> name.startsWith("browser_"));
    }

    @Test
    void theToolGroupCheckboxesInLocalModeReplaceThePresetAndShowChanged(@TempDir Path workspace)
            throws IOException {
        FakeSocket socket = new FakeSocket("ws-493-g", "ws://localhost/ws");
        SessionConnection connection = built(sessionIn(socket, workspace));
        connection.onSetLocalMode(on());
        connection.onSetToolGroupsOff(JSON.valueToTree(List.of("browser")), true);
        JsonNode groups = row(lastFrame(socket, "local_mode_info"), "toolGroupsOff");
        assertThat(groups.path("value").toString()).isEqualTo("[\"browser\"]");
        assertThat(groups.path("changed").asBoolean()).isTrue();
        connection.onSetLocalMode(off());
        assertThat(connection.agent().toolSpecsForNextRun()).isEqualTo(connection.belt().specs());
        assertThat(readLocal(workspace).has("toolGroupsOff")).isFalse();
    }

    @Test
    void aNewSessionInTheFolderStartsWithTheSwitchOnFromTheRecord(@TempDir Path workspace)
            throws IOException {
        SessionConnection first = built(sessionIn(new FakeSocket("ws-493-h1", "ws://localhost/ws"), workspace));
        first.onSetLocalMode(on());
        first.onSetLocalMode(edit("readSharePercent", 12));

        FakeSocket socket = new FakeSocket("ws-493-h2", "ws://localhost/ws");
        SessionConnection second = built(sessionIn(socket, workspace));
        JsonNode info = lastFrame(socket, "local_mode_info");
        assertThat(info.path("on").asBoolean()).isTrue();
        assertThat(row(info, "readSharePercent").path("value").asInt()).isEqualTo(12);
        assertThat(row(info, "readSharePercent").path("changed").asBoolean()).isTrue();
        second.onSetLocalMode(off());
        assertThat(readLocal(workspace).has("readSharePercent")).isFalse();
        assertThat(readLocal(workspace).has("localModeKeys")).isFalse();
    }

    /** Review of card 493: switched on in an unpinned chat, then a folder
     *  that holds a key set by hand is pinned. Switching off must leave that
     *  key in the file, and the chat must read it again. */
    @Test
    void aFolderPinnedAfterSwitchingOnKeepsTheKeyTheOperatorSetThereByHand(@TempDir Path workspace)
            throws IOException {
        writeLocal(workspace, "{ \"sessionsPerChat\": 5 }");
        FakeSocket socket = new FakeSocket("ws-493-k", "ws://localhost/ws");
        SessionConnection connection = unpinned(socket);
        connection.onSetLocalMode(on());
        connection.onSetWorkspace("set", workspace.toString());
        assertThat(row(lastFrame(socket, "local_mode_info"), "sessionsPerChat").path("value").asInt())
                .as("the folder's hand-set value, as if the switch went on in that folder").isEqualTo(5);

        connection.onSetLocalMode(off());
        JsonNode saved = readLocal(workspace);
        assertThat(saved.path("sessionsPerChat").asInt()).as("the folder's own hand-set key").isEqualTo(5);
        assertThat(saved.has("readSharePercent")).isFalse();
        assertThat(saved.has("localModeKeys")).isFalse();
        built(connection);
        topOfPrompt(connection);
        assertThat(connection.agent().sessionsPerChat()).as("the chat reads the file again").isEqualTo(5);
    }

    @Test
    void aFolderPinnedAfterSwitchingOnReceivesTheValuesAndTheRecord(@TempDir Path workspace)
            throws IOException {
        FakeSocket socket = new FakeSocket("ws-493-l", "ws://localhost/ws");
        SessionConnection connection = unpinned(socket);
        connection.onSetLocalMode(on());
        connection.onSetLocalMode(edit("readSharePercent", 12));
        connection.onSetWorkspace("set", workspace.toString());
        JsonNode saved = readLocal(workspace);
        assertThat(saved.path("sessionsPerChat").asInt()).isEqualTo(3);
        assertThat(saved.path("readSharePercent").asInt()).as("the chat's edit").isEqualTo(12);
        assertThat(saved.path("careParagraph").asText()).isEqualTo("on");
        assertThat(saved.path("localModeKeys").toString())
                .isEqualTo("[\"sessionsPerChat\",\"toolGroupsOff\",\"readSharePercent\",\"careParagraph\"]");
        connection.onSetLocalMode(off());
        JsonNode after = readLocal(workspace);
        assertThat(after.has("sessionsPerChat")).isFalse();
        assertThat(after.has("readSharePercent")).isFalse();
        assertThat(after.has("localModeKeys")).isFalse();
    }

    @Test
    void pickingAnotherFolderGivesTheFirstOneBackWhatItHeld(@TempDir Path first, @TempDir Path second)
            throws IOException {
        writeLocal(first, "{ \"maxTurns\": 40 }");
        SessionConnection connection = sessionIn(new FakeSocket("ws-493-m", "ws://localhost/ws"), first);
        connection.onSetLocalMode(on());
        assertThat(readLocal(first).has("localModeKeys")).isTrue();
        connection.onSetWorkspace("set", second.toString());
        JsonNode left = readLocal(first);
        assertThat(left.path("maxTurns").asInt()).isEqualTo(40);
        assertThat(left.has("sessionsPerChat")).as("the switch's value stayed in the folder it left").isFalse();
        assertThat(left.has("localModeKeys")).isFalse();
        assertThat(readLocal(second).path("readSharePercent").asInt()).isEqualTo(10);
        connection.onSetLocalMode(off());
        assertThat(readLocal(second).has("localModeKeys")).isFalse();
    }

    @Test
    void aSwitchReadFromOneFolderIsNotCarriedIntoAnotherOne(@TempDir Path first, @TempDir Path second)
            throws IOException {
        built(sessionIn(new FakeSocket("ws-493-n1", "ws://localhost/ws"), first)).onSetLocalMode(on());
        JsonNode recorded = readLocal(first);

        FakeSocket socket = new FakeSocket("ws-493-n2", "ws://localhost/ws");
        SessionConnection connection = sessionIn(socket, first);
        assertThat(lastFrame(socket, "local_mode_info").path("on").asBoolean()).isTrue();
        connection.onSetWorkspace("set", second.toString());
        assertThat(lastFrame(socket, "local_mode_info").path("on").asBoolean())
                .as("the second folder holds no record").isFalse();
        assertThat(readLocal(first)).as("the first folder's record was rewritten").isEqualTo(recorded);
        assertThat(readLocal(second).has("localModeKeys")).isFalse();
        built(connection);
        topOfPrompt(connection);
        assertThat(connection.agent().readSharePercent()).isEqualTo(25);
    }

    @Test
    void anUnpinnedSessionSwitchesInMemoryAndSavesNothing() throws IOException {
        FakeSocket socket = new FakeSocket("ws-493-i", "ws://localhost/ws");
        SessionConnection connection = unpinned(socket);
        connection.onSetLocalMode(on());
        JsonNode info = lastFrame(socket, "local_mode_info");
        assertThat(info.path("on").asBoolean()).isTrue();
        assertThat(row(info, "sessionsPerChat").path("value").asInt()).isEqualTo(3);
        assertThat(row(info, "readSharePercent").path("value").asInt()).isEqualTo(10);
        assertThat(info.has("saveError")).isFalse();
    }

    @Test
    void untrustedFramesAreRefusedAndChangeNothing(@TempDir Path workspace) throws IOException {
        FakeSocket socket = new FakeSocket("ws-493-j", "ws://localhost/ws");
        SessionConnection connection = built(sessionIn(socket, workspace));
        connection.onSetLocalMode(edit("sessionsPerChat", 2));
        assertThat(socket.textJoined()).contains("Local mode is off");
        connection.onSetLocalMode(on());
        connection.onSetLocalMode(edit("sessionsPerChat", 1));
        assertThat(socket.textJoined()).contains("sessionsPerChat");
        connection.onSetLocalMode(edit("maxTurns", 3));
        assertThat(socket.textJoined()).contains("maxTurns");
        assertThat(connection.agent().sessionsPerChat()).isEqualTo(3);
        assertThat(readLocal(workspace).path("sessionsPerChat").asInt()).isEqualTo(3);
    }

    @Test
    void theSocketHandlerRoutesTheFrame() throws IOException {
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket socket = new FakeSocket("ws-493-route", "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);
        handler.handleTextMessage(socket, new org.springframework.web.socket.TextMessage(
                "{\"type\":\"set_local_mode\",\"on\":true}"));
        assertThat(socket.textJoined()).doesNotContain("Unknown message type");
        assertThat(lastFrame(socket, "local_mode_info").path("on").asBoolean()).isTrue();
    }

    @Test
    void theConnectionAnnouncesTheSwitchAtConnect() throws IOException {
        FakeSocket socket = new FakeSocket("ws-493-k", "ws://localhost/ws");
        unpinned(socket);
        JsonNode info = lastFrame(socket, "local_mode_info");
        assertThat(info).as("a local_mode_info frame at connect").isNotNull();
        assertThat(info.path("on").asBoolean()).isFalse();
        assertThat(info.path("rows").size()).isEqualTo(4);
        assertThat(Map.of("sessionsPerChat", 3, "readSharePercent", 10).get(
                row(info, "readSharePercent").path("key").asText())).isEqualTo(10);
        assertThat(row(info, "readSharePercent").path("preset").asInt()).isEqualTo(10);
    }
}
