package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.server.playbooks.PlaybookFolders;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 554, criterion 8e: the playbook a session picked is server state of
 * that session. {@code set_playbook} holds it on the connection, writes it to
 * the session file and answers {@code playbook_info}; a wake and a resume read
 * it back, and a picked folder that is gone is announced as not found.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SetPlaybookFrameTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String ONE_STEP = """
        { "schema_version": 1, "id": "t", "name": "T", "description": "d",
          "models": { "strong": { "primary": { "provider": "ollama", "model": "qwen3:8b" } } },
          "start": "write",
          "nodes": [
            { "kind": "step", "id": "write", "name": "Write", "performer": "chat", "model": "strong" },
            { "kind": "end", "id": "done", "result": "done" }
          ],
          "arrows": [ { "from": "write", "to": "done" } ] }
        """;

    @TempDir Path workspace;
    @TempDir Path playbookDir;

    private final List<String> written = new ArrayList<>();

    @AfterEach
    void removeSessions() throws IOException {
        for (String id : written) {
            Files.deleteIfExists(SessionStore.sessionFile(id));
        }
    }

    private Path registered() throws IOException {
        Files.writeString(playbookDir.resolve("playbook.json"), ONE_STEP);
        PlaybookFolders.inHome().register(playbookDir);
        return playbookDir.toRealPath();
    }

    private SessionConnection connection(FakeSocket socket, String resumeId) {
        SessionConnection c = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                        workspace.toString())), resumeId);
        c.start();
        return c;
    }

    private static List<JsonNode> frames(FakeSocket socket, String type) {
        return socket.textJoined().lines().map(line -> {
            try {
                return JSON.readTree(line);
            } catch (IOException notJson) {
                return JSON.createObjectNode();
            }
        }).filter(n -> type.equals(n.path("type").asText())).toList();
    }

    private String stored(String id, String body) throws IOException {
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Files.writeString(SessionStore.sessionFile(id), body);
        written.add(id);
        return id;
    }

    private static final String RUN = """
            {"type":"run_start","runId":"r1","agentId":"main","prompt":"ALPHA","ts":1}
            {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":2}
            """;

    @Test
    void aPickOfARegisteredFolderIsHeldAnnouncedAndRecorded() throws IOException {
        Path dir = registered();
        FakeSocket socket = new FakeSocket("ws-554-pick", "ws://localhost/ws");
        SessionConnection c = connection(socket, null);
        c.onSetWorkspace("set", workspace.toString()); // mints the session file, as a folder pick does
        String id = c.sessionId();
        written.add(id);

        c.onSetPlaybook(dir.toString());

        assertThat(c.playbookDir()).isEqualTo(dir.toString());
        List<JsonNode> info = frames(socket, "playbook_info");
        assertThat(info).hasSize(1);
        assertThat(info.get(0).path("dir").asText()).isEqualTo(dir.toString());
        assertThat(info.get(0).path("name").asText()).isEqualTo("T");
        assertThat(info.get(0).path("found").asBoolean()).isTrue();
        assertThat(SessionStore.recordedPlaybook(id)).isEqualTo(dir.toString());
        assertThat(frames(socket, "error")).isEmpty();
    }

    @Test
    void anUnregisteredFolderIsRefusedAndNothingChanges(@TempDir Path stranger) throws IOException {
        Files.writeString(stranger.resolve("playbook.json"), ONE_STEP);
        FakeSocket socket = new FakeSocket("ws-554-stranger", "ws://localhost/ws");
        SessionConnection c = connection(socket, null);
        c.onSetWorkspace("set", workspace.toString());
        written.add(c.sessionId());

        c.onSetPlaybook(stranger.toString());

        assertThat(frames(socket, "error")).singleElement()
                .satisfies(e -> assertThat(e.path("message").asText()).contains("not a registered playbook folder"));
        assertThat(c.playbookDir()).isNull();
        assertThat(frames(socket, "playbook_info")).isEmpty();
        assertThat(SessionStore.recordedPlaybook(c.sessionId())).isNull();
    }

    @Test
    void anEmptyPickWithdrawsThePick() throws IOException {
        Path dir = registered();
        FakeSocket socket = new FakeSocket("ws-554-clear", "ws://localhost/ws");
        SessionConnection c = connection(socket, null);
        c.onSetWorkspace("set", workspace.toString());
        written.add(c.sessionId());
        c.onSetPlaybook(dir.toString());

        c.onSetPlaybook(null);

        assertThat(c.playbookDir()).isNull();
        JsonNode last = frames(socket, "playbook_info").getLast();
        assertThat(last.path("dir").isNull()).isTrue();
        assertThat(last.path("found").asBoolean(true)).isFalse();
        assertThat(SessionStore.recordedPlaybook(c.sessionId())).isNull();
    }

    @Test
    void aPickBeforeTheSessionHasAFileMintsNoSessionAndIsWrittenWithTheFirstLine() throws IOException {
        Path dir = registered();
        FakeSocket socket = new FakeSocket("ws-554-early", "ws://localhost/ws");
        SessionConnection c = connection(socket, null);

        c.onSetPlaybook(dir.toString());

        assertThat(c.sessionId()).as("a pick alone makes no session (card 571)").isNull();
        assertThat(c.playbookDir()).isEqualTo(dir.toString());
        assertThat(frames(socket, "playbook_info")).hasSize(1);

        c.onSetWorkspace("set", workspace.toString()); // the first thing that mints the file
        written.add(c.sessionId());
        assertThat(SessionStore.recordedPlaybook(c.sessionId())).isEqualTo(dir.toString());
    }

    @Test
    void aWokenSessionGetsItsPickBack() throws IOException {
        Path dir = registered();
        String id = stored("20261012-210000-w554pick", RUN
                + "{\"type\":\"playbook_picked\",\"dir\":" + JSON.writeValueAsString(dir.toString())
                + ",\"name\":\"T\",\"ts\":3}\n");
        FakeSocket socket = new FakeSocket("ws-554-wake", "ws://localhost/ws");
        SessionConnection c = connection(socket, null);
        assertThat(frames(socket, "playbook_info")).as("premise: a fresh socket names no pick").isEmpty();

        c.onWakeSession(id);

        assertThat(c.playbookDir()).isEqualTo(dir.toString());
        List<JsonNode> info = frames(socket, "playbook_info");
        assertThat(info).hasSize(1);
        assertThat(info.get(0).path("found").asBoolean()).isTrue();
        assertThat(info.get(0).path("name").asText()).isEqualTo("T");
    }

    @Test
    void aResumedSessionWhosePickedFolderIsGoneSaysNotFound(@TempDir Path gone) throws IOException {
        String missing = gone.resolve("deleted-playbook").toString();
        String id = stored("20261012-210100-w554gone", RUN
                + "{\"type\":\"playbook_picked\",\"dir\":" + JSON.writeValueAsString(missing)
                + ",\"name\":\"Old\",\"ts\":3}\n");
        FakeSocket socket = new FakeSocket("ws-554-resume", "ws://localhost/ws?resume=" + id);

        SessionConnection c = connection(socket, id);

        assertThat(c.playbookDir()).as("the pick stays, so a start is refused rather than swapped")
                .isEqualTo(missing);
        List<JsonNode> info = frames(socket, "playbook_info");
        assertThat(info).hasSize(1);
        assertThat(info.get(0).path("dir").asText()).isEqualTo(missing);
        assertThat(info.get(0).path("found").asBoolean(true)).isFalse();
        assertThat(info.get(0).path("name").isNull()).isTrue();
    }

    @Test
    void theSessionListShowsThePickOfAStoredSession() throws IOException {
        Path dir = registered();
        String id = stored("20261012-210200-w554list", RUN
                + "{\"type\":\"playbook_picked\",\"dir\":" + JSON.writeValueAsString(dir.toString())
                + ",\"name\":\"T\",\"ts\":3}\n");

        JsonNode rows = JSON.valueToTree(new SessionsController().sessions());

        JsonNode row = null;
        for (JsonNode r : rows) {
            if (id.equals(r.path("id").asText())) {
                row = r;
            }
        }
        assertThat(row).as("the stored session is listed").isNotNull();
        assertThat(row.path("playbook").asText()).isEqualTo(dir.toString());
    }

    /** A second registered playbook folder, for a pick that replaces another. */
    private Path secondRegistered(Path other) throws IOException {
        Files.writeString(other.resolve("playbook.json"), ONE_STEP.replace("\"name\": \"T\"", "\"name\": \"Y\""));
        PlaybookFolders.inHome().register(other);
        return other.toRealPath();
    }

    private String storedWithPick(String id, String dir) throws IOException {
        return stored(id, RUN + (dir == null ? ""
                : "{\"type\":\"playbook_picked\",\"dir\":" + JSON.writeValueAsString(dir) + ",\"name\":\"Y\",\"ts\":3}\n"));
    }

    /**
     * Card 554 fix round 1: a pick sent before the wake (the page picks, then
     * the first click wakes the stored session) wins over the session's own
     * record and is written into the file at the wake.
     */
    @Test
    void aPickBeforeTheWakeWinsOverTheRecordedPickAndIsWrittenAtTheWake(@TempDir Path other) throws IOException {
        Path x = registered();
        Path y = secondRegistered(other);
        String id = storedWithPick("20261012-230000-w554xbeforewake", y.toString());
        FakeSocket socket = new FakeSocket("ws-554-x-before-wake", "ws://localhost/ws");
        SessionConnection c = connection(socket, null);

        c.onSetPlaybook(x.toString());
        c.onWakeSession(id);

        assertThat(c.playbookDir()).isEqualTo(x.toString());
        assertThat(SessionStore.recordedPlaybook(id)).as("the pick made before the wake is in the file").isEqualTo(x.toString());
        assertThat(frames(socket, "playbook_info").getLast().path("dir").asText()).isEqualTo(x.toString());
    }

    @Test
    void aPickBeforeTheWakeOfASessionWithoutOneIsWrittenAtTheWake() throws IOException {
        Path x = registered();
        String id = storedWithPick("20261012-230100-w554xnopick", null);
        FakeSocket socket = new FakeSocket("ws-554-x-no-pick", "ws://localhost/ws");
        SessionConnection c = connection(socket, null);

        c.onSetPlaybook(x.toString());
        c.onWakeSession(id);

        assertThat(c.playbookDir()).isEqualTo(x.toString());
        assertThat(SessionStore.recordedPlaybook(id)).isEqualTo(x.toString());
    }

    @Test
    void aPickAfterTheWakeReplacesTheRestoredOne(@TempDir Path other) throws IOException {
        Path x = registered();
        Path y = secondRegistered(other);
        String id = storedWithPick("20261012-230200-w554xafterwake", y.toString());
        FakeSocket socket = new FakeSocket("ws-554-x-after-wake", "ws://localhost/ws");
        SessionConnection c = connection(socket, null);

        c.onWakeSession(id);
        assertThat(c.playbookDir()).as("premise: the wake restored the recorded pick").isEqualTo(y.toString());
        c.onSetPlaybook(x.toString());

        assertThat(c.playbookDir()).isEqualTo(x.toString());
        assertThat(SessionStore.recordedPlaybook(id)).isEqualTo(x.toString());
    }

    /**
     * Card 554 fix round 1: an imported session can name a folder on this
     * machine that holds a playbook.json but is no registered playbook folder.
     * It is not announced as found, and nothing is read from it.
     */
    @Test
    void aPickedFolderThatIsNotRegisteredIsNotFound(@TempDir Path stranger) throws IOException {
        Files.writeString(stranger.resolve("playbook.json"), ONE_STEP);
        String id = storedWithPick("20261012-230300-w554stranger", stranger.toRealPath().toString());
        FakeSocket socket = new FakeSocket("ws-554-stranger-wake", "ws://localhost/ws");
        SessionConnection c = connection(socket, null);

        c.onWakeSession(id);

        JsonNode info = frames(socket, "playbook_info").getLast();
        assertThat(info.path("dir").asText()).isEqualTo(stranger.toRealPath().toString());
        assertThat(info.path("found").asBoolean(true)).isFalse();
        assertThat(info.path("registered").asBoolean(true)).isFalse();
        assertThat(info.path("name").isNull()).as("nothing is read from a folder the registry does not know").isTrue();
    }

    /**
     * Card 554, integrator decision b: "No playbook" in the dropdown is held,
     * announced and recorded as a pick of its own, apart from a withdrawn pick.
     */
    @Test
    void anExplicitNoneIsHeldAnnouncedAndRecorded() throws IOException {
        Path dir = registered();
        FakeSocket socket = new FakeSocket("ws-554-none", "ws://localhost/ws");
        SessionConnection c = connection(socket, null);
        c.onSetWorkspace("set", workspace.toString());
        written.add(c.sessionId());
        c.onSetPlaybook(dir.toString());

        c.onSetPlaybook(null, true);

        assertThat(c.playbookDir()).isNull();
        assertThat(c.playbookNone()).isTrue();
        JsonNode info = frames(socket, "playbook_info").getLast();
        assertThat(info.path("none").asBoolean()).isTrue();
        assertThat(info.path("dir").isNull()).isTrue();
        assertThat(info.path("found").asBoolean(true)).isFalse();
        assertThat(SessionStore.recordedPick(c.sessionId())).isEqualTo(new SessionStore.RecordedPick(null, true));
        assertThat(frames(socket, "error")).isEmpty();
    }

    @Test
    void aPickOfAFolderEndsAnExplicitNoneAndAWithdrawnPickIsNoNone() throws IOException {
        Path dir = registered();
        FakeSocket socket = new FakeSocket("ws-554-none-then-pick", "ws://localhost/ws");
        SessionConnection c = connection(socket, null);
        c.onSetWorkspace("set", workspace.toString());
        written.add(c.sessionId());
        c.onSetPlaybook(null, true);

        c.onSetPlaybook(dir.toString());
        assertThat(c.playbookNone()).isFalse();
        assertThat(frames(socket, "playbook_info").getLast().path("none").asBoolean(true)).isFalse();

        c.onSetPlaybook(null, true);
        c.onSetPlaybook(null);
        assertThat(c.playbookNone()).as("a withdrawn pick goes back to the suggestion").isFalse();
        assertThat(SessionStore.recordedPick(c.sessionId())).isEqualTo(new SessionStore.RecordedPick(null, false));
    }

    @Test
    void aWokenSessionGetsItsExplicitNoneBack() throws IOException {
        String id = stored("20261012-230400-w554none", RUN + "{\"type\":\"playbook_picked\",\"none\":true,\"ts\":3}\n");
        FakeSocket socket = new FakeSocket("ws-554-none-wake", "ws://localhost/ws");
        SessionConnection c = connection(socket, null);

        c.onWakeSession(id);

        assertThat(c.playbookNone()).isTrue();
        assertThat(c.playbookDir()).isNull();
        assertThat(frames(socket, "playbook_info")).singleElement()
                .satisfies(info -> assertThat(info.path("none").asBoolean()).isTrue());
    }

    @Test
    void aResumedSessionGetsItsExplicitNoneBack() throws IOException {
        String id = stored("20261012-230500-w554noneresume",
                RUN + "{\"type\":\"playbook_picked\",\"none\":true,\"ts\":3}\n");
        FakeSocket socket = new FakeSocket("ws-554-none-resume", "ws://localhost/ws?resume=" + id);

        SessionConnection c = connection(socket, id);

        assertThat(c.playbookNone()).isTrue();
        assertThat(frames(socket, "playbook_info")).singleElement()
                .satisfies(info -> assertThat(info.path("none").asBoolean()).isTrue());
    }

    @Test
    void theSocketHandlerReadsNoneOffTheFrame() throws IOException {
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket socket = new FakeSocket("ws-554-none-route", "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);

        handler.handleTextMessage(socket, new org.springframework.web.socket.TextMessage(
                "{\"type\":\"set_playbook\",\"dir\":null,\"none\":true}"));

        assertThat(socket.textJoined()).doesNotContain("Unknown message type");
        assertThat(frames(socket, "playbook_info").getLast().path("none").asBoolean()).isTrue();
    }

    @Test
    void aRegisteredPickIsFoundAndSaysSo() throws IOException {
        Path x = registered();
        FakeSocket socket = new FakeSocket("ws-554-registered", "ws://localhost/ws");
        SessionConnection c = connection(socket, null);

        c.onSetPlaybook(x.toString());

        JsonNode info = frames(socket, "playbook_info").getLast();
        assertThat(info.path("found").asBoolean()).isTrue();
        assertThat(info.path("registered").asBoolean()).isTrue();
    }
}
