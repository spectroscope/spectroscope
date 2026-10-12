package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.peer.PeerStatus;
import org.junit.jupiter.api.AfterEach;
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
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 502 criterion 6 at the browser session: a message to an idle session of
 * the sender's class starts a run whose prompt is the attribution block; a
 * message of another class is held, shown to the page, and Deliver starts the
 * run. The sender hears each status with its own msg_id.
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionPeerDeliveryTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private HttpServer mock;
    private PeerHarness harness;
    private SessionConnection connection;

    @AfterEach
    void stop() {
        if (connection != null) {
            connection.onClose();
        }
        if (harness != null) {
            harness.close();
        }
        if (mock != null) {
            mock.stop(0);
        }
    }

    private String startAnsweringBackend() throws IOException {
        mock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        mock.createContext("/api/chat", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (TitleRequests.isTitleRequest(body)) {
                TitleRequests.answer(exchange);
                return;
            }
            byte[] answer = """
                    {"message":{"content":"Done."},"done":false}
                    {"message":{"content":""},"done":true,"prompt_eval_count":9,"eval_count":2}
                    """.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            exchange.sendResponseHeaders(200, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        mock.start();
        return "http://127.0.0.1:" + mock.getAddress().getPort();
    }

    private FakeSocket openSession(Path workspace, String senderMode) throws Exception {
        String baseUrl = startAnsweringBackend();
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(baseUrl));
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", baseUrl, null, null, workspace.toString()));
        harness = new PeerHarness(workspace.resolve("home"), senderMode);
        FakeSocket socket = new FakeSocket("ws-502-peer", "ws://localhost/ws");
        connection = new SessionConnection(socket, JSON, config, null, null, harness.live);
        connection.start();
        connection.onUserMessage("hello", null);
        awaitFrames(socket, f -> "run_end".equals(f.path("type").asText()), 1);
        return socket;
    }

    @Test
    void aMessageToAnIdleSessionOfTheSameClassStartsARunWithTheBlockAsItsPrompt(@TempDir Path workspace)
            throws Exception {
        FakeSocket socket = openSession(workspace, "ask");
        String msgId = harness.send(connection.sessionId(), "please check the build");

        List<JsonNode> starts = awaitFrames(socket, f -> "run_start".equals(f.path("type").asText()), 2);
        String prompt = starts.get(1).path("prompt").asText();
        assertThat(prompt).startsWith("Another agent sent a message:\n<agent-message ");
        assertThat(prompt).contains("please check the build").contains("from-mode=\"prompting\"");
        harness.awaitStatus(PeerStatus.DELIVERED);
        assertThat(harness.senderSession.events.stream().filter(e -> "status".equals(e.kind())).findFirst()
                .orElseThrow().msgId()).isEqualTo(msgId);
    }

    @Test
    void aMessageOfAnotherClassIsHeldShownToThePageAndDeliverStartsTheRun(@TempDir Path workspace)
            throws Exception {
        FakeSocket socket = openSession(workspace, "auto");
        String msgId = harness.send(connection.sessionId(), "push the branch");

        harness.awaitStatus(PeerStatus.HELD);
        List<JsonNode> held = awaitFrames(socket, f -> "peer_message".equals(f.path("type").asText())
                && "held".equals(f.path("kind").asText()), 1);
        assertThat(held.getFirst().path("msgId").asText()).isEqualTo(msgId);
        assertThat(held.getFirst().path("text").asText()).isEqualTo("push the branch");
        assertThat(framesOf(socket).stream().filter(f -> "run_start".equals(f.path("type").asText())))
                .as("held: no run yet").hasSize(1);

        connection.onPeerMessageDecision(msgId, true);

        awaitFrames(socket, f -> "run_start".equals(f.path("type").asText()), 2);
        harness.awaitStatus(PeerStatus.DELIVERED);
    }

    @Test
    void declineAnswersDeniedAndStartsNothing(@TempDir Path workspace) throws Exception {
        FakeSocket socket = openSession(workspace, "auto");
        String msgId = harness.send(connection.sessionId(), "push the branch");
        harness.awaitStatus(PeerStatus.HELD);

        connection.onPeerMessageDecision(msgId, false);

        harness.awaitStatus(PeerStatus.DENIED);
        assertThat(framesOf(socket).stream().filter(f -> "run_start".equals(f.path("type").asText())))
                .hasSize(1);
    }

    @Test
    void theServersRecordNamesTheSessionWithItsFolder(@TempDir Path workspace) throws Exception {
        openSession(workspace, "ask");
        harness.service.flushForTest();
        var server = harness.sender.roster().stream().filter(r -> r.pid() == ProcessHandle.current().pid())
                .findFirst().orElseThrow();
        assertThat(server.face()).isEqualTo("server");
        assertThat(server.sessions()).extracting(s -> s.id()).containsExactly(connection.sessionId());
        assertThat(server.sessions().getFirst().cwd()).isEqualTo(workspace.toString());
    }

    static List<JsonNode> awaitFrames(FakeSocket socket, Predicate<JsonNode> which, int count)
            throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45);
        while (System.nanoTime() < deadline) {
            List<JsonNode> found = framesOf(socket).stream().filter(which).toList();
            if (found.size() >= count) {
                return found;
            }
            Thread.sleep(25);
        }
        throw new AssertionError("frames did not arrive; so far:\n" + socket.textJoined());
    }

    static List<JsonNode> framesOf(FakeSocket socket) {
        List<JsonNode> out = new ArrayList<>();
        for (String raw : socket.textJoined().split("\n")) {
            try {
                out.add(JSON.readTree(raw));
            } catch (IOException notAnEvent) {
                // not JSON
            }
        }
        return out;
    }
}
