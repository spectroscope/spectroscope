package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.server.settings.SettingsController;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;

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
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 580: a settings write the server sees reaches a chat that has not run
 * yet, so New chat, which reuses that chat's socket, starts on the settings as
 * they are now.
 *
 * <p>The settings view, a second window and a direct client all write through
 * {@link SettingsController}; the page's blank record keeps the socket it
 * connected at page load. Three loopback backends stand in: an ollama for the
 * old default, a second ollama for a moved address, and a llama.cpp for the
 * new default. Each records the model of every request that is not a title
 * call. The refresh runs inline here, so nothing waits on a clock for it.</p>
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SettingsWriteReachesTheBlankChatTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private HttpServer ollama;
    private HttpServer movedOllama;
    private HttpServer llamacpp;
    private final List<String> ollamaModels = new CopyOnWriteArrayList<>();
    private final List<String> movedModels = new CopyOnWriteArrayList<>();
    private final List<String> llamacppModels = new CopyOnWriteArrayList<>();
    private final List<String> written = new ArrayList<>();
    private byte[] userBefore;

    @BeforeEach
    void startBackendsAndSetTheOldDefault() throws IOException {
        ollama = ollama(ollamaModels);
        movedOllama = ollama(movedModels);
        llamacpp = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        llamacpp.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        llamacpp.createContext("/v1/chat/completions", this::answerOpenAi);
        llamacpp.start();
        Path user = SpectroConfig.USER_SETTINGS_PATH;
        userBefore = Files.exists(user) ? Files.readAllBytes(user) : null;
        Files.createDirectories(user.getParent());
        Files.writeString(user, """
                { "provider": "ollama", "model": "m-old", "ollamaBaseUrl": "%s", "llamacppBaseUrl": "%s" }
                """.formatted(url(ollama), url(llamacpp)));
    }

    @AfterEach
    void restore() throws IOException {
        ollama.stop(0);
        movedOllama.stop(0);
        llamacpp.stop(0);
        for (String id : written) {
            if (id != null) {
                Files.deleteIfExists(SessionStore.sessionFile(id));
            }
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
        server.createContext("/api/chat", exchange -> answerOllama(exchange, models));
        server.start();
        return server;
    }

    private static String url(HttpServer server) {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static String host(HttpServer server) {
        return "127.0.0.1:" + server.getAddress().getPort();
    }

    /** True for the title call, which asks with its own instruction (card 445). */
    private static boolean titleCall(JsonNode body) {
        for (JsonNode message : body.path("messages")) {
            if (message.path("content").asText("").equals(SessionTitles.INSTRUCTION)) {
                return true;
            }
        }
        return false;
    }

    private static void answerOllama(HttpExchange exchange, List<String> models) throws IOException {
        JsonNode body = JSON.readTree(exchange.getRequestBody().readAllBytes());
        if (!titleCall(body)) {
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

    private void answerOpenAi(HttpExchange exchange) throws IOException {
        JsonNode body = JSON.readTree(exchange.getRequestBody().readAllBytes());
        if (!titleCall(body)) {
            llamacppModels.add(body.path("model").asText());
        }
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        exchange.sendResponseHeaders(200, 0);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\n"
                    + "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                    + "data: [DONE]\n\n").getBytes(StandardCharsets.UTF_8));
        }
    }

    /** A chat the page opened before the write: its socket read the settings at connect. */
    private static SessionConnection chat(FakeSocket socket, LiveSessions live) {
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(SpectroConfig.Overrides.none()), null, null, live);
        connection.useSettingsRefresh(Runnable::run);
        connection.start();
        return connection;
    }

    /** The settings view of any window: the route every page and client writes through. */
    private static SettingsController settingsView(LiveSessions live) {
        SettingsController controller = new SettingsController();
        controller.useLiveSessions(live);
        return controller;
    }

    private static void save(SettingsController view, String patch) throws IOException {
        view.putUser(JSON.readTree(patch), new MockHttpServletRequest());
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

    private static String pair(JsonNode frame) {
        return frame.path("provider").asText() + "/" + frame.path("model").asText();
    }

    private static JsonNode lastProviderInfo(FakeSocket socket) {
        return frames(socket, "provider_info").getLast();
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
    void theSettingsViewMovesABlankChatToTheProviderItSaved() throws Exception {
        LiveSessions live = new LiveSessions();
        FakeSocket socket = new FakeSocket("ws-580-view", "ws://localhost/ws");
        SessionConnection chat = chat(socket, live);
        try {
            assertThat(pair(lastProviderInfo(socket))).as("premise: the chat connected on the old default")
                    .isEqualTo("ollama/m-old");

            save(settingsView(live), """
                    { "provider": "llamacpp", "model": "lc-new" }""");

            JsonNode moved = lastProviderInfo(socket);
            assertThat(pair(moved)).as("the footer of the blank chat names the saved default")
                    .isEqualTo("llamacpp/lc-new");
            assertThat(moved.path("host").asText()).isEqualTo(host(llamacpp));
            assertThat(moved.has("answers")).as("it answers no pick, so the page saves nothing").isFalse();

            chat.onUserMessage("hello", null); // New chat reuses this record; this is its first send
            awaitRunEnds(socket, 1);
            written.add(chat.sessionId());
            assertThat(pair(frames(socket, "run_start").getFirst())).as("the run_start names the new default")
                    .isEqualTo("llamacpp/lc-new");
            assertThat(llamacppModels).as("the run went to the new provider").containsExactly("lc-new");
            assertThat(ollamaModels).as("the old default was not asked").isEmpty();
        } finally {
            chat.onClose();
        }
    }

    @Test
    void aWriteFromAnotherWindowMovesTheBlankChatAndNotTheSessionThatRan() throws Exception {
        LiveSessions live = new LiveSessions();
        FakeSocket ranSocket = new FakeSocket("ws-580-ran", "ws://localhost/ws");
        FakeSocket blankSocket = new FakeSocket("ws-580-blank", "ws://localhost/ws");
        SessionConnection ran = chat(ranSocket, live);
        SessionConnection blank = chat(blankSocket, live);
        try {
            ran.onUserMessage("first", null);
            awaitRunEnds(ranSocket, 1);
            written.add(ran.sessionId());
            int ranAnnouncements = frames(ranSocket, "provider_info").size();

            // The settings view of the other window, or a client with no page at
            // all. It also moves ollama's address: a session that ran built its
            // backend at its first run, so a header that named the new host
            // would name an address its runs do not dial.
            save(settingsView(live), """
                    { "provider": "llamacpp", "model": "lc-new", "ollamaBaseUrl": "%s" }"""
                    .formatted(url(movedOllama)));

            assertThat(pair(lastProviderInfo(blankSocket))).as("the blank chat in this window moved")
                    .isEqualTo("llamacpp/lc-new");
            assertThat(frames(ranSocket, "provider_info")).as("card 459: a session that ran keeps its backend")
                    .hasSize(ranAnnouncements);

            ran.onUserMessage("second", null);
            awaitRunEnds(ranSocket, 2);
            assertThat(pair(frames(ranSocket, "run_start").getLast())).isEqualTo("ollama/m-old");
            assertThat(llamacppModels).as("the saved default did not reach the session that ran").isEmpty();
        } finally {
            ran.onClose();
            blank.onClose();
        }
    }

    @Test
    void aChatThatSwitchedKeepsItsPickAndTakesTheAddressTheSettingsHoldNow() throws Exception {
        LiveSessions live = new LiveSessions();
        FakeSocket socket = new FakeSocket("ws-580-picked", "ws://localhost/ws");
        SessionConnection chat = chat(socket, live);
        try {
            chat.onSetProvider("ollama", "m-pick", "pick-580");
            assertThat(pair(lastProviderInfo(socket))).as("premise: the pick was taken").isEqualTo("ollama/m-pick");

            save(settingsView(live), """
                    { "provider": "llamacpp", "model": "lc-new", "ollamaBaseUrl": "%s" }"""
                    .formatted(url(movedOllama)));

            JsonNode now = lastProviderInfo(socket);
            assertThat(pair(now)).as("the pick outranks the saved default").isEqualTo("ollama/m-pick");
            assertThat(now.path("host").asText()).as("the pick dials the address the settings hold")
                    .isEqualTo(host(movedOllama));

            chat.onUserMessage("hello", null);
            awaitRunEnds(socket, 1);
            written.add(chat.sessionId());
            assertThat(movedModels).containsExactly("m-pick");
            assertThat(ollamaModels).isEmpty();
            assertThat(llamacppModels).isEmpty();
        } finally {
            chat.onClose();
        }
    }

    @Test
    void anOpenChatIsToldOfAWriteAndAClosedOneIsNot() {
        LiveSessions live = new LiveSessions();
        AtomicInteger told = new AtomicInteger();
        FakeSocket socket = new FakeSocket("ws-580-closed", "ws://localhost/ws");
        SessionConnection chat = new SessionConnection(socket, JSON,
                SpectroConfig.load(SpectroConfig.Overrides.none()), null, null, live);
        chat.useSettingsRefresh(task -> told.incrementAndGet());
        chat.start();
        assertThat(told).as("no write since the read, no refresh at registration").hasValue(0);

        live.settingsWritten();
        assertThat(told).as("an open chat hears of the write").hasValue(1);

        chat.onClose();
        live.settingsWritten();
        assertThat(told).as("a closed chat is no longer told").hasValue(1);
    }

    @Test
    void aWriteBetweenTheConnectReadAndTheRegistrationStillReachesTheChat() throws Exception {
        // Review nit: the socket handler reads the settings, then the
        // connection registers. A write in between told nobody.
        LiveSessions live = new LiveSessions();
        FakeSocket socket = new FakeSocket("ws-580-gap", "ws://localhost/ws");
        SessionConnection chat = new SessionConnection(socket, JSON,
                SpectroConfig.load(SpectroConfig.Overrides.none()), null, null, live);
        chat.useSettingsRefresh(Runnable::run);
        save(settingsView(live), """
                { "provider": "llamacpp", "model": "lc-new" }"""); // before the chat registers
        chat.start();
        try {
            assertThat(pair(frames(socket, "provider_info").getFirst())).as("premise: the connect frame is the old read")
                    .isEqualTo("ollama/m-old");
            assertThat(pair(lastProviderInfo(socket))).as("the write in the gap reached the chat")
                    .isEqualTo("llamacpp/lc-new");
        } finally {
            chat.onClose();
        }
    }

    @Test
    void aWokenSessionWhoseFolderIsGoneKeepsTheBackendItsRecordNames(@TempDir Path gone) throws Exception {
        // Review D3: a woken session whose recorded folder is gone has no
        // workspace before its first message, so only the store tells it from
        // a blank chat (release 0.14.2 D1: it runs on the pair its record names).
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        String id = "20261013-120000-c580wake";
        String folder = gone.resolve("deleted-folder").toString().replace("\\", "\\\\");
        Files.writeString(SessionStore.sessionFile(id), """
                {"type":"run_start","runId":"r1","agentId":"main","prompt":"hi","provider":"llamacpp","model":"old-model","workspace":"%1$s","ts":1}
                {"type":"text_delta","agentId":"main","text":"first answer","ts":2}
                {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":3}
                """.formatted(folder));
        written.add(id);
        LiveSessions live = new LiveSessions();
        FakeSocket socket = new FakeSocket("ws-580-wake", "ws://localhost/ws");
        SessionConnection chat = chat(socket, live);
        try {
            chat.onWakeSession(id);
            assertThat(pair(lastProviderInfo(socket))).as("premise: the wake names the recorded pair")
                    .isEqualTo("llamacpp/old-model");

            save(settingsView(live), """
                    { "model": "m-saved" }""");

            assertThat(pair(lastProviderInfo(socket))).as("the woken session keeps the pair its record names")
                    .isEqualTo("llamacpp/old-model");
        } finally {
            chat.onClose();
        }
    }

    @Test
    void aRefreshThatReadBeforeTheFirstRunDoesNotOutliveItWhenTheFolderSettingsAreBroken(@TempDir Path folder)
            throws Exception {
        // Review D2: the folder's settings cannot be parsed, so the session
        // moment falls back to the config the chat already holds. The refresh
        // read that config before the first run and must lose to it: the
        // header names what the run dials.
        Files.createDirectories(folder.resolve(SpectroConfig.PROJECT_SETTINGS).getParent());
        Files.writeString(folder.resolve(SpectroConfig.PROJECT_SETTINGS), "{ not json");
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, """
                { "provider": "ollama", "model": "m-old", "ollamaBaseUrl": "%s", "workspace": "%s" }
                """.formatted(url(ollama), folder.toString().replace("\\", "\\\\")));
        LiveSessions live = new LiveSessions();
        FakeSocket socket = new FakeSocket("ws-580-broken", "ws://localhost/ws");
        SessionConnection chat = chat(socket, live);
        AtomicBoolean firstRunInsideTheRead = new AtomicBoolean();
        chat.useSettingsReader(() -> {
            if (firstRunInsideTheRead.getAndSet(false)) {
                chat.onUserMessage("hello", null);
                try {
                    awaitRunEnds(socket, 1);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            return SpectroConfig.load(SpectroConfig.Overrides.none());
        });
        try {
            Files.writeString(SpectroConfig.USER_SETTINGS_PATH, """
                    { "provider": "ollama", "model": "m-old", "ollamaBaseUrl": "%s", "workspace": "%s" }
                    """.formatted(url(movedOllama), folder.toString().replace("\\", "\\\\")));
            firstRunInsideTheRead.set(true);
            live.settingsWritten();
            written.add(chat.sessionId());
            assertThat(socket.textJoined()).as("premise: the folder's settings were refused")
                    .contains("malformed settings file");
            assertThat(ollamaModels).as("premise: the first run dialled the address it was built on")
                    .containsExactly("m-old");

            assertThat(lastProviderInfo(socket).path("host").asText())
                    .as("the header names the address the run dials").isEqualTo(host(ollama));
        } finally {
            chat.onClose();
        }
    }
}
