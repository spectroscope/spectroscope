package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import dev.spectroscope.core.permission.Allowlist;
import dev.spectroscope.core.permission.GateAudit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 380, criterion 7, at the gate a browser session really has.
 *
 * <p>The core loop has no allowlist and no permission mode of its own: it hands
 * every gated call to the {@code PermissionBroker} it was built with. For the
 * browser session that broker is {@code SessionConnection.parkingBroker()},
 * which reads the live {@code permissionMode} field first and then
 * {@code allowlistNow()} (the session's autoApprove rules plus the rules the
 * operator told it to remember). Those two are what a steering message must
 * leave alone, so they are read here off a {@link SessionConnection} that ran a
 * real loop against a scripted backend, and not off objects a test built.</p>
 *
 * <p>One scenario, three tests. The run's first tool call parks at the gate, the
 * sentence arrives while it waits, the operator denies the call, the loop reads
 * the sentence at the top of turn 2, and the model asks for the same call
 * again, which parks again. Each test first asserts that the sentence was
 * delivered (a {@code steering_message} line with {@code taken} true on the
 * stream), because every negative below is also green on a tree with no
 * steering path. Then each test asserts one of the three facts, so a mutation
 * of one of them turns its own test red.</p>
 *
 * <p>Private state is read by reflection, the way
 * {@code SessionSteeringWiringTest} reaches the {@code running} flag: no
 * accessor is cut into the production class for a test.</p>
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionSteeringAuthorisesNothingTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String SENTENCE = "use the cached list, not the API";

    private static final String COMMAND = "echo steering-380";

    private HttpServer mock;

    @AfterEach
    void stopMock() {
        if (mock != null) {
            mock.stop(0);
        }
    }

    /**
     * A scripted Ollama on loopback. Calls one and two ask for the same
     * {@code run_command}; every later call answers in text and ends the turn.
     *
     * @return the base url to point the provider at
     */
    private String startScriptedBackend() throws IOException {
        AtomicInteger calls = new AtomicInteger();
        mock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        mock.createContext("/api/chat", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (TitleRequests.isTitleRequest(body)) {
                TitleRequests.answer(exchange); // card 445: the title request is not one of the run's calls
                return;
            }
            int call = calls.incrementAndGet();
            String ndjson = call <= 2
                    ? """
                    {"message":{"content":"","tool_calls":[{"function":{"name":"run_command","arguments":{"command":"%s"}}}]},"done":false}
                    {"message":{"content":""},"done":true,"prompt_eval_count":8,"eval_count":4}
                    """.formatted(COMMAND)
                    : """
                    {"message":{"content":"Done."},"done":false}
                    {"message":{"content":""},"done":true,"prompt_eval_count":9,"eval_count":2}
                    """;
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

    /** What the gate's three inputs looked like before and after the sentence. */
    private record Steered(List<JsonNode> frames,
                           String modeBefore, String modeAfter,
                           long modeFramesBefore, long modeFramesAfter,
                           List<String> allowlistBefore, List<String> allowlistAfter,
                           boolean allowlistApprovesTheCallAfter,
                           boolean firstCallStillParkedAfterTheSentence,
                           boolean firstCallAnsweredBeforeTheOperator,
                           List<String> runCommandDecidedBy) {
    }

    private Steered runWithASentenceWhileTheGateWaits(Path workspace) throws Exception {
        String baseUrl = startScriptedBackend();
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(baseUrl));
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", baseUrl, null, null, workspace.toString()));
        FakeSocket socket = new FakeSocket("ws-380-gate", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config, null);
        connection.start();
        Thread operator = null;
        try {
            connection.onUserMessage("list the files", null);

            String firstCall = awaitParked(connection, socket);

            String modeBefore = mode(connection);
            long modeFramesBefore = count(framesOf(socket), "permission_mode_info");
            List<String> allowlistBefore = rawEntries(allowlist(connection));

            connection.onSteeringMessage(SENTENCE);

            CompletableFuture<Boolean> parked = pending(connection).get(firstCall);
            boolean stillParked = parked != null && !parked.isDone();

            operator = denyEveryPrompt(connection, socket);
            List<JsonNode> frames = awaitRunEnd(socket);

            return new Steered(frames,
                    modeBefore, mode(connection),
                    modeFramesBefore, count(frames, "permission_mode_info"),
                    allowlistBefore, rawEntries(allowlist(connection)),
                    allowlist(connection).decide(sameCall()).approved(),
                    stillParked,
                    parked != null && parked.isDone() && !deniedByTheOperator(frames, firstCall),
                    decidedBy(frames, "run_command"));
        } finally {
            if (operator != null) {
                operator.interrupt();
            }
            connection.onClose();
        }
    }

    // ── the delivery every test proves first ─────────────────────────────

    private static void assertDelivered(Steered steered) {
        List<JsonNode> said = steered.frames().stream()
                .filter(frame -> "steering_message".equals(frame.path("type").asText()))
                .toList();
        assertThat(said)
                .as("the sentence is on the stream once")
                .hasSize(1);
        assertThat(said.getFirst().path("text").asText()).isEqualTo(SENTENCE);
        assertThat(said.getFirst().path("taken").asBoolean())
                .as("and the run read it, so the negatives below are about a delivered sentence")
                .isTrue();
    }

    /** The gate's own behaviour after the sentence: the operator decided the
     *  same call again. Read off the session's gate audit, which names who
     *  decided each call ("user", "allowlist", "mode:auto" ...); a
     *  permission_request frame would not do, because the loop emits one for
     *  every gated call whoever decides it. Asserted after each test's own
     *  reading, so a mutation of the mode or of the allowlist turns that
     *  reading red first. */
    private static void assertTheGateAskedAgain(Steered steered) {
        assertThat(steered.runCommandDecidedBy())
                .as("the operator decided both calls to run_command, one before and one after the sentence")
                .containsExactly("user", "user");
    }

    // ── the three facts of criterion 7, one test each ────────────────────

    @Test
    void aSteeringMessageLeavesThePermissionModeAsItWas(@TempDir Path workspace) throws Exception {
        Steered steered = runWithASentenceWhileTheGateWaits(workspace);

        assertDelivered(steered);
        assertThat(steered.modeAfter())
                .as("the mode the gate reads first is the one it read before the sentence")
                .isEqualTo(steered.modeBefore());
        assertThat(steered.modeFramesAfter())
                .as("and the page was told of no mode change")
                .isEqualTo(steered.modeFramesBefore());
        assertTheGateAskedAgain(steered);
    }

    @Test
    void aSteeringMessageAddsNoEntryToTheAllowlistTheGateConsults(@TempDir Path workspace)
            throws Exception {
        Steered steered = runWithASentenceWhileTheGateWaits(workspace);

        assertDelivered(steered);
        assertThat(steered.allowlistAfter())
                .as("the allowlist the gate consults has the entries it had before the sentence")
                .isEqualTo(steered.allowlistBefore());
        assertThat(steered.allowlistApprovesTheCallAfter())
                .as("and it does not approve the call the operator was asked about")
                .isFalse();
        assertTheGateAskedAgain(steered);
    }

    @Test
    void aSteeringMessageDoesNotAnswerThePermissionRequestThatIsWaiting(@TempDir Path workspace)
            throws Exception {
        Steered steered = runWithASentenceWhileTheGateWaits(workspace);

        assertDelivered(steered);
        assertThat(steered.firstCallStillParkedAfterTheSentence())
                .as("the request that was parked when the sentence arrived is still parked after it")
                .isTrue();
        assertThat(steered.firstCallAnsweredBeforeTheOperator())
                .as("and the operator's own answer is the one that closed it")
                .isFalse();
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private static PermissionRequest sameCall() {
        return new PermissionRequest("main", "probe", "run_command",
                JSON.createObjectNode().put("command", COMMAND), 1L);
    }

    private static String mode(SessionConnection connection) throws ReflectiveOperationException {
        Field field = SessionConnection.class.getDeclaredField("permissionMode");
        field.setAccessible(true);
        return (String) field.get(connection);
    }

    private static Allowlist allowlist(SessionConnection connection) throws ReflectiveOperationException {
        Method method = SessionConnection.class.getDeclaredMethod("allowlistNow");
        method.setAccessible(true);
        return (Allowlist) method.invoke(connection);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, CompletableFuture<Boolean>> pending(SessionConnection connection)
            throws ReflectiveOperationException {
        Field field = SessionConnection.class.getDeclaredField("pending");
        field.setAccessible(true);
        return (Map<String, CompletableFuture<Boolean>>) field.get(connection);
    }

    private static List<String> rawEntries(Allowlist allowlist) {
        return allowlist.readings().stream().map(Allowlist.EntryReading::raw).toList();
    }

    /** True when the call's permission_decision says the operator denied it,
     *  which is the only answer this test's operator gives. */
    private static boolean deniedByTheOperator(List<JsonNode> frames, String callId) {
        return frames.stream()
                .filter(frame -> "permission_decision".equals(frame.path("type").asText()))
                .filter(frame -> callId.equals(frame.path("callId").asText()))
                .anyMatch(frame -> !frame.path("allowed").asBoolean(true));
    }

    private static long count(List<JsonNode> frames, String type) {
        return frames.stream().filter(frame -> type.equals(frame.path("type").asText())).count();
    }

    /** Stands in for the operator: denies every prompt once, never remembers.
     *  A call is answered, and marked answered, only once the broker holds a
     *  future for it, the guard {@code awaitParked} applies to the first call.
     *  The loop sends permission_request before it asks the broker, and
     *  {@code onPermissionResponse} drops an answer that finds no future, so an
     *  answer sent on the frame alone could be lost and the run would not end. */
    private static Thread denyEveryPrompt(SessionConnection connection, FakeSocket socket)
            throws ReflectiveOperationException {
        Map<String, CompletableFuture<Boolean>> futures = pending(connection);
        return Thread.ofVirtual().name("card-380-gate").start(() -> {
            List<String> answered = new ArrayList<>();
            while (!Thread.currentThread().isInterrupted()) {
                for (JsonNode frame : framesOf(socket)) {
                    if (!"permission_request".equals(frame.path("type").asText())) {
                        continue;
                    }
                    String callId = frame.path("callId").asText();
                    if (answered.contains(callId) || !futures.containsKey(callId)) {
                        continue;
                    }
                    answered.add(callId);
                    connection.onPermissionResponse(callId, false, false, false);
                }
                try {
                    Thread.sleep(25);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        });
    }

    /** Waits until the first gated call is parked: its permission_request is on
     *  the socket AND the broker holds a future for it. The frame alone is not
     *  a park, the loop sends it before it asks the broker.
     *  @return the parked call's id */
    private static String awaitParked(SessionConnection connection, FakeSocket socket)
            throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45);
        while (System.nanoTime() < deadline) {
            List<JsonNode> asked = framesOf(socket).stream()
                    .filter(frame -> "permission_request".equals(frame.path("type").asText()))
                    .toList();
            if (!asked.isEmpty()) {
                String callId = asked.getFirst().path("callId").asText();
                if (pending(connection).containsKey(callId)) {
                    return callId;
                }
            }
            Thread.sleep(25);
        }
        throw new AssertionError("test premise: run_command parks at the gate in mode ask with no"
                + " allowlist entry; nothing parked. Frames:\n" + socket.textJoined());
    }

    /** Who decided each call to {@code tool}, in call order, off the session's
     *  gate audit sidecar. */
    private static List<String> decidedBy(List<JsonNode> frames, String tool) throws IOException {
        Matcher matcher = Pattern.compile("\"sessionId\":\"([A-Za-z0-9-]+)\"")
                .matcher(frames.stream().map(JsonNode::toString).reduce("", (a, b) -> a + "\n" + b));
        if (!matcher.find()) {
            throw new AssertionError("no sessionId in any frame");
        }
        Path audit = GateAudit.fileFor(matcher.group(1));
        List<String> out = new ArrayList<>();
        for (String line : Files.readAllLines(audit)) {
            JsonNode decision = JSON.readTree(line);
            if (tool.equals(decision.path("tool").asText())) {
                out.add(decision.path("decidedBy").asText());
            }
        }
        return out;
    }

    private static List<JsonNode> awaitRunEnd(FakeSocket socket) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45);
        while (System.nanoTime() < deadline) {
            List<JsonNode> frames = framesOf(socket);
            if (frames.stream().anyMatch(frame -> "run_end".equals(frame.path("type").asText()))) {
                return frames;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("no run_end frame arrived; frames so far:\n" + socket.textJoined());
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
