package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.session.SessionStore;
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
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 390 on the face the owner uses: the browser session.
 *
 * <p>Every link of the chain the review of 2026-09-24 listed as unpinned (T2 in
 * {@code kanban/evidence/review-2026-09-24/04-review-card-377-override.md}) is
 * read here off a real {@link SessionConnection}, not off an agent a test
 * assembled: the socket handler's case, the answer the page gets at once, the
 * line on disk, the holder a real {@code buildAgentOnce} wires into the agent
 * and into the children, and the restore on resume.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionWindowOverrideTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private HttpServer mock;

    @AfterEach
    void stopMock() {
        if (mock != null) {
            mock.stop(0);
        }
    }

    /**
     * A connection on an ollama backend. The backend rides in the WORKSPACE
     * scope as well as in the flags: the session moment (adoptSessionConfig)
     * re-resolves the hierarchy without the flags, and a user settings file
     * another test class left behind would otherwise decide the provider.
     */
    private static SessionConnection sessionIn(FakeSocket socket, Path workspace, String resumeId) {
        try {
            Files.createDirectories(workspace.resolve(".spectro"));
            Files.writeString(workspace.resolve(".spectro/settings.json"),
                    "{ \"provider\": \"ollama\", \"model\": \"qwen3:latest\" }\n");
        } catch (IOException unwritable) {
            throw new AssertionError(unwritable);
        }
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:latest", null,
                        null, null, workspace.toString())),
                resumeId);
        connection.start();
        return connection;
    }

    /** Every frame of one type the socket carried, parsed, in order. */
    private static List<JsonNode> frames(FakeSocket socket, String type) {
        return socket.textJoined().lines()
                .map(SessionWindowOverrideTest::parse)
                .filter(node -> type.equals(node.path("type").asText()))
                .toList();
    }

    private static JsonNode parse(String line) {
        try {
            return JSON.readTree(line);
        } catch (IOException notJson) {
            return JSON.createObjectNode();
        }
    }

    private static List<JsonNode> recorded(String sessionId, String type) throws IOException {
        return Files.readAllLines(SessionStore.sessionFile(sessionId)).stream()
                .map(SessionWindowOverrideTest::parse)
                .filter(node -> type.equals(node.path("type").asText()))
                .toList();
    }

    @Test
    void theSocketHandlerRoutesTheFrameAndThePageIsAnsweredAtOnce() {
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket socket = new FakeSocket("ws-390-route", "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);

        handler.handleTextMessage(socket,
                new TextMessage("{\"type\":\"set_window_override\",\"tokens\":512000}"));

        assertThat(socket.textJoined()).doesNotContain("Unknown message type");
        List<JsonNode> answers = frames(socket, "window_override");
        assertThat(answers).as("no run started, and the page still hears back").hasSize(1);
        JsonNode answer = answers.getFirst();
        assertThat(answer.path("tokens").asInt()).isEqualTo(512_000);
        assertThat(answer.path("threshold").asInt()).isEqualTo(358_400);
        assertThat(answer.path("thresholdSource").asText()).isEqualTo("window_override");
        assertThat(answer.path("contextWindow").asInt()).isEqualTo(512_000);
    }

    @Test
    void aSetIsWrittenToTheSessionFileAndAClearIsWrittenAfterIt(@TempDir Path workspace)
            throws IOException {
        FakeSocket socket = new FakeSocket("ws-390-record", "ws://localhost/ws");
        SessionConnection connection = sessionIn(socket, workspace, null);

        connection.onSetWindowOverride(JSON.readTree("{\"tokens\":512000}").path("tokens"));
        assertThat(connection.sessionWindow().tokens()).isEqualTo(512_000);
        List<JsonNode> onDisk = recorded(connection.sessionId(), "window_override");
        assertThat(onDisk).hasSize(1);
        assertThat(onDisk.getFirst()).isEqualTo(frames(socket, "window_override").getFirst());

        connection.onSetWindowOverride(JSON.readTree("{\"tokens\":null}").path("tokens"));
        assertThat(connection.sessionWindow().isSet()).isFalse();
        List<JsonNode> answers = frames(socket, "window_override");
        assertThat(answers).hasSize(2);
        JsonNode clear = answers.get(1);
        assertThat(clear.has("tokens")).as("a clear sends no value: " + clear).isFalse();
        assertThat(clear.path("thresholdSource").asText())
                .as("the automatic source decides again: " + clear)
                .isNotEqualTo("window_override")
                .isNotBlank();
        assertThat(clear.path("threshold").asInt()).isPositive();
        assertThat(recorded(connection.sessionId(), "window_override")).hasSize(2);
        assertThat(SessionStore.recordedWindowOverride(connection.sessionId()))
                .as("the last line is the clear, so a resume sets nothing")
                .isNull();
    }

    @Test
    void aRefusedValueChangesNothingWritesNothingAndSaysWhy(@TempDir Path workspace)
            throws IOException {
        FakeSocket socket = new FakeSocket("ws-390-refuse", "ws://localhost/ws");
        SessionConnection connection = sessionIn(socket, workspace, null);
        connection.onSetWindowOverride(JSON.readTree("{\"tokens\":250368}").path("tokens"));

        for (String value : List.of("0", "7999", "10000001", "0.4", "\"512k\"", "4294967296")) {
            connection.onSetWindowOverride(JSON.readTree("{\"tokens\":" + value + "}").path("tokens"));
        }

        assertThat(connection.sessionWindow().tokens())
                .as("every refusal left the window in force")
                .isEqualTo(250_368);
        assertThat(frames(socket, "window_override")).as("only the one real set was answered").hasSize(1);
        assertThat(recorded(connection.sessionId(), "window_override")).hasSize(1);
        List<String> errors = frames(socket, "error").stream()
                .map(node -> node.path("message").asText())
                .toList();
        assertThat(errors).hasSize(6);
        for (String error : errors) {
            assertThat(error).contains("8,000").contains("10,000,000");
        }
        assertThat(errors.get(1)).contains("7999");
        assertThat(errors.get(4)).contains("512k");
    }

    @Test
    void theBuiltAgentReadsTheConnectionsHolderSoALaterSetReachesIt(@TempDir Path workspace) {
        FakeSocket socket = new FakeSocket("ws-390-build", "ws://localhost/ws");
        SessionConnection connection = sessionIn(socket, workspace, null);
        connection.onSetWorkspace("set", workspace.toString());
        connection.buildAgentOnce();

        assertThat(connection.agent().sessionWindow())
                .as("the agent a real build made reads the connection's own holder")
                .isSameAs(connection.sessionWindow());

        connection.onSetWindowOverride(JSON.createObjectNode().numberNode(512_000));
        assertThat(connection.agent().sessionWindow().tokens())
                .as("a set after the build reaches the built agent, no rebuild")
                .isEqualTo(512_000);
    }

    @Test
    void aResumedSessionStartsWithTheWindowItsRecordNames(@TempDir Path workspace) throws IOException {
        String set = "20260924-090000-w390set1";
        String cleared = "20260924-090000-w390clr1";
        String handEdited = "20260924-090000-w390bad1";
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        String run = """
                {"type":"run_start","runId":"r1","agentId":"main","prompt":"go","ts":1}
                {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":2}
                """;
        String setLine = "{\"type\":\"window_override\",\"tokens\":512000,\"threshold\":358400,"
                + "\"thresholdSource\":\"window_override\",\"contextWindow\":512000,\"ts\":3}\n";
        Files.writeString(SessionStore.sessionFile(set), run + setLine);
        Files.writeString(SessionStore.sessionFile(cleared), run + setLine
                + "{\"type\":\"window_override\",\"threshold\":100000,\"thresholdSource\":\"fallback\",\"ts\":4}\n");
        Files.writeString(SessionStore.sessionFile(handEdited), run
                + "{\"type\":\"window_override\",\"tokens\":5,\"threshold\":3,"
                + "\"thresholdSource\":\"window_override\",\"contextWindow\":5,\"ts\":3}\n");
        try {
            SessionConnection resumed = sessionIn(new FakeSocket("ws-390-resume", "ws://localhost/ws"),
                    workspace, set);
            assertThat(resumed.sessionWindow().tokens())
                    .as("restored when the socket opens, before any prompt builds the agent")
                    .isEqualTo(512_000);
            resumed.buildAgentOnce();
            assertThat(resumed.agent().sessionWindow().tokens()).isEqualTo(512_000);

            SessionConnection afterClear = sessionIn(
                    new FakeSocket("ws-390-resume-clear", "ws://localhost/ws"), workspace, cleared);
            assertThat(afterClear.sessionWindow().isSet()).as("the clear was the last word").isFalse();

            SessionConnection edited = sessionIn(
                    new FakeSocket("ws-390-resume-bad", "ws://localhost/ws"), workspace, handEdited);
            assertThat(edited.sessionWindow().isSet())
                    .as("a value outside the range, typed into the file by hand, is not obeyed")
                    .isFalse();
        } finally {
            Files.deleteIfExists(SessionStore.sessionFile(set));
            Files.deleteIfExists(SessionStore.sessionFile(cleared));
            Files.deleteIfExists(SessionStore.sessionFile(handEdited));
        }
    }

    /**
     * A scripted Ollama on loopback that makes the parent spawn one explore
     * child, and counts every {@code /api/ps} request, which is how this
     * provider asks for the loaded window. An empty listing answers 0, which
     * the provider does not keep, so each run that needs the window asks once.
     */
    private String startScriptedBackend(AtomicInteger windowQuestions) throws IOException {
        mock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        mock.createContext("/api/ps", exchange -> {
            windowQuestions.incrementAndGet();
            byte[] answer = "{\"models\":[]}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        mock.createContext("/api/chat", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            String ndjson;
            if (body.contains("You are a research subagent (type explore)")) {
                ndjson = """
                        {"message":{"content":"memo: nothing here."},"done":false}
                        {"message":{"content":""},"done":true,"prompt_eval_count":6,"eval_count":3}
                        """;
            } else if (body.contains("\"role\":\"tool\"")) {
                ndjson = """
                        {"message":{"content":"Delegated and done."},"done":false}
                        {"message":{"content":""},"done":true,"prompt_eval_count":9,"eval_count":2}
                        """;
            } else {
                ndjson = """
                        {"message":{"content":"","tool_calls":[{"function":{"name":"spawn_agent","arguments":{"type":"explore","task":"look around"}}}]},"done":false}
                        {"message":{"content":""},"done":true,"prompt_eval_count":8,"eval_count":4}
                        """;
            }
            byte[] answer = ndjson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            exchange.sendResponseHeaders(200, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        mock.start();
        return "http://127.0.0.1:" + mock.getAddress().getPort();
    }

    /** Runs one delegating prompt through the real door and returns the frames. */
    private String delegate(Path workspace, AtomicInteger windowQuestions, Integer window)
            throws Exception {
        String baseUrl = startScriptedBackend(windowQuestions);
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(baseUrl));
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", baseUrl, null, null, workspace.toString()));
        FakeSocket socket = new FakeSocket("ws-390-children-" + window, "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config, null);
        connection.start();
        if (window != null) {
            connection.onSetWindowOverride(JSON.createObjectNode().numberNode(window));
        }
        connection.onUserMessage("Delegate: start exactly one explore subagent.", null);
        long deadline = System.currentTimeMillis() + 30_000;
        // Two run_end frames: the child's and then the parent's own.
        while (frames(socket, "run_end").size() < 2) {
            if (System.currentTimeMillis() > deadline) {
                throw new AssertionError("no run_end in: " + socket.textJoined());
            }
            Thread.sleep(50);
        }
        return socket.textJoined();
    }

    @Test
    void withNoWindowSetTheParentAndTheChildEachAskTheBackend(@TempDir Path workspace)
            throws Exception {
        // The baseline, so the zero below cannot be zero for the wrong reason.
        AtomicInteger windowQuestions = new AtomicInteger();

        String frames = delegate(workspace, windowQuestions, null);

        assertThat(frames).as("test premise: a child ran").contains("agent_spawn");
        assertThat(windowQuestions.get()).as("one question per run, parent and child").isEqualTo(2);
    }

    @Test
    void aWindowSetBeforeThePromptReachesTheRingTheParentAndTheChild(@TempDir Path workspace)
            throws Exception {
        AtomicInteger windowQuestions = new AtomicInteger();

        String frames = delegate(workspace, windowQuestions, 512_000);

        assertThat(frames).as("test premise: a child ran").contains("agent_spawn");
        JsonNode info = frames.lines()
                .map(SessionWindowOverrideTest::parse)
                .filter(node -> "context_info".equals(node.path("type").asText()))
                .findFirst()
                .orElseThrow();
        assertThat(info.path("thresholdSource").asText()).isEqualTo("window_override");
        assertThat(info.path("contextWindow").asInt()).isEqualTo(512_000);
        assertThat(info.path("threshold").asInt()).isEqualTo(358_400);
        assertThat(windowQuestions.get())
                .as("neither the parent nor the child asked; a child without the holder asks once")
                .isZero();
    }
}
