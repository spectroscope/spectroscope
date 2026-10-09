package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.leveling.Ladder;
import dev.spectroscope.core.leveling.LevelingRecorder;
import dev.spectroscope.core.leveling.LevelingState;
import dev.spectroscope.core.leveling.LevelingStore;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 473: a closed exchange reaches the session file beside the tracing
 * stream, so the ladder has to count every line the FILE gets. A receipt
 * names an event by its line, the client opens the session at that line, and
 * marks are written once, so a receipt that is one line early stays wrong for
 * good. This runs a real first turn against a scripted Ollama on loopback and
 * holds the receipt's index against the file.
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionFreshReceiptTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path workspace;

    @TempDir
    Path home;

    /** Answers the run at once; holds a title request until close, so no
     *  title can land in the file while the run is measured. */
    static final class Backend implements AutoCloseable {
        final HttpServer server;
        final CountDownLatch release = new CountDownLatch(1);

        Backend() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
            server.createContext("/api/chat", this::answer);
            server.start();
        }

        String baseUrl() {
            return "http://127.0.0.1:" + server.getAddress().getPort();
        }

        private void answer(HttpExchange exchange) throws IOException {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (body.contains(JSON.writeValueAsString(SessionTitles.INSTRUCTION))) {
                try {
                    release.await(60, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
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

        @Override
        public void close() {
            release.countDown();
            server.stop(0);
        }
    }

    @Test
    void theFirstRunsReceiptOnAFreshSessionAddressesItsRunEnd() throws Exception {
        try (Backend backend = new Backend()) {
            Files.createDirectories(workspace.resolve(".spectro"));
            Files.writeString(workspace.resolve(".spectro/settings.json"), """
                    { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                    """.formatted(backend.baseUrl()));
            SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                    "ollama", "qwen3", backend.baseUrl(), null, null, workspace.toString()));
            FakeSocket socket = new FakeSocket("ws-473-receipt", "ws://localhost/ws");
            SessionConnection connection = new SessionConnection(socket, JSON, config, null);
            connection.useTitles(new SessionTitles(
                    new SessionMetaStore(home.resolve("session-meta.json")), SessionTitles.TIME_LIMIT));
            LevelingRecorder recorder = new LevelingRecorder(Ladder.bundled(),
                    new LevelingStore(home.resolve("leveling.json")), LevelingState.Mode.LADDER);
            connection.useLeveling(recorder);
            connection.start();
            try {
                connection.onUserMessage("hello", null);
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
                while (recorder.state().marks().get("first-run-complete") == null
                        && System.nanoTime() < deadline) {
                    Thread.sleep(20);
                }
                LevelingState.Mark mark = recorder.state().marks().get("first-run-complete");
                assertThat(mark).as("the first run completed and was marked").isNotNull();

                List<RunEvent> onDisk = SessionStore.readSessionEvents(connection.sessionId());
                assertThat(onDisk.subList(0, mark.eventIndex()))
                        .as("positive control: an llm_exchange line precedes the run_end, "
                                + "so there is a line to be off by")
                        .anyMatch(RunEvent.LlmExchange.class::isInstance);
                assertThat(onDisk.get(mark.eventIndex()))
                        .as("the receipt names the line the client finds at that position")
                        .isInstanceOf(RunEvent.RunEnd.class);
            } finally {
                connection.onClose();
            }
        }
    }
}
