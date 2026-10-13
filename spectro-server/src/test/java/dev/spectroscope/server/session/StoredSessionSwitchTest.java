package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.socket.CloseStatus;
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
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 556: a stored session continues on the model the owner picks before
 * its first send, also when the backend its record names is down.
 *
 * <p>The page sends {@code set_provider} on the session's own socket: the one
 * its wake holds (card 498), or a resume socket when no wake is there. Both
 * already restored the recorded pair (release 0.14.2, D1). The switch must
 * replace that pair for the next run, the {@code run_start} of that run must
 * name the picked pair, so a later reload continues on it, and the recorded
 * backend must never be asked.</p>
 *
 * <p>Two loopback servers stand in: an ollama for the picked model, which
 * records the model each request named, and a llama.cpp for the recorded one,
 * which counts every request and answers none of them usefully. Nothing
 * leaves the machine.</p>
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class StoredSessionSwitchTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path workspace;

    private HttpServer picked;
    private HttpServer recorded;
    private final List<String> models = new CopyOnWriteArrayList<>();
    private final AtomicInteger recordedHits = new AtomicInteger();
    private final List<String> written = new ArrayList<>();
    private byte[] userBefore;

    @BeforeEach
    void startBackendsAndSetTheUserDefault() throws IOException {
        picked = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        picked.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        picked.createContext("/api/chat", this::answer);
        picked.start();
        recorded = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        recorded.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        recorded.createContext("/", exchange -> {
            recordedHits.incrementAndGet();
            exchange.sendResponseHeaders(503, -1);
            exchange.close();
        });
        recorded.start();
        Path user = SpectroConfig.USER_SETTINGS_PATH;
        userBefore = Files.exists(user) ? Files.readAllBytes(user) : null;
        Files.createDirectories(user.getParent());
        Files.writeString(user, """
                { "provider": "ollama", "model": "model-b", "baseUrl": "%s", "llamacppBaseUrl": "%s" }
                """.formatted(url(picked), url(recorded)));
    }

    @AfterEach
    void restore() throws IOException {
        picked.stop(0);
        recorded.stop(0);
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

    private static String url(HttpServer server) {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private void answer(HttpExchange exchange) throws IOException {
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

    /** A stored session whose one main run went out on the recorded llama.cpp. */
    private String storedOnLlamacpp(String id) throws IOException {
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        String folder = workspace.toString().replace("\\", "\\\\");
        Files.writeString(SessionStore.sessionFile(id), """
                {"type":"run_start","runId":"r1","agentId":"main","prompt":"hi","provider":"llamacpp","model":"old-model","workspace":"%1$s","ts":1}
                {"type":"text_delta","agentId":"main","text":"first answer","ts":2}
                {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":3}
                """.formatted(folder));
        written.add(id);
        return id;
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

    private static List<String> announced(FakeSocket socket) {
        return frames(socket, "provider_info").stream().map(StoredSessionSwitchTest::pair).toList();
    }

    private static void awaitRunEnd(FakeSocket socket) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (frames(socket, "run_end").isEmpty() && System.nanoTime() < deadline) {
            Thread.sleep(20);
        }
        assertThat(socket.textJoined()).as("the continued run ended").contains("\"type\":\"run_end\"");
    }

    /** The provider and model of the last main run_start the session file holds. */
    private static String lastRecordedPair(String id) throws IOException {
        RunEvent.RunStart last = null;
        for (RunEvent event : SessionStore.readSessionEvents(id)) {
            if (event instanceof RunEvent.RunStart start && start.parentId() == null) {
                last = start;
            }
        }
        assertThat(last).as("the session file holds a main run").isNotNull();
        return last.provider() + "/" + last.model();
    }

    /** What every path below must show once the picked pair has run. */
    private void assertTheRunUsedThePick(FakeSocket socket, String id) throws IOException {
        assertThat(models).as("the continuation went out on the picked model").isNotEmpty()
                .containsOnly("model-picked");
        assertThat(frames(socket, "run_start")).as("the new run").hasSize(1);
        assertThat(pair(frames(socket, "run_start").get(0))).as("the new run_start names the pick")
                .isEqualTo("ollama/model-picked");
        assertThat(lastRecordedPair(id)).as("the record carries the pick, so a reload continues on it")
                .isEqualTo("ollama/model-picked");
        assertThat(recordedHits.get()).as("the recorded backend was never asked").isZero();
    }

    @Test
    void aWokenStoredSessionRunsOnThePickNotOnItsRecordedBackend() throws Exception {
        String id = storedOnLlamacpp("20261012-100000-c556wake");
        FakeSocket socket = new FakeSocket("ws-556-wake", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(SpectroConfig.Overrides.none()), null);
        connection.start();
        try {
            connection.onWakeSession(id);
            assertThat(announced(socket)).as("the wake names the recorded pair, the picker's preset")
                    .last().isEqualTo("llamacpp/old-model");

            connection.onSetProvider("ollama", "model-picked");
            assertThat(frames(socket, "error")).as("the switch is taken on the woken socket").isEmpty();
            assertThat(announced(socket)).as("the switch answers with the picked pair")
                    .last().isEqualTo("ollama/model-picked");

            connection.onUserMessage("go on", null);
            awaitRunEnd(socket);
            assertTheRunUsedThePick(socket, id);
        } finally {
            connection.onClose();
        }
    }

    @Test
    void aResumedStoredSessionRunsOnThePickNotOnItsRecordedBackend() throws Exception {
        String id = storedOnLlamacpp("20261012-100000-c556resm");
        FakeSocket socket = new FakeSocket("ws-556-resume", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(SpectroConfig.Overrides.none()), id);
        connection.start();
        try {
            assertThat(announced(socket)).as("the resume names the recorded pair").containsOnly("llamacpp/old-model");

            connection.onSetProvider("ollama", "model-picked");
            assertThat(announced(socket)).last().isEqualTo("ollama/model-picked");

            connection.onUserMessage("go on", null);
            awaitRunEnd(socket);
            assertTheRunUsedThePick(socket, id);
        } finally {
            connection.onClose();
        }
    }

    // Card 556, fix round 1: the page writes the default for new chats only
    // from the server's answer to its pick. The pick carries an ask id; the
    // provider_info that answers it echoes the id as "answers". The frames a
    // record announces on its own (connect, wake) and a refusal echo nothing.

    private static void send(SpectroSocketHandler handler, FakeSocket socket, String json) throws Exception {
        handler.handleTextMessage(socket, new TextMessage(json));
    }

    @Test
    void theAnswerToAPickEchoesItsAskAndNoOtherProviderInfoDoes() throws Exception {
        String id = storedOnLlamacpp("20261012-110000-c556askd");
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket socket = new FakeSocket("ws-556-ask", "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);
        try {
            send(handler, socket, "{\"type\":\"wake_session\",\"sessionId\":\"" + id + "\"}");
            send(handler, socket,
                    "{\"type\":\"set_provider\",\"provider\":\"ollama\",\"model\":\"model-picked\",\"ask\":\"p7\"}");

            List<JsonNode> infos = frames(socket, "provider_info");
            assertThat(infos).as("connect, wake and the answer").hasSizeGreaterThanOrEqualTo(3);
            JsonNode answer = infos.get(infos.size() - 1);
            assertThat(pair(answer)).isEqualTo("ollama/model-picked");
            assertThat(answer.path("answers").asText()).as("the answer names the pick it answers").isEqualTo("p7");
            assertThat(infos.subList(0, infos.size() - 1))
                    .as("connect and wake announce on their own, answering nothing")
                    .allSatisfy(node -> assertThat(node.has("answers")).isFalse());
            assertThat(pair(infos.get(infos.size() - 2))).as("the wake named the recorded pair")
                    .isEqualTo("llamacpp/old-model");
        } finally {
            handler.afterConnectionClosed(socket, CloseStatus.NORMAL);
        }
    }

    @Test
    void aRefusedPickAnswersNothing() throws Exception {
        String id = storedOnLlamacpp("20261012-110000-c556refu");
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket socket = new FakeSocket("ws-556-refused", "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);
        try {
            send(handler, socket, "{\"type\":\"wake_session\",\"sessionId\":\"" + id + "\"}");
            int before = frames(socket, "provider_info").size();
            send(handler, socket, "{\"type\":\"set_provider\",\"provider\":\"bogus\",\"model\":\"x\",\"ask\":\"p8\"}");

            assertThat(frames(socket, "error")).as("positive: the refusal reached the page").hasSize(1);
            assertThat(frames(socket, "provider_info")).as("a refusal announces no pair").hasSize(before);
            assertThat(socket.textJoined()).as("nothing answers the refused pick").doesNotContain("\"answers\"");
        } finally {
            handler.afterConnectionClosed(socket, CloseStatus.NORMAL);
        }
    }

    @Test
    void aSwitchWithoutAnAskAnswersAsBefore() throws Exception {
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket socket = new FakeSocket("ws-556-noask", "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);
        try {
            send(handler, socket, "{\"type\":\"set_provider\",\"provider\":\"ollama\",\"model\":\"model-picked\"}");
            List<JsonNode> infos = frames(socket, "provider_info");
            assertThat(pair(infos.get(infos.size() - 1))).as("positive: the switch was taken")
                    .isEqualTo("ollama/model-picked");
            assertThat(infos).allSatisfy(node -> assertThat(node.has("answers")).isFalse());
        } finally {
            handler.afterConnectionClosed(socket, CloseStatus.NORMAL);
        }
    }
}
