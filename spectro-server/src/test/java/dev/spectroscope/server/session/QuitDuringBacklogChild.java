package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Card 395: the child JVM {@link QuitDuringBacklogTest} stops with SIGTERM.
 *
 * <p>One session against a scripted Ollama. Each of the first {@link #TURNS}
 * requests answers with {@link #LINES_PER_TURN} thinking lines and
 * {@link #CALLS_PER_TURN} {@code list_dir} calls, all at once. The next request
 * is held open with nothing on it, the way a model that is still thinking holds
 * it. The client costs the field's 17.0 frames per second, so events queue up
 * behind the drainer. When that held request arrives, every event of the first
 * turns is either in the session file or in the queue, and the child prints
 * {@code ready <session id> <requests>}.</p>
 *
 * <p>Spring is not in this JVM. At a real quit Spring also closes the socket and
 * runs {@code onClose}; the flush that card 395 adds must not depend on either,
 * so neither happens here.</p>
 */
public final class QuitDuringBacklogChild {

    /** Turns the model completes before the held request. */
    static final int TURNS = 3;
    /** Thinking lines per completed turn. */
    static final int LINES_PER_TURN = 2_000;
    /** Tool calls per completed turn; each adds a tool_call and a tool_result, which never merge. */
    static final int CALLS_PER_TURN = 30;

    private QuitDuringBacklogChild() {
    }

    /**
     * Runs the session and waits to be stopped.
     *
     * @param args the workspace folder
     */
    public static void main(String[] args) throws Exception {
        Path workspace = Path.of(args[0]);
        AtomicInteger requests = new AtomicInteger();
        CountDownLatch held = new CountDownLatch(1);
        HttpServer backend = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        backend.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        backend.createContext("/api/chat", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (TitleRequests.isTitleRequest(body)) {
                TitleRequests.answer(exchange); // card 445: the title request is not one of the run's turns
                return;
            }
            answer(exchange, requests.incrementAndGet(), held);
        });
        backend.start();
        String baseUrl = "http://127.0.0.1:" + backend.getAddress().getPort();

        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(baseUrl));
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", baseUrl, null, null, workspace.toString()));
        FakeSocket socket = new FakeSocket("ws-395-quit", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, new ObjectMapper(), config, null);
        connection.start();
        connection.onSetThinking(true);
        socket.costPerFrame(StopUnderLoadTest.FIELD_FRAME_COST);
        connection.onUserMessage("look around the workspace", null);

        held.await();
        System.out.println("ready " + connection.sessionId() + " " + requests.get());
        System.out.flush();
        Thread.currentThread().join(); // until SIGTERM
    }

    private static void answer(HttpExchange exchange, int request, CountDownLatch held)
            throws IOException {
        exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
        exchange.sendResponseHeaders(200, 0);
        OutputStream out = exchange.getResponseBody();
        if (request > TURNS) {
            out.flush();
            held.countDown();
            return; // held open: the provider waits on this response until it is cancelled
        }
        try (out) {
            int first = (request - 1) * LINES_PER_TURN;
            for (int i = first; i < first + LINES_PER_TURN; i++) {
                out.write(("{\"message\":{\"role\":\"assistant\",\"content\":\"\",\"thinking\":\""
                        + ThinkingFloodBackend.piece(i) + "\"},\"done\":false}\n")
                        .getBytes(StandardCharsets.UTF_8));
            }
            StringBuilder calls = new StringBuilder();
            for (int c = 0; c < CALLS_PER_TURN; c++) {
                calls.append(c == 0 ? "" : ",")
                        .append("{\"function\":{\"name\":\"list_dir\",\"arguments\":{\"path\":\".\"}}}");
            }
            out.write(("{\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":["
                    + calls + "]},\"done\":false}\n").getBytes(StandardCharsets.UTF_8));
            out.write(("{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,"
                    + "\"done_reason\":\"stop\",\"prompt_eval_count\":9,\"eval_count\":"
                    + LINES_PER_TURN + "}\n").getBytes(StandardCharsets.UTF_8));
        }
    }
}
