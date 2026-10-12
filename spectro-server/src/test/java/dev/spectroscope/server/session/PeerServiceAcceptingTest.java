package dev.spectroscope.server.session;

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
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static dev.spectroscope.server.session.SessionPeerDeliveryTest.awaitFrames;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 503, criterion 10 at the real {@link PeerService}: with
 * {@code agentMessaging} false in the user settings the process's record says
 * it is not accepting and every inbound message is answered refused; with the
 * key back on, the record says accepting and the message is delivered. The
 * production service reads the user settings file.
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class PeerServiceAcceptingTest {

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

    @Test
    void theKeyInTheUserSettingsDecidesTheRecordAndTheInbox(@TempDir Path workspace) throws Exception {
        Path userSettings = workspace.resolve("home/.spectro/settings.json");
        Files.createDirectories(userSettings.getParent());
        Files.writeString(userSettings, "{ \"agentMessaging\": false }");
        AtomicLong clock = new AtomicLong(1_000_000L);
        MessagingSwitch messaging = new MessagingSwitch(userSettings, clock::get);

        String baseUrl = startAnsweringBackend();
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(baseUrl));
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", baseUrl, null, null, workspace.toString()));
        harness = new PeerHarness(workspace.resolve("home"), "ask", messaging);
        FakeSocket socket = new FakeSocket("ws-503-accepting", "ws://localhost/ws");
        connection = new SessionConnection(socket, JSON, config, null, null, harness.live);
        connection.start();
        connection.onUserMessage("hello", null);
        awaitFrames(socket, f -> "run_end".equals(f.path("type").asText()), 1);

        harness.service.flushForTest();
        assertThat(harness.serverRecord().accepting()).as("key off: the record").isFalse();
        harness.send(connection.sessionId(), "which files did you touch?");
        harness.awaitStatus(PeerStatus.REFUSED);
        assertThat(harness.senderSession.statuses()).doesNotContain(PeerStatus.DELIVERED, PeerStatus.HELD);

        Files.writeString(userSettings, "{ \"agentMessaging\": true }");
        clock.addAndGet(1_001);
        harness.service.flushForTest();
        assertThat(harness.serverRecord().accepting()).as("key on: the record").isTrue();
        harness.send(connection.sessionId(), "which files did you touch now?");
        harness.awaitStatus(PeerStatus.DELIVERED);
        awaitFrames(socket, f -> "run_start".equals(f.path("type").asText()), 2);
    }

    @Test
    void theProductionServiceReadsTheUserSettingsFile() {
        PeerService service = new PeerService(new LiveSessions(), false);
        assertThat(service.messagingSwitch().settings()).isEqualTo(SpectroConfig.USER_SETTINGS_PATH);
    }
}
