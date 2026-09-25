package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import dev.spectroscope.core.permission.GateAudit;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 399, criteria 4 and 5, at the gate a browser session really has.
 *
 * <p>{@code SessionConnection.parkingBroker()} answers a gated call on one of
 * four paths: the {@code auto} mode, the {@code readonly} mode, an allowlist
 * rule, or a park that waits for the operator. The first three are known before
 * the {@code permission_request} goes out, and the request now says so in
 * {@code decidedBy}, with the label the gate audit already writes. The park
 * carries no such field.</p>
 *
 * <p>Each scenario runs a real loop against a scripted backend that asks for the
 * same {@code run_command} twice. In {@code ask} mode the operator allows the
 * first call and tells the session to remember it, so the second call is the
 * allowlist path: one run covers the park and the allowlist.</p>
 *
 * <p>Criterion 5 compares the gate audit ledger and the session's event log with
 * a baseline captured from the build before this card (the pre-change tree at
 * {@code ab551ef4}), stored in {@code card-399/gate-baseline.json}. Every run
 * also writes what it saw to {@code build/card-399/observed.json}, which is how
 * that baseline was taken.</p>
 */
@Timeout(value = 240, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionGateStampTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String COMMAND = "echo stamp-399";

    private static final Map<String, List<Gate>> RUNS = new LinkedHashMap<>();

    /** One gated call as three readers recorded it, normalized for comparison. */
    private record Gate(JsonNode socketRequest, JsonNode fileRequest, JsonNode fileDecision, JsonNode ledger) {
    }

    // ── criterion 4: one test per branch of parkingBroker ────────────────

    @Test
    void theAutoShortCircuitStampsModeAuto() throws Exception {
        List<Gate> gates = scenario("auto");
        assertThat(gates).as("the scripted model asks twice").hasSize(2);
        for (Gate gate : gates) {
            assertStamped(gate, "mode:auto");
            assertThat(gate.fileDecision().path("allowed").asBoolean()).isTrue();
        }
    }

    @Test
    void theReadonlyShortCircuitStampsModeReadonly() throws Exception {
        List<Gate> gates = scenario("readonly");
        assertThat(gates).hasSize(2);
        for (Gate gate : gates) {
            assertStamped(gate, "mode:readonly");
            assertThat(gate.fileDecision().path("allowed").asBoolean(true)).isFalse();
        }
    }

    @Test
    void theAllowlistShortCircuitStampsAllowlist() throws Exception {
        List<Gate> gates = scenario("ask");
        assertThat(gates).hasSize(2);
        Gate second = gates.get(1);
        assertThat(second.ledger().path("decidedBy").asText())
                .as("test premise: the remembered rule decided the second call")
                .isEqualTo("allowlist");
        assertStamped(second, "allowlist");
    }

    @Test
    void aRealParkCarriesNoEarlyAnswer() throws Exception {
        List<Gate> gates = scenario("ask");
        assertThat(gates).hasSize(2);
        Gate first = gates.getFirst();
        assertThat(first.ledger().path("decidedBy").asText())
                .as("test premise: the operator decided the first call")
                .isEqualTo("user");
        assertThat(first.socketRequest().has("decidedBy"))
                .as("the browser is told nothing in advance about a call a person decides")
                .isFalse();
        assertThat(first.fileRequest().has("decidedBy")).isFalse();
        assertThat(first.fileDecision().path("allowed").asBoolean()).isTrue();
    }

    @Test
    void aStampedRequestIsAnsweredByItsStampEvenWhenTheModeMovedInBetween() throws Exception {
        // The browser drops a stamped request from its queue. If decide then
        // re-read a mode that was switched to ask a moment later, the call
        // would park behind a window nobody drew. So the stamp decides.
        Path workspace = Files.createTempDirectory("card-399-honour-");
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", "http://127.0.0.1:9", null, null, workspace.toString()));
        SessionConnection connection = new SessionConnection(
                new FakeSocket("ws-399-honour", "ws://localhost/ws"), JSON, config, null);
        Method method = SessionConnection.class.getDeclaredMethod("parkingBroker");
        method.setAccessible(true);
        PermissionBroker broker = (PermissionBroker) method.invoke(connection);
        PermissionRequest bare = new PermissionRequest("main", "honour-1", "run_command",
                JSON.createObjectNode().put("command", COMMAND), 1L);

        connection.onSetPermissionMode("ask");
        assertThat(broker.decidedBy(bare)).as("premise: in ask mode with no rule a person decides").isNull();
        assertThat(decideWithin(broker, bare.stamped("mode:auto")))
                .as("stamped mode:auto while the mode now says ask: allowed, not parked")
                .isTrue();

        connection.onSetPermissionMode("auto");
        assertThat(decideWithin(broker, new PermissionRequest("main", "honour-2", "run_command",
                JSON.createObjectNode().put("command", COMMAND), 2L).stamped("mode:readonly")))
                .as("stamped mode:readonly while the mode now says auto: denied")
                .isFalse();
        assertThat(pending(connection)).as("nothing parked").isEmpty();
    }

    @Test
    void theLedgerNamesTheAllowlistReadingTheStampWasTakenOn() throws Exception {
        // Card 199: the gate audit names the tier and the entry the decision was
        // made on. A stamped allowlist call is decided by the reading taken in
        // decidedBy, so the ledger must carry that reading, even when the rule
        // is gone by the time decide runs.
        Path workspace = Files.createTempDirectory("card-399-carry-");
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", "http://127.0.0.1:9", null, null, workspace.toString()));
        SessionConnection connection = new SessionConnection(
                new FakeSocket("ws-399-carry", "ws://localhost/ws"), JSON, config, null);
        Method method = SessionConnection.class.getDeclaredMethod("parkingBroker");
        method.setAccessible(true);
        PermissionBroker broker = (PermissionBroker) method.invoke(connection);
        PermissionRequest bare = new PermissionRequest("main", "carry-" + java.util.UUID.randomUUID(),
                "run_command", JSON.createObjectNode().put("command", COMMAND), 1L);
        String rule = dev.spectroscope.core.permission.Allowlist.rememberRule(bare.name(), bare.input());
        List<String> remembered = rememberedRules(connection);

        connection.onSetPermissionMode("ask");
        remembered.add(rule);
        String label = broker.decidedBy(bare);
        assertThat(label).as("premise: the remembered rule answers the call").isEqualTo("allowlist");
        remembered.remove(rule);
        assertThat(broker.decidedBy(new PermissionRequest("main", "carry-probe", "run_command",
                JSON.createObjectNode().put("command", COMMAND), 2L)))
                .as("premise: without the rule a fresh reading would park")
                .isNull();

        assertThat(decideWithin(broker, bare.stamped(label))).as("the stamp decides").isTrue();

        JsonNode line = only(linesOf(GateAudit.fileFor("sessionless")), "gate_decision", bare.callId());
        assertThat(line.path("decidedBy").asText()).isEqualTo("allowlist");
        assertThat(line.path("decision").asText()).isEqualTo("allow");
        assertThat(line.path("entry").asText(null))
                .as("the ledger names the rule the stamp was read from, not a second reading")
                .isEqualTo(rule);
        assertThat(pending(connection)).as("nothing parked").isEmpty();
    }

    @SuppressWarnings("unchecked")
    private static List<String> rememberedRules(SessionConnection connection) throws ReflectiveOperationException {
        Field field = SessionConnection.class.getDeclaredField("rememberedRules");
        field.setAccessible(true);
        return (List<String>) field.get(connection);
    }

    /** decide on a virtual thread, so a park fails the test instead of hanging it. */
    private static boolean decideWithin(PermissionBroker broker, PermissionRequest request) throws Exception {
        CompletableFuture<Boolean> answer = new CompletableFuture<>();
        Thread.ofVirtual().name("card-399-decide").start(() -> answer.complete(broker.decide(request)));
        return answer.get(5, TimeUnit.SECONDS);
    }

    // ── criterion 5: nothing the audit had is lost ───────────────────────

    @Test
    void theLedgerAndTheEventLogKeepEverythingTheyHadAndTheRequestGainsOneField() throws Exception {
        ObjectNode observed = JSON.createObjectNode();
        for (String mode : List.of("auto", "readonly", "ask")) {
            ArrayNode gates = observed.putArray(mode);
            for (Gate gate : scenario(mode)) {
                ObjectNode row = gates.addObject();
                row.set("ledger", gate.ledger());
                row.set("request", gate.fileRequest());
                row.set("decision", gate.fileDecision());
            }
        }
        Path out = Path.of("build", "card-399", "observed.json");
        Files.createDirectories(out.getParent());
        Files.writeString(out, JSON.writerWithDefaultPrettyPrinter().writeValueAsString(observed));

        JsonNode baseline;
        try (InputStream in = SessionGateStampTest.class.getResourceAsStream("/card-399/gate-baseline.json")) {
            assertThat(in).as("the pre-card baseline is on the test classpath").isNotNull();
            baseline = JSON.readTree(in);
        }

        int compared = 0;
        for (String mode : List.of("auto", "readonly", "ask")) {
            JsonNode before = baseline.path(mode);
            JsonNode now = observed.path(mode);
            assertThat(now.size()).as(mode + ": gated calls").isEqualTo(before.size());
            for (int i = 0; i < now.size(); i++) {
                String where = mode + " call " + (i + 1);
                assertThat(now.get(i).get("ledger"))
                        .as(where + ": the ledger line, reason string included, is unchanged")
                        .isEqualTo(before.get(i).get("ledger"));
                assertThat(now.get(i).get("decision"))
                        .as(where + ": permission_decision is unchanged")
                        .isEqualTo(before.get(i).get("decision"));
                String reason = now.get(i).get("ledger").path("decidedBy").asText();
                JsonNode request = now.get(i).get("request");
                ObjectNode withoutStamp = request.deepCopy();
                withoutStamp.remove("decidedBy");
                assertThat(withoutStamp)
                        .as(where + ": permission_request lost nothing")
                        .isEqualTo(before.get(i).get("request"));
                List<String> added = new ArrayList<>(fieldNames(request));
                added.removeAll(fieldNames(before.get(i).get("request")));
                assertThat(added)
                        .as(where + " (" + reason + "): the fields permission_request gained")
                        .isEqualTo("user".equals(reason) ? List.of() : List.of("decidedBy"));
                compared++;
            }
        }
        assertThat(compared).as("four paths, two calls per scenario").isEqualTo(6);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private static void assertStamped(Gate gate, String expected) {
        assertThat(gate.ledger().path("decidedBy").asText())
                .as("test premise: the ledger names this path")
                .isEqualTo(expected);
        assertThat(gate.socketRequest().path("decidedBy").asText(null))
                .as("the permission_request frame the browser receives names who decides")
                .isEqualTo(expected);
        assertThat(gate.fileRequest().path("decidedBy").asText(null))
                .as("and so does the line in the session's event log")
                .isEqualTo(expected);
    }

    private static List<String> fieldNames(JsonNode node) {
        List<String> names = new ArrayList<>();
        for (Iterator<String> it = node.fieldNames(); it.hasNext(); ) {
            names.add(it.next());
        }
        return names;
    }

    /** Runs one scenario once per test class and keeps its gates. */
    private static synchronized List<Gate> scenario(String mode) throws Exception {
        List<Gate> cached = RUNS.get(mode);
        if (cached == null) {
            cached = run(mode);
            RUNS.put(mode, cached);
        }
        return cached;
    }

    private static List<Gate> run(String mode) throws Exception {
        AtomicInteger calls = new AtomicInteger();
        HttpServer mock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
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
        String baseUrl = "http://127.0.0.1:" + mock.getAddress().getPort();
        Path workspace = Files.createTempDirectory("card-399-" + mode + "-");
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(baseUrl));
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", baseUrl, null, null, workspace.toString()));
        FakeSocket socket = new FakeSocket("ws-399-" + mode, "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config, null);
        connection.start();
        Thread operator = null;
        try {
            if (!"ask".equals(mode)) {
                connection.onSetPermissionMode(mode);
            }
            connection.onUserMessage("run it twice", null);
            if ("ask".equals(mode)) {
                operator = allowAndRememberEveryPrompt(connection, socket);
            }
            List<JsonNode> frames = awaitRunEnd(socket);
            return gatesOf(frames);
        } finally {
            if (operator != null) {
                operator.interrupt();
            }
            connection.onClose();
            mock.stop(0);
        }
    }

    /** Joins the three readers of each gated call, in the order the socket saw the requests. */
    private static List<Gate> gatesOf(List<JsonNode> frames) throws IOException {
        String sessionId = sessionIdOf(frames);
        List<JsonNode> file = linesOf(SessionStore.sessionFile(sessionId));
        List<JsonNode> ledger = linesOf(GateAudit.fileFor(sessionId));
        List<Gate> gates = new ArrayList<>();
        for (JsonNode request : frames) {
            if (!"permission_request".equals(request.path("type").asText())) {
                continue;
            }
            String callId = request.path("callId").asText();
            gates.add(new Gate(
                    normalized(request),
                    normalized(only(file, "permission_request", callId)),
                    normalized(only(file, "permission_decision", callId)),
                    normalized(only(ledger, "gate_decision", callId))));
        }
        return gates;
    }

    /** The one line of this type for this call; zero or two is a failed premise. */
    private static JsonNode only(List<JsonNode> lines, String type, String callId) {
        List<JsonNode> found = lines.stream()
                .filter(line -> type.equals(line.path("type").asText()))
                .filter(line -> callId.equals(line.path("callId").asText()))
                .toList();
        assertThat(found).as(type + " lines for " + callId).hasSize(1);
        return found.getFirst();
    }

    /** The line with its clock and its minted call id blanked, the only two
     *  values that differ between two runs of the same scenario. */
    private static JsonNode normalized(JsonNode line) {
        ObjectNode copy = line.deepCopy();
        if (copy.has("ts")) {
            copy.put("ts", 0);
        }
        if (copy.has("callId")) {
            copy.put("callId", "<call>");
        }
        return copy;
    }

    /** Every line that parses. A torn line (card 406: the llm-wire writer can
     *  land inside a long context_info line) is skipped; a gate line lost that
     *  way fails {@link #only} with a count of zero rather than passing. */
    private static List<JsonNode> linesOf(Path file) throws IOException {
        List<JsonNode> out = new ArrayList<>();
        for (String line : Files.readAllLines(file)) {
            if (line.isBlank()) {
                continue;
            }
            try {
                out.add(JSON.readTree(line));
            } catch (IOException torn) {
                // card 406, not this card's defect
            }
        }
        return out;
    }

    private static String sessionIdOf(List<JsonNode> frames) {
        Matcher matcher = Pattern.compile("\"sessionId\":\"([A-Za-z0-9-]+)\"")
                .matcher(frames.stream().map(JsonNode::toString).reduce("", (a, b) -> a + "\n" + b));
        if (!matcher.find()) {
            throw new AssertionError("no sessionId in any frame");
        }
        return matcher.group(1);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, CompletableFuture<Boolean>> pending(SessionConnection connection)
            throws ReflectiveOperationException {
        Field field = SessionConnection.class.getDeclaredField("pending");
        field.setAccessible(true);
        return (Map<String, CompletableFuture<Boolean>>) field.get(connection);
    }

    /** Stands in for the operator: allows every prompt once and asks the
     *  session to remember it. An answer goes out only once the broker holds a
     *  future for the call, because an answer that finds no future is dropped. */
    private static Thread allowAndRememberEveryPrompt(SessionConnection connection, FakeSocket socket)
            throws ReflectiveOperationException {
        Map<String, CompletableFuture<Boolean>> futures = pending(connection);
        return Thread.ofVirtual().name("card-399-operator").start(() -> {
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
                    connection.onPermissionResponse(callId, true, true, false);
                }
                try {
                    Thread.sleep(25);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        });
    }

    private static List<JsonNode> awaitRunEnd(FakeSocket socket) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
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
