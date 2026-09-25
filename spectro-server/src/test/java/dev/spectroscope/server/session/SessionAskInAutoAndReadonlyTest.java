package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 427, criteria 3 and 4, on a real browser session.
 *
 * <p>The owner, testing 0.13.0 on 2026-09-25: a question has to reach him in
 * auto mode too. Each scenario runs a real loop against a scripted backend
 * whose first call is a gated {@code run_command} and whose second call is
 * {@code ask_user_question}. The session's mode is set the way the composer
 * sets it, and a stand-in for the browser answers the question.</p>
 *
 * <p>Criterion 3: the question reaches the socket, the run stands still until
 * the answer comes, and the model's next request carries that answer.
 * Criterion 4: the gated call before it is still decided by the mode, as card
 * 399 built it: the request is stamped {@code mode:auto} or
 * {@code mode:readonly}, the gate parks nothing, and no question is asked for
 * it.</p>
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionAskInAutoAndReadonlyTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String COMMAND = "echo gated-427";

    private static final String ANSWER = "SQLite";

    @Test
    void inAutoTheQuestionParksAndTheGatedCallIsApprovedWithoutAPark() throws Exception {
        scenario("auto", true);
    }

    @Test
    void inReadonlyTheQuestionParksAndTheGatedCallIsDeniedWithoutAPark() throws Exception {
        scenario("readonly", false);
    }

    private static void scenario(String mode, boolean gatedCallAllowed) throws Exception {
        List<String> bodies = new CopyOnWriteArrayList<>();
        HttpServer mock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        mock.createContext("/api/chat", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (TitleRequests.isTitleRequest(body)) {
                TitleRequests.answer(exchange); // card 445: the title request is not one of the run's calls
                return;
            }
            bodies.add(body);
            String ndjson = switch (bodies.size()) {
                case 1 -> """
                        {"message":{"content":"","tool_calls":[{"function":{"name":"run_command","arguments":{"command":"%s"}}}]},"done":false}
                        {"message":{"content":""},"done":true,"prompt_eval_count":8,"eval_count":4}
                        """.formatted(COMMAND);
                case 2 -> """
                        {"message":{"content":"","tool_calls":[{"function":{"name":"ask_user_question","arguments":{"questions":[{"question":"Which store?","options":[{"label":"Postgres"},{"label":"SQLite"}]}]}}}]},"done":false}
                        {"message":{"content":""},"done":true,"prompt_eval_count":9,"eval_count":4}
                        """;
                default -> """
                        {"message":{"content":"Done."},"done":false}
                        {"message":{"content":""},"done":true,"prompt_eval_count":10,"eval_count":2}
                        """;
            };
            byte[] out = ndjson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            exchange.sendResponseHeaders(200, out.length);
            try (OutputStream stream = exchange.getResponseBody()) {
                stream.write(out);
            }
        });
        mock.start();
        String baseUrl = "http://127.0.0.1:" + mock.getAddress().getPort();
        Path workspace = Files.createTempDirectory("card-427-" + mode + "-");
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(baseUrl));
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", baseUrl, null, null, workspace.toString()));
        FakeSocket socket = new FakeSocket("ws-427-run-" + mode, "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config, null);
        connection.start();
        try {
            connection.onSetPermissionMode(mode);
            connection.onUserMessage("pick a store", null);

            // Criterion 3: the question reaches the socket and parks.
            JsonNode asked = awaitFrame(socket, "question_asked");
            String askId = asked.path("callId").asText();
            awaitPark(connection.asker());

            // Criterion 4: the gated call before it, decided by the mode.
            List<JsonNode> frames = framesOf(socket);
            JsonNode request = only(frames, "permission_request");
            assertThat(request.path("name").asText()).isEqualTo("run_command");
            assertThat(request.path("decidedBy").asText(null))
                    .as("card 399's stamp: the mode decided the gated call before it went out")
                    .isEqualTo("mode:" + mode);
            JsonNode decision = only(frames, "permission_decision");
            assertThat(decision.path("callId").asText()).isEqualTo(request.path("callId").asText());
            assertThat(decision.path("allowed").asBoolean(!gatedCallAllowed))
                    .as("mode %s decides the gated call on its own", mode)
                    .isEqualTo(gatedCallAllowed);
            assertThat(gatePending(connection))
                    .as("the permission gate parked nothing: no dialog was ever owed")
                    .isEmpty();
            assertThat(ofType(frames, "question_asked"))
                    .as("exactly one question, and it is the ask, not the gated call")
                    .hasSize(1);
            assertThat(askId).isNotEqualTo(request.path("callId").asText());

            // The run stands still until the person answers.
            Thread.sleep(300);
            List<JsonNode> waiting = framesOf(socket);
            assertThat(ofType(waiting, "question_answered"))
                    .as("nothing answered the question on the operator's behalf")
                    .isEmpty();
            assertThat(ofType(waiting, "run_end")).as("the run waits for the answer").isEmpty();
            assertThat(bodies).as("the model was not asked again while the question stood").hasSize(2);

            connection.onQuestionResponse(askId, List.of(ANSWER), false);

            List<JsonNode> ended = awaitRunEnd(socket);
            JsonNode answered = only(ended, "question_answered");
            assertThat(answered.path("callId").asText()).isEqualTo(askId);
            assertThat(answered.path("cancelled").asBoolean(true)).isFalse();
            assertThat(answered.path("answers").get(0).asText()).isEqualTo(ANSWER);
            assertThat(bodies).as("the run carried on after the answer").hasSize(3);
            assertThat(lastToolMessage(bodies.get(2)))
                    .as("the model's next request carries the person's answer")
                    .startsWith("The user answered:")
                    .contains("=\"" + ANSWER + "\"");
        } finally {
            connection.onClose();
            mock.stop(0);
        }
    }

    /** The content of the last role "tool" message in one request to the backend. */
    private static String lastToolMessage(String body) throws IOException {
        String content = null;
        for (JsonNode message : JSON.readTree(body).path("messages")) {
            if ("tool".equals(message.path("role").asText())) {
                content = message.path("content").asText();
            }
        }
        assertThat(content).as("the request carries a tool result").isNotNull();
        return content;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, ?> gatePending(SessionConnection connection)
            throws ReflectiveOperationException {
        Field field = SessionConnection.class.getDeclaredField("pending");
        field.setAccessible(true);
        return (Map<String, ?>) field.get(connection);
    }

    private static void awaitPark(ParkingAsker asker) {
        long deadline = System.currentTimeMillis() + 10_000;
        while (asker.pending() == 0 && System.currentTimeMillis() < deadline) {
            Thread.onSpinWait();
        }
        assertThat(asker.pending()).as("the question really is parked").isEqualTo(1);
    }

    private static JsonNode awaitFrame(FakeSocket socket, String type) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            List<JsonNode> found = ofType(framesOf(socket), type);
            if (!found.isEmpty()) {
                return found.getFirst();
            }
            Thread.sleep(25);
        }
        throw new AssertionError("no " + type + " frame arrived; frames so far:\n" + socket.textJoined());
    }

    private static List<JsonNode> awaitRunEnd(FakeSocket socket) throws InterruptedException {
        awaitFrame(socket, "run_end");
        return framesOf(socket);
    }

    private static JsonNode only(List<JsonNode> frames, String type) {
        List<JsonNode> found = ofType(frames, type);
        assertThat(found).as(type + " frames").hasSize(1);
        return found.getFirst();
    }

    private static List<JsonNode> ofType(List<JsonNode> frames, String type) {
        return frames.stream().filter(frame -> type.equals(frame.path("type").asText())).toList();
    }

    /** Every frame this socket received, parsed; frames that are not JSON are skipped. */
    private static List<JsonNode> framesOf(FakeSocket socket) {
        List<JsonNode> out = new ArrayList<>();
        for (String raw : socket.textJoined().split("\n")) {
            try {
                out.add(JSON.readTree(raw));
            } catch (IOException notAnEvent) {
                // a frame this test does not read
            }
        }
        return out;
    }
}
