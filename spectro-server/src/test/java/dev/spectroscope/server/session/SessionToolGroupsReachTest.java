package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
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
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 491, after review: when a change to {@code toolGroupsOff} reaches the
 * model request of a browser session, read off the requests a scripted Ollama
 * receives through a real {@link SessionConnection}.
 *
 * <p>The reference chapter files the key under {@code next-run} and says why
 * only half of it is: the composer gear's switch reaches the next run of the
 * open session, while a list written into a settings file is not read again by
 * that session and applies from the next one. This test holds both halves, so
 * the chapter's sentence cannot drift from the code in either direction.</p>
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionToolGroupsReachTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String TAGS =
            "{\"models\":[{\"name\":\"qwen2.5:7b\",\"model\":\"qwen2.5:7b\",\"size\":1}]}";

    private static final String SHOW = "{\"model_info\":{\"general.architecture\":\"qwen2\","
            + "\"qwen2.context_length\":32768},\"capabilities\":[\"completion\",\"tools\"]}";

    private static final String CHAT = """
            {"message":{"content":"ok"},"done":false}
            {"message":{"content":""},"done":true,"prompt_eval_count":12,"eval_count":1}
            """;

    private HttpServer mock;

    /** The tool names of every chat request that advertised tools, in order. */
    private final List<List<String>> toolRequests = new CopyOnWriteArrayList<>();

    @AfterEach
    void stopMock() {
        if (mock != null) {
            mock.stop(0);
        }
    }

    private void route(String path, String contentType, String body) {
        mock.createContext(path, (HttpExchange exchange) -> {
            byte[] request = exchange.getRequestBody().readAllBytes();
            if (path.equals("/api/chat")) {
                JsonNode tools = JSON.readTree(request).path("tools");
                if (tools.isArray() && !tools.isEmpty()) {
                    List<String> names = new ArrayList<>();
                    tools.forEach(tool -> names.add(tool.path("function").path("name").asText()));
                    toolRequests.add(List.copyOf(names));
                }
            }
            byte[] answer = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", contentType);
            exchange.sendResponseHeaders(200, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
    }

    private String startOllama() throws IOException {
        mock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        route("/api/ps", "application/json", "{\"models\":[]}");
        route("/api/tags", "application/json", TAGS);
        route("/api/show", "application/json", SHOW);
        route("/api/chat", "application/x-ndjson", CHAT);
        mock.start();
        return "http://127.0.0.1:" + mock.getAddress().getPort();
    }

    private static SpectroConfig configFor(Path workspace, String baseUrl) throws IOException {
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen2.5:7b", "baseUrl": "%s" }
                """.formatted(baseUrl));
        return SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen2.5:7b", baseUrl, null, null, workspace.toString()));
    }

    private static long runEnds(FakeSocket socket) {
        return socket.textJoined().lines()
                .filter(line -> line.contains("\"type\":\"run_end\""))
                .count();
    }

    /** Sends one prompt and waits for its run to end. */
    private static void prompt(SessionConnection connection, FakeSocket socket, String text)
            throws InterruptedException {
        long before = runEnds(socket);
        connection.onUserMessage(text, null);
        long deadline = System.currentTimeMillis() + 30_000;
        while (runEnds(socket) == before) {
            if (System.currentTimeMillis() > deadline) {
                throw new AssertionError("no run_end for \"" + text + "\" in: "
                        + socket.textJoined());
            }
            Thread.sleep(50);
        }
    }

    private List<String> lastToolRequest() {
        assertThat(toolRequests).as("the scripted Ollama saw a request with tools").isNotEmpty();
        return toolRequests.getLast();
    }

    @Test
    void theGearReachesTheNextRunAndAFileSaveWaitsForTheNextSession(@TempDir Path workspace)
            throws Exception {
        String baseUrl = startOllama();
        SpectroConfig config = configFor(workspace, baseUrl);
        FakeSocket socket = new FakeSocket("ws-491-groups", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config, null);
        connection.start();

        prompt(connection, socket, "first");
        assertThat(lastToolRequest()).as("the premise: every group is on at the start")
                .contains("read_file")
                .anyMatch(name -> name.startsWith("browser_"))
                .anyMatch(name -> name.startsWith("launch_"));

        // A list saved in the folder's own settings file while the session is open.
        Path local = workspace.resolve(SpectroConfig.WS_LOCAL_SETTINGS);
        Files.createDirectories(local.getParent());
        Files.writeString(local, "{ \"toolGroupsOff\": [\"browser\"] }");

        prompt(connection, socket, "second");
        assertThat(lastToolRequest())
                .as("a file save is not read again by the open session, so its next run"
                        + " still sends the browser tools")
                .contains("read_file")
                .anyMatch(name -> name.startsWith("browser_"));

        connection.onSetToolGroupsOff(JSON.valueToTree(List.of("launch")));
        prompt(connection, socket, "third");
        assertThat(lastToolRequest())
                .as("the gear's switch reaches the next run of the open session")
                .contains("read_file")
                .noneMatch(name -> name.startsWith("launch_"))
                .anyMatch(name -> name.startsWith("browser_"));

        int before = toolRequests.size();
        FakeSocket nextSocket = new FakeSocket("ws-491-groups-next", "ws://localhost/ws");
        SessionConnection next = new SessionConnection(nextSocket, JSON, config, null);
        next.start();
        prompt(next, nextSocket, "fresh");
        assertThat(toolRequests.size()).as("the next session sent a request with tools")
                .isGreaterThan(before);
        assertThat(lastToolRequest())
                .as("the next session in the same folder starts with the saved list")
                .contains("read_file")
                .noneMatch(name -> name.startsWith("browser_"))
                .anyMatch(name -> name.startsWith("launch_"));
    }
}
