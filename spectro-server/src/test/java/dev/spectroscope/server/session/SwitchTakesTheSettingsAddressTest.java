package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 579 (live check 0.15.3, D7): a provider switch in a live session dials
 * the address the settings hold now, not the one the session read when it
 * connected.
 *
 * <p>Two loopback ollamas stand in: the one the settings named when the
 * session ran, and the one they name after the owner reset the address. Each
 * records the model of every chat request that is not a title call.</p>
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SwitchTakesTheSettingsAddressTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private HttpServer before;
    private HttpServer after;
    private HttpServer folders;
    private final List<String> beforeModels = new CopyOnWriteArrayList<>();
    private final List<String> afterModels = new CopyOnWriteArrayList<>();
    private final List<String> folderModels = new CopyOnWriteArrayList<>();
    private final List<String> written = new ArrayList<>();
    private byte[] userBefore;

    @BeforeEach
    void startBackendsAndNameTheFirst() throws IOException {
        before = ollama(beforeModels);
        after = ollama(afterModels);
        folders = ollama(folderModels);
        Path user = SpectroConfig.USER_SETTINGS_PATH;
        userBefore = Files.exists(user) ? Files.readAllBytes(user) : null;
        Files.createDirectories(user.getParent());
        Files.writeString(user, """
                { "provider": "ollama", "model": "m1", "baseUrl": "%1$s", "ollamaBaseUrl": "%1$s" }
                """.formatted(url(before)));
    }

    @AfterEach
    void restore() throws IOException {
        before.stop(0);
        after.stop(0);
        folders.stop(0);
        for (String id : written) {
            Files.deleteIfExists(SessionStore.sessionFile(id));
        }
        Path user = SpectroConfig.USER_SETTINGS_PATH;
        if (userBefore == null) {
            Files.deleteIfExists(user);
        } else {
            Files.write(user, userBefore);
        }
    }

    private static HttpServer ollama(List<String> models) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/api/chat", exchange -> answer(exchange, models));
        server.start();
        return server;
    }

    private static String url(HttpServer server) {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static String host(HttpServer server) {
        return "127.0.0.1:" + server.getAddress().getPort();
    }

    private static void answer(HttpExchange exchange, List<String> models) throws IOException {
        JsonNode body = JSON.readTree(exchange.getRequestBody().readAllBytes());
        String system = body.path("messages").path(0).path("content").asText("");
        if (!system.equals(SessionTitles.INSTRUCTION)) {
            models.add(body.path("model").asText());
        }
        exchange.getResponseHeaders().set("Content-Type", "application/x-ndjson");
        exchange.sendResponseHeaders(200, 0);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(("{\"message\":{\"role\":\"assistant\",\"content\":\"ok\"},\"done\":false}\n")
                    .getBytes(StandardCharsets.UTF_8));
            out.write(("{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,"
                    + "\"done_reason\":\"stop\",\"prompt_eval_count\":9,\"eval_count\":3}\n")
                    .getBytes(StandardCharsets.UTF_8));
        }
    }

    private static List<JsonNode> frames(FakeSocket socket, String type) {
        List<JsonNode> out = new ArrayList<>();
        for (FakeSocket.Frame frame : socket.frames()) {
            try {
                JsonNode node = JSON.readTree(frame.payload());
                if (type.equals(node.path("type").asText())) {
                    out.add(node);
                }
            } catch (IOException notJson) {
                // not a frame this test reads
            }
        }
        return out;
    }

    /** Waits on the condition, not on a clock: the n-th run_end, or a minute at most. */
    private static void awaitRunEnds(FakeSocket socket, int n) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (frames(socket, "run_end").size() < n && System.nanoTime() < deadline) {
            Thread.sleep(20);
        }
        assertThat(frames(socket, "run_end")).as("run %d ended", n).hasSizeGreaterThanOrEqualTo(n);
    }

    @Test
    void aSwitchInALiveSessionDialsTheAddressTheSettingsHoldNow() throws Exception {
        FakeSocket socket = new FakeSocket("ws-579-live", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(SpectroConfig.Overrides.none()), null);
        connection.start();
        try {
            connection.onUserMessage("first", null);
            awaitRunEnds(socket, 1);
            written.add(connection.sessionId());
            assertThat(beforeModels).as("premise: the live session ran on the first address")
                    .containsExactly("m1");

            // The D7 restore: the shared address moves, ollama's own is removed.
            Files.writeString(SpectroConfig.USER_SETTINGS_PATH, """
                    { "provider": "ollama", "model": "m1", "baseUrl": "%s" }
                    """.formatted(url(after)));
            connection.onSetProvider("ollama", "m2", "pick-579");

            assertThat(frames(socket, "error")).as("the switch was not refused").isEmpty();
            JsonNode answer = frames(socket, "provider_info").getLast();
            assertThat(answer.path("answers").asText()).isEqualTo("pick-579");
            assertThat(answer.path("host").asText()).as("the switch names the address the settings hold")
                    .isEqualTo(host(after));

            connection.onUserMessage("second", null);
            awaitRunEnds(socket, 2);
            assertThat(afterModels).as("the next run went to the address the settings hold")
                    .containsExactly("m2");
            assertThat(beforeModels).as("the old address was not asked again").containsExactly("m1");
        } finally {
            connection.onClose();
        }
    }

    @Test
    void aSessionFoldersAddressReachesASwitchExactlyAsItReachesAFirstRun(@TempDir Path folder) throws Exception {
        // Owner, 2026-10-13: a session folder may set provider addresses, and a
        // switch reads the same scopes, in the same order, as a session's first
        // run. During the session the folder names its own ollama while the user
        // scope names another for the same key; the folder's wins at the switch,
        // as it wins at a first run on that folder with the same files.
        FakeSocket socket = new FakeSocket("ws-579-folder-now", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(SpectroConfig.Overrides.none()), null);
        connection.start();
        String switched;
        try {
            connection.onSetWorkspace("set", folder.toString());
            connection.onUserMessage("first", null);
            awaitRunEnds(socket, 1);
            written.add(connection.sessionId());
            assertThat(beforeModels).as("premise: the first run dialled the user-scope address").containsExactly("m1");

            Files.createDirectories(folder.resolve(SpectroConfig.WS_LOCAL_SETTINGS).getParent());
            Files.writeString(folder.resolve(SpectroConfig.WS_LOCAL_SETTINGS), """
                    { "ollamaBaseUrl": "%s" }
                    """.formatted(url(folders)));
            Files.writeString(SpectroConfig.USER_SETTINGS_PATH, """
                    { "provider": "ollama", "model": "m1", "baseUrl": "%1$s", "ollamaBaseUrl": "%1$s" }
                    """.formatted(url(after)));
            connection.onSetProvider("ollama", "m2", "pick-579-folder-now");

            assertThat(frames(socket, "error")).as("the switch was not refused").isEmpty();
            switched = frames(socket, "provider_info").getLast().path("host").asText();
            connection.onUserMessage("second", null);
            awaitRunEnds(socket, 2);
        } finally {
            connection.onClose();
        }

        FakeSocket fresh = new FakeSocket("ws-579-first-run", "ws://localhost/ws");
        SessionConnection firstRun = new SessionConnection(fresh, JSON,
                SpectroConfig.load(SpectroConfig.Overrides.none()), null);
        firstRun.start();
        try {
            firstRun.onSetWorkspace("set", folder.toString());
            firstRun.onUserMessage("first", null);
            awaitRunEnds(fresh, 1);
            written.add(firstRun.sessionId());
            String atFirstRun = frames(fresh, "provider_info").getLast().path("host").asText();

            assertThat(atFirstRun).as("premise: a first run on the folder dials the folder's address")
                    .isEqualTo(host(folders));
            assertThat(switched).as("the switch names what a first run with the same files names")
                    .isEqualTo(atFirstRun);
            assertThat(folderModels).as("the switch's run, then the first run, both on the folder's address")
                    .containsExactly("m2", "m1");
            assertThat(afterModels).as("the user-scope address lost to the folder both times").isEmpty();
        } finally {
            firstRun.onClose();
        }
    }

    @Test
    void anAddressTheFolderSetBeforeTheFirstRunStaysAcrossASwitch(@TempDir Path folder) throws Exception {
        // The folder's own settings name an address when the session starts,
        // and the first run dials it. A switch reads the folder again, as the
        // first run does (owner, 2026-10-13), so the address stays while the
        // folder names it.
        Files.createDirectories(folder.resolve(SpectroConfig.PROJECT_SETTINGS).getParent());
        Files.writeString(folder.resolve(SpectroConfig.PROJECT_SETTINGS), """
                { "ollamaBaseUrl": "%s" }
                """.formatted(url(folders)));
        FakeSocket socket = new FakeSocket("ws-579-folder", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(SpectroConfig.Overrides.none()), null);
        connection.start();
        try {
            connection.onSetWorkspace("set", folder.toString());
            connection.onUserMessage("first", null);
            awaitRunEnds(socket, 1);
            written.add(connection.sessionId());
            assertThat(folderModels).as("premise: the first run dialled the folder's address").containsExactly("m1");

            Files.writeString(SpectroConfig.USER_SETTINGS_PATH, """
                    { "provider": "ollama", "model": "m1", "baseUrl": "%s" }
                    """.formatted(url(after)));
            connection.onSetProvider("ollama", "m2", "pick-579-folder");

            assertThat(frames(socket, "provider_info").getLast().path("host").asText())
                    .as("the folder's address from the session moment stays").isEqualTo(host(folders));
            connection.onUserMessage("second", null);
            awaitRunEnds(socket, 2);
            assertThat(folderModels).containsExactly("m1", "m2");
            assertThat(afterModels).isEmpty();
        } finally {
            connection.onClose();
        }
    }

    @Test
    void aSessionFolderThatHoldsTheLaunchFolderAndTheUserSettingsSwitchesToWhatAFirstRunReads() throws Exception {
        // Review 1, I2, built on probe X1. A CLI start in the home folder, with
        // the home folder picked for the chat: the session folder is the launch
        // folder and holds the user settings, the two scopes an earlier check
        // kept the session's addresses for. The owner resets the address in
        // the user settings, the file the Settings page writes. Owner,
        // 2026-10-13: the switch names what a first run with the same files
        // names, in this corner too.
        Path home = SpectroConfig.USER_SETTINGS_PATH.getParent().getParent();
        FakeSocket socket = new FakeSocket("ws-579-corner", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(SpectroConfig.Overrides.none(), home), null);
        connection.useLaunchFolder(home);
        connection.start();
        String switched;
        try {
            connection.onSetWorkspace("set", home.toString());
            connection.onUserMessage("first", null);
            awaitRunEnds(socket, 1);
            written.add(connection.sessionId());
            assertThat(beforeModels).as("premise: the first run dialled the address the settings held")
                    .containsExactly("m1");

            Files.writeString(SpectroConfig.USER_SETTINGS_PATH, """
                    { "provider": "ollama", "model": "m1", "baseUrl": "%1$s", "ollamaBaseUrl": "%1$s" }
                    """.formatted(url(after)));
            connection.onSetProvider("ollama", "m2", "pick-579-corner");
            assertThat(frames(socket, "error")).as("neither the folder nor the switch was refused").isEmpty();
            switched = frames(socket, "provider_info").getLast().path("host").asText();
        } finally {
            connection.onClose();
        }

        FakeSocket fresh = new FakeSocket("ws-579-corner-first", "ws://localhost/ws");
        SessionConnection firstRun = new SessionConnection(fresh, JSON,
                SpectroConfig.load(SpectroConfig.Overrides.none(), home), null);
        firstRun.useLaunchFolder(home);
        firstRun.start();
        try {
            firstRun.onSetWorkspace("set", home.toString());
            firstRun.onUserMessage("first", null);
            awaitRunEnds(fresh, 1);
            written.add(firstRun.sessionId());
            assertThat(frames(fresh, "error")).as("the folder was not refused").isEmpty();
            String atFirstRun = frames(fresh, "provider_info").getLast().path("host").asText();

            assertThat(atFirstRun).as("premise: a first run on these files dials the reset address")
                    .isEqualTo(host(after));
            assertThat(switched).as("the switch names what a first run with the same files names")
                    .isEqualTo(atFirstRun);
        } finally {
            firstRun.onClose();
        }
    }

    @Test
    void aBrokenUserSettingsFileDuringASwitchIsReportedAndTheSessionKeepsItsAddresses() throws Exception {
        // Second review X2: the owner leaves a typo in the user settings while
        // a session is open. The switch must not throw out of the socket
        // thread (card 78: that closed the whole session) and says once why
        // it kept the addresses, as the other settings reads do.
        FakeSocket socket = new FakeSocket("ws-579-broken", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(SpectroConfig.Overrides.none()), null);
        connection.start();
        try {
            connection.onUserMessage("first", null);
            awaitRunEnds(socket, 1);
            written.add(connection.sessionId());
            Files.writeString(SpectroConfig.USER_SETTINGS_PATH, "{ \"provider\": \"ollama\", ");

            connection.onSetProvider("ollama", "m2", "pick-579-broken");

            assertThat(socket.closed.get()).as("the socket stays open").isNull();
            JsonNode answer = frames(socket, "provider_info").getLast();
            assertThat(answer.path("answers").asText()).isEqualTo("pick-579-broken");
            assertThat(answer.path("host").asText()).as("the session keeps its address").isEqualTo(host(before));
            assertThat(frames(socket, "error")).as("the broken file is reported")
                    .anySatisfy(error -> assertThat(error.path("message").asText())
                            .contains("malformed settings file")
                            .contains(SpectroConfig.USER_SETTINGS_PATH.toString()));
        } finally {
            connection.onClose();
        }
    }
}
