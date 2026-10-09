package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.WorkspaceResolver;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.wire.LlmWireRecorder;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.socket.TextMessage;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 498: a click into the message box of a stored session wakes its folder
 * on the server, without a run and without a model call.
 *
 * <p>The page sends {@code wake_session} on a socket that holds no session yet.
 * The server binds the id the way a resume does at connect (claim, history,
 * store, backend) and answers with the session's {@code workspace_info},
 * carrying the {@code sessionId} the chip's Finder, Terminal and code graph rows
 * wait for. A recorded folder that is gone is named, never created. Every
 * guarantee is read off a real {@link SessionConnection} over a scripted Ollama
 * that counts the requests it receives.</p>
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionWakeTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private HttpServer mock;
    /** Every body the scripted backend's chat endpoint received, in order. */
    private final List<String> chatBodies = new CopyOnWriteArrayList<>();
    /** The session files this test wrote, removed afterwards. */
    private final List<String> written = new ArrayList<>();

    @AfterEach
    void cleanUp() throws IOException {
        if (mock != null) {
            mock.stop(0);
        }
        for (String id : written) {
            Files.deleteIfExists(SessionStore.sessionFile(id));
            Files.deleteIfExists(LlmWireRecorder.fileFor(id));
            deleteTree(WorkspaceResolver.locate(null, id)); // a folder a broken wake minted
        }
    }

    private static void deleteTree(Path root) throws IOException {
        if (!Files.exists(root)) {
            return;
        }
        try (var walk = Files.walk(root)) {
            for (Path path : walk.sorted(java.util.Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        }
    }

    /** Points a session folder at the scripted backend, as the owner's folder points at his. */
    private void wireBackend(Path folder) throws IOException {
        String baseUrl = config(null).baseUrl();
        Files.createDirectories(folder.resolve(".spectro"));
        Files.writeString(folder.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(baseUrl));
    }

    /** A scripted Ollama that answers every chat with one short line. */
    private String startBackend() throws IOException {
        mock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        mock.createContext("/api/ps", exchange -> answer(exchange, "application/json", "{\"models\":[]}"));
        mock.createContext("/api/chat", exchange -> {
            chatBodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            answer(exchange, "application/x-ndjson", """
                    {"message":{"content":"noted"},"done":false}
                    {"message":{"content":""},"done":true,"prompt_eval_count":8,"eval_count":2}
                    """);
        });
        mock.start();
        return "http://127.0.0.1:" + mock.getAddress().getPort();
    }

    private static void answer(com.sun.net.httpserver.HttpExchange exchange, String type, String body)
            throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", type);
        exchange.sendResponseHeaders(200, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    /** The config every connection here starts from; {@code configured} may be null. */
    private SpectroConfig config(Path configured) throws IOException {
        String baseUrl = mock == null ? startBackend() : "http://127.0.0.1:" + mock.getAddress().getPort();
        return SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", baseUrl, null, null, configured == null ? null : configured.toString()));
    }

    /** A connection on a fresh socket, as the page opens it before any wake. */
    private SessionConnection fresh(FakeSocket socket, Path configured, LiveSessions live) throws IOException {
        SessionConnection connection = new SessionConnection(socket, JSON, config(configured), null, null, live);
        connection.start();
        return connection;
    }

    /** Writes a stored session of two runs whose first run_start records {@code folder}. */
    private String stored(String id, String folder) throws IOException {
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        String workspace = folder == null ? "" : ",\"workspace\":" + JSON.writeValueAsString(folder);
        String body = """
                {"type":"run_start","runId":"r1","agentId":"main","prompt":"ALPHA first question"%1$s,"ts":1}
                {"type":"text_delta","agentId":"main","text":"first answer","ts":2}
                {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":3}
                {"type":"run_start","runId":"r2","agentId":"main","prompt":"OMEGA second question","ts":10}
                {"type":"text_delta","agentId":"main","text":"second answer","ts":11}
                {"type":"run_end","runId":"r2","stopReason":"end_turn","ts":12}
                """.formatted(workspace);
        Files.writeString(SessionStore.sessionFile(id), body);
        written.add(id);
        return id;
    }

    private static JsonNode parse(String line) {
        try {
            return JSON.readTree(line);
        } catch (IOException notJson) {
            return JSON.createObjectNode();
        }
    }

    private static List<JsonNode> frames(FakeSocket socket, String type) {
        return socket.textJoined().lines()
                .map(SessionWakeTest::parse)
                .filter(node -> type.equals(node.path("type").asText()))
                .toList();
    }

    private static int frameCount(FakeSocket socket) {
        return (int) socket.textJoined().lines().count();
    }

    /** The workspace frames that name a session, the only ones a wake may send. */
    private static List<JsonNode> wokenFrames(FakeSocket socket) {
        return frames(socket, "workspace_info").stream()
                .filter(node -> !node.path("sessionId").asText("").isEmpty())
                .toList();
    }

    private static void await(FakeSocket socket, String type, int count) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 30_000;
        while (frames(socket, type).size() < count) {
            if (System.currentTimeMillis() > deadline) {
                throw new AssertionError("no " + count + " x " + type + " in: " + socket.textJoined());
            }
            Thread.sleep(20);
        }
    }

    @Test
    void aWakeBindsTheSessionAndAnswersWithItsRecordedFolderAndItsId(@TempDir Path folder) throws Exception {
        String id = stored("20261009-210000-w498bind", folder.toString());
        LiveSessions live = new LiveSessions();
        FakeSocket socket = new FakeSocket("ws-498-bind", "ws://localhost/ws");
        SessionConnection connection = fresh(socket, null, live);
        assertThat(wokenFrames(socket)).as("premise: a fresh socket names no session").isEmpty();

        connection.onWakeSession(id);

        List<JsonNode> woken = wokenFrames(socket);
        assertThat(woken).as("the wake answers with exactly one workspace frame naming the session")
                .hasSize(1);
        JsonNode frame = woken.getFirst();
        assertThat(frame.path("sessionId").asText()).isEqualTo(id);
        assertThat(Path.of(frame.path("path").asText()).toRealPath()).isEqualTo(folder.toRealPath());
        assertThat(frame.path("exists").asBoolean(false)).isTrue();
        assertThat(frame.path("mode").asText()).isEqualTo("recorded");
        assertThat(connection.sessionId()).as("the socket now holds the session").isEqualTo(id);
        assertThat(live.holder(id)).as("the session is claimed like a resume claims it")
                .isEqualTo("ws-498-bind");
        assertThat(SessionWorkspaces.resolvedPath(id))
                .as("Finder, Terminal and the code graph find the folder by the session id")
                .isNotNull();
        assertThat(Path.of(SessionWorkspaces.resolvedPath(id)).toRealPath()).isEqualTo(folder.toRealPath());
        assertThat(frames(socket, "error")).isEmpty();
    }

    @Test
    void theSocketHandlerRoutesTheWakeFrame(@TempDir Path folder) throws Exception {
        String id = stored("20261009-210100-w498rout", folder.toString());
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket socket = new FakeSocket("ws-498-route", "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);

        handler.handleTextMessage(socket, new TextMessage(
                "{\"type\":\"wake_session\",\"sessionId\":\"" + id + "\"}"));

        assertThat(socket.textJoined()).doesNotContain("Unknown message type");
        assertThat(wokenFrames(socket)).extracting(node -> node.path("sessionId").asText())
                .containsExactly(id);
        handler.afterConnectionClosed(socket, org.springframework.web.socket.CloseStatus.NORMAL);
    }

    @Test
    void aWakeCostsNoModelCallAndWritesNothing(@TempDir Path folder) throws Exception {
        String id = stored("20261009-210200-w498free", folder.toString());
        wireBackend(folder);
        Path wire = LlmWireRecorder.fileFor(id);
        Files.deleteIfExists(wire);
        byte[] before = Files.readAllBytes(SessionStore.sessionFile(id));
        FakeSocket socket = new FakeSocket("ws-498-free", "ws://localhost/ws");
        SessionConnection connection = fresh(socket, null, new LiveSessions());

        connection.onWakeSession(id);
        Thread.sleep(1_500); // anything the wake started in the background has had time to speak

        assertThat(wokenFrames(socket)).as("premise: the wake was answered").hasSize(1);
        assertThat(chatBodies).as("the backend received no request at all").isEmpty();
        assertThat(Files.exists(wire) ? Files.readAllLines(wire) : List.<String>of())
                .as("the llm wire of the session gets no new line").isEmpty();
        assertThat(Files.readAllBytes(SessionStore.sessionFile(id)))
                .as("the session file is byte for byte what it was").isEqualTo(before);
        for (String type : List.of("run_start", "usage", "context_info", "llm_request", "llm_exchange",
                "text_delta", "run_end")) {
            assertThat(frames(socket, type)).as("a wake sends no %s", type).isEmpty();
        }

        // The positive half: the backend is wired, so the silence above means
        // something. One message is one request and one exchange on the wire.
        connection.onUserMessage("ZETA a real question", null);
        await(socket, "run_end", 1);
        assertThat(chatBodies).as("the first message is the first request").hasSize(1);
        assertThat(Files.readAllLines(wire).stream()
                .filter(line -> line.contains("\"type\":\"llm_request\"")).count())
                .as("the wire holds that one request").isEqualTo(1);
    }

    @Test
    void aRecordedFolderThatIsGoneIsNamedAndNothingIsCreated(@TempDir Path parent) throws Exception {
        Path gone = parent.resolve("deleted-project");
        String id = stored("20261009-210300-w498gone", gone.toString());
        Path random = WorkspaceResolver.locate(null, id);
        deleteTree(random); // a leftover of an earlier, broken run is not this run's doing
        assertThat(Files.exists(random)).as("premise: no temp folder for this session").isFalse();
        FakeSocket socket = new FakeSocket("ws-498-gone", "ws://localhost/ws");
        SessionConnection connection = fresh(socket, null, new LiveSessions());

        connection.onWakeSession(id);

        JsonNode frame = wokenFrames(socket).getFirst();
        assertThat(frame.path("sessionId").asText()).isEqualTo(id);
        assertThat(frame.path("path").asText()).as("the chip names the folder the record carries")
                .isEqualTo(gone.toString());
        assertThat(frame.path("exists").asBoolean(true)).isFalse();
        assertThat(frame.path("unavailable").asText()).isEqualTo(gone.toString());
        assertThat(frame.path("resolved").asBoolean(true)).as("nothing was resolved").isFalse();
        assertThat(Files.exists(gone)).as("the gone folder is not recreated").isFalse();
        assertThat(Files.exists(random)).as("no fallback folder is minted on a wake").isFalse();
        assertThat(SessionWorkspaces.resolvedPath(id)).as("Finder has nothing to open").isNull();
    }

    @Test
    void theFirstMessageAfterAWakeSendsWhatAResumeSends(@TempDir Path folder) throws Exception {
        String woken = stored("20261009-210400-w498next", folder.toString());
        String resumed = stored("20261009-210401-w498resu", folder.toString());
        wireBackend(folder);

        FakeSocket resumeSocket = new FakeSocket("ws-498-resume", "ws://localhost/ws");
        SessionConnection resume = new SessionConnection(resumeSocket, JSON, config(null), resumed, null,
                new LiveSessions());
        resume.start();
        resume.onUserMessage("ZETA the next question", null);
        await(resumeSocket, "run_end", 1);
        assertThat(chatBodies).as("premise: the resume sent one request: %s", resumeSocket.textJoined())
                .hasSize(1);
        String viaResume = chatBodies.getFirst();

        FakeSocket wakeSocket = new FakeSocket("ws-498-next", "ws://localhost/ws");
        SessionConnection connection = fresh(wakeSocket, null, new LiveSessions());
        connection.onWakeSession(woken);
        connection.onUserMessage("ZETA the next question", null);
        await(wakeSocket, "run_end", 1);

        assertThat(chatBodies).as("the first message after a wake is one request, no title ask").hasSize(2);
        assertThat(chatBodies.get(1)).as("the history rode along").contains("ALPHA first question")
                .contains("OMEGA second question").contains("ZETA the next question");
        assertThat(chatBodies.get(1)).as("byte for byte the request a resume sends").isEqualTo(viaResume);
        assertThat(SessionStore.readSessionEvents(woken).size())
                .as("the run appended to the same file").isGreaterThan(6);
    }

    @Test
    void aSecondWakeChangesNothing(@TempDir Path folder) throws Exception {
        String id = stored("20261009-210500-w498twic", folder.toString());
        FakeSocket socket = new FakeSocket("ws-498-twice", "ws://localhost/ws");
        SessionConnection connection = fresh(socket, null, new LiveSessions());
        connection.onWakeSession(id);
        int after = frameCount(socket);

        connection.onWakeSession(id);

        assertThat(frameCount(socket)).as("the second wake sends nothing").isEqualTo(after);
        assertThat(connection.sessionId()).isEqualTo(id);
    }

    @Test
    void aWakeOfASessionAnotherSocketHoldsIsANoOp(@TempDir Path folder) throws Exception {
        String id = stored("20261009-210600-w498live", folder.toString());
        LiveSessions live = new LiveSessions();
        FakeSocket holderSocket = new FakeSocket("ws-498-holder", "ws://localhost/ws");
        new SessionConnection(holderSocket, JSON, config(null), id, null, live).start();
        FakeSocket socket = new FakeSocket("ws-498-second", "ws://localhost/ws");
        SessionConnection connection = fresh(socket, null, live);

        connection.onWakeSession(id);

        assertThat(live.holder(id)).as("the holder keeps the session").isEqualTo("ws-498-holder");
        assertThat(connection.sessionId()).as("the waking socket binds nothing").isNull();
        assertThat(wokenFrames(socket)).as("no folder is announced for a session this socket does not hold")
                .isEmpty();
        assertThat(frames(socket, "session_busy")).extracting(node -> node.path("sessionId").asText())
                .as("the page is told why, so it can drop its wake").containsExactly(id);
        assertThat(socket.closed.get()).as("the waking socket stays open").isNull();
    }

    @Test
    void aWakeOnASocketThatAlreadyHoldsAnotherSessionIsANoOp(@TempDir Path folder) throws Exception {
        String held = stored("20261009-210700-w498held", folder.toString());
        String other = stored("20261009-210701-w498othr", folder.toString());
        LiveSessions live = new LiveSessions();
        FakeSocket socket = new FakeSocket("ws-498-held", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config(null), held, null, live);
        connection.start();
        int before = frameCount(socket);

        connection.onWakeSession(other);

        assertThat(connection.sessionId()).isEqualTo(held);
        assertThat(live.holder(other)).isNull();
        assertThat(frameCount(socket)).isEqualTo(before);
    }

    @Test
    void aPathShapedOrForeignIdIsNotFoundAndBindsNothing() throws Exception {
        LiveSessions live = new LiveSessions();
        FakeSocket socket = new FakeSocket("ws-498-shape", "ws://localhost/ws");
        SessionConnection connection = fresh(socket, null, live);

        connection.onWakeSession("../../etc/passwd");
        connection.onWakeSession("20261009-000000-notthere");

        assertThat(frames(socket, "error").stream().map(node -> node.path("message").asText()))
                .as("both are answered like the export endpoint's 404, the caller's text never echoed")
                .containsExactly("Session not found.", "Session not found.");
        assertThat(connection.sessionId()).isNull();
        assertThat(live.snapshot()).as("nothing was claimed").isEmpty();
        assertThat(wokenFrames(socket)).isEmpty();
    }
}
