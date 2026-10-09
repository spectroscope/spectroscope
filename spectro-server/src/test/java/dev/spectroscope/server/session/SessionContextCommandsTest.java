package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
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
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 471: {@code /compact} and {@code /clear} as commands of the web chat,
 * on the face the owner uses.
 *
 * <p>Every guarantee is read off a real {@link SessionConnection} over a
 * scripted Ollama on loopback: the socket handler's two cases, the line on
 * disk, the request the model is sent after a clear, the refusal during a run
 * and the resume that starts after the marker.</p>
 *
 * <p>The review round added the run that is real rather than a flag set by
 * reflection, and the {@code /compact} the page can see and stop: it announces
 * itself with {@code compaction_state}, holds the run flag on the rail, takes
 * the stop button and ends with an outcome the page words itself.</p>
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionContextCommandsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private HttpServer mock;
    /** Every body the scripted backend's chat endpoint received, in order. */
    private final List<String> chatBodies = new CopyOnWriteArrayList<>();
    /** A chat request whose body carries this text waits for {@link #release}. */
    private volatile String holdWhen;
    /** Counts down once a held request has arrived. */
    private final CountDownLatch held = new CountDownLatch(1);
    /** Lets every held request answer. */
    private final CountDownLatch release = new CountDownLatch(1);
    /** The summarizer's request answers HTTP 500. */
    private volatile boolean failSummary;

    @AfterEach
    void stopMock() {
        release.countDown();
        if (mock != null) {
            mock.stop(0);
        }
    }

    /** A scripted Ollama: a summary for the summarizer, a short answer otherwise. */
    private String startBackend() throws IOException {
        mock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        mock.createContext("/api/ps", exchange -> answer(exchange, "application/json", "{\"models\":[]}"));
        mock.createContext("/api/chat", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            chatBodies.add(body);
            boolean summary = body.contains("Summarize the conversation so far");
            if (failSummary && summary) {
                answer(exchange, 500, "application/json", "{\"error\":\"backend down\"}");
                return;
            }
            String waitFor = holdWhen;
            if (waitFor != null && body.contains(waitFor)) {
                held.countDown();
                try {
                    release.await(60, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            String text = summary ? "SUMMARY of the old talk" : "noted";
            answer(exchange, "application/x-ndjson", """
                    {"message":{"content":"%s"},"done":false}
                    {"message":{"content":""},"done":true,"prompt_eval_count":8,"eval_count":2}
                    """.formatted(text));
        });
        mock.start();
        return "http://127.0.0.1:" + mock.getAddress().getPort();
    }

    private static void answer(com.sun.net.httpserver.HttpExchange exchange, String type, String body)
            throws IOException {
        answer(exchange, 200, type, body);
    }

    private static void answer(com.sun.net.httpserver.HttpExchange exchange, int status, String type,
                               String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", type);
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    /** A connection on the scripted backend; resumeId null opens a fresh session. */
    private SessionConnection connect(FakeSocket socket, Path workspace, String resumeId) throws IOException {
        return connect(socket, workspace, resumeId, null);
    }

    private SessionConnection connect(FakeSocket socket, Path workspace, String resumeId, LiveSessions live)
            throws IOException {
        String baseUrl = startBackend();
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(baseUrl));
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides(
                        "ollama", "qwen3", baseUrl, null, null, workspace.toString())),
                resumeId, null, live);
        connection.start();
        return connection;
    }

    private static List<JsonNode> frames(FakeSocket socket, String type) {
        return socket.textJoined().lines()
                .map(SessionContextCommandsTest::parse)
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

    /** The frame types the socket carried, in the order they left. */
    private static List<String> typesInOrder(FakeSocket socket) {
        return socket.textJoined().lines()
                .map(line -> parse(line).path("type").asText())
                .toList();
    }

    private void awaitHeld() throws InterruptedException {
        assertThat(held.await(30, TimeUnit.SECONDS)).as("the held request reached the backend").isTrue();
    }

    private static List<JsonNode> recorded(String sessionId, String type) throws IOException {
        return Files.readAllLines(SessionStore.sessionFile(sessionId)).stream()
                .map(SessionContextCommandsTest::parse)
                .filter(node -> type.equals(node.path("type").asText()))
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

    /** The chat requests that carried this text, the title request excluded. */
    private List<String> requestsCarrying(String text) {
        return chatBodies.stream().filter(body -> body.contains(text)).toList();
    }

    private static String storedSession(String id, String body) throws IOException {
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Files.writeString(SessionStore.sessionFile(id), body);
        return id;
    }

    private static String run(String runId, String prompt, String answer, long ts) {
        return """
                {"type":"run_start","runId":"%1$s","agentId":"main","prompt":"%2$s","ts":%4$d}
                {"type":"text_delta","agentId":"main","text":"%3$s","ts":%5$d}
                {"type":"run_end","runId":"%1$s","stopReason":"end_turn","ts":%6$d}
                """.formatted(runId, prompt, answer, ts, ts + 1, ts + 2);
    }

    @Test
    void theSocketHandlerRoutesEachCommandToItsOwnHandler() {
        SpectroSocketHandler handler = new SpectroSocketHandler(null, null, null, null);
        FakeSocket socket = new FakeSocket("ws-471-route", "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);

        handler.handleTextMessage(socket, new TextMessage("{\"type\":\"clear_context\"}"));

        assertThat(socket.textJoined()).doesNotContain("Unknown message type");
        assertThat(frames(socket, "context_cleared")).as("clear reached the clear handler").hasSize(1);

        handler.handleTextMessage(socket, new TextMessage("{\"type\":\"compact_context\"}"));

        assertThat(socket.textJoined()).doesNotContain("Unknown message type");
        assertThat(frames(socket, "context_cleared"))
                .as("compact did not reach the clear handler").hasSize(1);
        assertThat(frames(socket, "compaction_state").stream().map(node -> node.path("outcome").asText()))
                .as("compact reached the compact handler, which has nothing to summarize yet")
                .containsExactly("nothing_to_compact");
        assertThat(frames(socket, "error")).as("an answer to a command is not an error card").isEmpty();
    }

    @Test
    void aClearKeepsTheSessionAndTheNextPromptStartsWithAnEmptyHistory(@TempDir Path workspace)
            throws Exception {
        FakeSocket socket = new FakeSocket("ws-471-clear", "ws://localhost/ws");
        SessionConnection connection = connect(socket, workspace, null);
        connection.onUserMessage("ALPHA remember the number 7", null);
        await(socket, "run_end", 1);
        String id = connection.sessionId();

        connection.onClearContext();

        await(socket, "context_cleared", 1);
        assertThat(frames(socket, "context_cleared").getFirst().path("removedMessages").asInt())
                .as("the prompt and the answer went").isEqualTo(2);
        assertThat(recorded(id, "context_cleared")).as("the marker is on disk").hasSize(1);

        connection.onUserMessage("BRAVO what is the number", null);
        await(socket, "run_end", 2);

        assertThat(connection.sessionId()).as("same session, same file").isEqualTo(id);
        assertThat(requestsCarrying("BRAVO")).as("premise: the second prompt was sent").isNotEmpty();
        assertThat(requestsCarrying("BRAVO"))
                .as("the request after the clear carries nothing said before it")
                .noneMatch(body -> body.contains("ALPHA"));
        assertThat(recorded(id, "run_start")).as("the record keeps both runs").hasSize(2);
    }

    @Test
    void aCompactSummarizesBetweenRunsAndTheEventIsRecordedAndSent(@TempDir Path workspace)
            throws Exception {
        String id = storedSession("20261009-120000-c471cmp1",
                run("r1", "one", "a1", 1) + run("r2", "two", "a2", 10)
                        + run("r3", "three", "a3", 20) + run("r4", "four", "a4", 30));
        try {
            FakeSocket socket = new FakeSocket("ws-471-compact", "ws://localhost/ws");
            SessionConnection connection = connect(socket, workspace, id);

            connection.onCompactContext();

            await(socket, "compaction", 1);
            assertThat(requestsCarrying("Summarize the conversation so far"))
                    .as("the summarizer was asked once").hasSize(1);
            JsonNode sent = frames(socket, "compaction").getFirst();
            assertThat(sent.path("summaryChars").asInt()).isEqualTo("SUMMARY of the old talk".length());
            List<JsonNode> onDisk = recorded(id, "compaction");
            assertThat(onDisk).as("the event is persisted").hasSize(1);
            assertThat(onDisk.getFirst().path("removedTurns").asInt())
                    .isEqualTo(sent.path("removedTurns").asInt());

            await(socket, "compaction_state", 2);
            List<JsonNode> states = frames(socket, "compaction_state");
            assertThat(states.get(0).path("active").asBoolean()).as("it announces itself").isTrue();
            assertThat(states.get(1).path("active").asBoolean()).isFalse();
            assertThat(states.get(1).path("outcome").asText()).isEqualTo("compacted");
            List<String> order = typesInOrder(socket).stream()
                    .filter(type -> type.equals("compaction_state") || type.equals("compaction"))
                    .toList();
            assertThat(order).as("start, the event, the end")
                    .containsExactly("compaction_state", "compaction", "compaction_state");
            assertThat(recorded(id, "compaction_state")).as("the announcement is socket only").isEmpty();
        } finally {
            Files.deleteIfExists(SessionStore.sessionFile(id));
        }
    }

    @Test
    void duringARunBothCommandsAnswerWithTheWordingOfAUserMessage(@TempDir Path workspace)
            throws Exception {
        FakeSocket socket = new FakeSocket("ws-471-busy", "ws://localhost/ws");
        SessionConnection connection = connect(socket, workspace, null);
        holdWhen = "HOLD-471";

        connection.onUserMessage("HOLD-471 a slow first prompt", null);
        awaitHeld();
        connection.onUserMessage("a second prompt", null);
        connection.onCompactContext();
        connection.onClearContext();

        List<String> refusals = frames(socket, "error").stream()
                .map(node -> node.path("message").asText()).toList();
        assertThat(refusals).hasSize(3);
        assertThat(refusals).as("one wording for all three").containsOnly(SessionConnection.RUN_ACTIVE);
        assertThat(SessionConnection.RUN_ACTIVE).isEqualTo("A run is already active, stop it first.");

        release.countDown();
        await(socket, "run_end", 1);
        assertThat(frames(socket, "context_cleared")).isEmpty();
        assertThat(frames(socket, "compaction")).isEmpty();
        assertThat(frames(socket, "compaction_state")).isEmpty();
        assertThat(requestsCarrying("a second prompt")).as("the refused prompt reached no model").isEmpty();
        assertThat(requestsCarrying("Summarize the conversation so far")).isEmpty();
    }

    @Test
    void aCompactionShowsAsRunningAndTheStopButtonEndsItWithTheHistoryUnchanged(@TempDir Path workspace)
            throws Exception {
        String id = storedSession("20261009-120000-c471stp1",
                run("r1", "ONE", "a1", 1) + run("r2", "TWO", "a2", 10)
                        + run("r3", "THREE", "a3", 20) + run("r4", "FOUR", "a4", 30));
        try {
            LiveSessions live = new LiveSessions();
            FakeSocket socket = new FakeSocket("ws-471-stop", "ws://localhost/ws");
            SessionConnection connection = connect(socket, workspace, id, live);
            holdWhen = "Summarize the conversation so far";

            connection.onCompactContext();
            awaitHeld();

            await(socket, "compaction_state", 1);
            assertThat(frames(socket, "compaction_state").getFirst().path("active").asBoolean()).isTrue();
            assertThat(live.snapshot()).as("the rail shows the session as busy")
                    .anyMatch(session -> session.id().equals(id) && session.running());
            connection.onClearContext();
            assertThat(frames(socket, "error").stream().map(node -> node.path("message").asText()))
                    .as("a command during the compaction meets the run refusal")
                    .containsExactly(SessionConnection.RUN_ACTIVE);

            connection.onAbort();
            release.countDown(); // the backend answers anyway; the stop must still win
            await(socket, "compaction_state", 2);

            JsonNode end = frames(socket, "compaction_state").get(1);
            assertThat(end.path("active").asBoolean()).isFalse();
            assertThat(end.path("outcome").asText()).isEqualTo("stopped");
            assertThat(frames(socket, "compaction")).as("nothing was folded").isEmpty();
            assertThat(recorded(id, "compaction")).isEmpty();
            assertThat(live.snapshot()).as("the rail is quiet again")
                    .noneMatch(session -> session.id().equals(id) && session.running());

            connection.onUserMessage("AFTER the stop", null);
            await(socket, "run_end", 1);
            assertThat(requestsCarrying("AFTER the stop")).as("premise: the prompt was sent").isNotEmpty();
            assertThat(requestsCarrying("AFTER the stop"))
                    .as("the whole history rode along, nothing was folded")
                    .anyMatch(body -> body.contains("ONE") && body.contains("FOUR")
                            && !body.contains("SUMMARY of the old talk"));
        } finally {
            Files.deleteIfExists(SessionStore.sessionFile(id));
        }
    }

    @Test
    void aFailedCompactionEndsWithItsOutcomeAndNoErrorCard(@TempDir Path workspace) throws Exception {
        String id = storedSession("20261009-120000-c471fai1",
                run("r1", "ONE", "a1", 1) + run("r2", "TWO", "a2", 10)
                        + run("r3", "THREE", "a3", 20) + run("r4", "FOUR", "a4", 30));
        try {
            FakeSocket socket = new FakeSocket("ws-471-fail", "ws://localhost/ws");
            SessionConnection connection = connect(socket, workspace, id);
            failSummary = true;

            connection.onCompactContext();
            await(socket, "compaction_state", 2);

            JsonNode end = frames(socket, "compaction_state").get(1);
            assertThat(end.path("outcome").asText()).isEqualTo("failed");
            assertThat(end.path("message").asText()).as("the reason, which the page words around")
                    .isNotBlank().doesNotStartWith("Compaction failed");
            assertThat(frames(socket, "error")).as("no run-error card with a Send again button").isEmpty();
            assertThat(recorded(id, "compaction")).isEmpty();
        } finally {
            Files.deleteIfExists(SessionStore.sessionFile(id));
        }
    }

    @Test
    void aResumedSessionRebuildsItsHistoryOnlyFromAfterTheMarker(@TempDir Path workspace)
            throws Exception {
        String id = storedSession("20261009-120000-c471res1",
                run("r1", "ALPHA said before", "alpha answer", 1)
                        + "{\"type\":\"context_cleared\",\"agentId\":\"main\",\"removedMessages\":2,\"ts\":5}\n");
        try {
            FakeSocket socket = new FakeSocket("ws-471-resume", "ws://localhost/ws");
            SessionConnection connection = connect(socket, workspace, id);

            connection.onUserMessage("CHARLIE after a restart", null);
            await(socket, "run_end", 1);

            assertThat(requestsCarrying("CHARLIE")).as("premise: the prompt was sent").isNotEmpty();
            assertThat(requestsCarrying("CHARLIE")).noneMatch(body -> body.contains("ALPHA"));
        } finally {
            Files.deleteIfExists(SessionStore.sessionFile(id));
        }
    }

    @Test
    void aClearBeforeTheFirstPromptOfAResumeDropsTheLoadedHistory(@TempDir Path workspace)
            throws Exception {
        String id = storedSession("20261009-120000-c471res2", run("r1", "ALPHA said before", "alpha answer", 1));
        try {
            FakeSocket socket = new FakeSocket("ws-471-resume-clear", "ws://localhost/ws");
            SessionConnection connection = connect(socket, workspace, id);

            connection.onClearContext();
            assertThat(recorded(id, "context_cleared")).hasSize(1);
            assertThat(recorded(id, "context_cleared").getFirst().path("removedMessages").asInt())
                    .isEqualTo(2);

            connection.onUserMessage("CHARLIE fresh head", null);
            await(socket, "run_end", 1);

            assertThat(requestsCarrying("CHARLIE")).as("premise: the prompt was sent").isNotEmpty();
            assertThat(requestsCarrying("CHARLIE")).noneMatch(body -> body.contains("ALPHA"));
        } finally {
            Files.deleteIfExists(SessionStore.sessionFile(id));
        }
    }
    // Round three (owner decision 3): what the page is told comes from what
    // happened, never from a stop flag read after the fact. A stop that lands
    // once the history is folded must not report "stopped, history unchanged".

    @Test
    void aFoldedHistoryReportsCompactedEvenWhenTheStopLandedAfterTheFold() {
        RunEvent folded = new RunEvent.Compaction("main", 4, 50, 1);

        assertThat(SessionConnection.compactionOutcome(Optional.of(folded), true)).isEqualTo("compacted");
        assertThat(SessionConnection.compactionOutcome(Optional.of(folded), false)).isEqualTo("compacted");
    }

    @Test
    void anUnfoldedHistoryReportsTheStopOrThatThereWasNothingToFold() {
        assertThat(SessionConnection.compactionOutcome(Optional.empty(), true)).isEqualTo("stopped");
        assertThat(SessionConnection.compactionOutcome(Optional.empty(), false)).isEqualTo("nothing_to_compact");
        assertThat(SessionConnection.compactionOutcome(
                Optional.of(new RunEvent.ErrorEvent("main", "Compaction failed: down", 1)), false))
                .isEqualTo("failed");
    }

    // Round three (verifier minor): the marker a clear writes before the
    // agent exists names the agent the first prompt then builds, so a resume
    // attributes it to the main history and not to some child.
    @Test
    void aClearBeforeTheAgentExistsNamesTheAgentTheFirstPromptBuilds(@TempDir Path workspace)
            throws Exception {
        String id = storedSession("20261009-120000-c471res3", run("r1", "ALPHA said before", "alpha answer", 1));
        try {
            FakeSocket socket = new FakeSocket("ws-471-resume-agent", "ws://localhost/ws");
            SessionConnection connection = connect(socket, workspace, id);

            connection.onClearContext();
            connection.onUserMessage("CHARLIE fresh head", null);
            await(socket, "run_end", 1);
            assertThat(connection.agent()).as("premise: the first prompt built the agent").isNotNull();
            connection.onClearContext();

            List<JsonNode> markers = recorded(id, "context_cleared");
            assertThat(markers).hasSize(2);
            assertThat(markers.get(0).path("agentId").asText())
                    .as("the marker written before the agent existed")
                    .isEqualTo(markers.get(1).path("agentId").asText());
        } finally {
            Files.deleteIfExists(SessionStore.sessionFile(id));
        }
    }
}
