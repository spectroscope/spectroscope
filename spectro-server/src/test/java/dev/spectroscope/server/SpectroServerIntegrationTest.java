package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Full-stack proof without any API key: the Spring server boots on a random
 * port, the config points the Ollama provider at a scripted local NDJSON
 * server, and a real WebSocket client sends a user_message and receives the
 * canonical event sequence. REST endpoints are checked over HTTP.
 *
 * <p>The Gradle test task redirects {@code user.home} into the build dir, so
 * the config/session files written here never touch the real home.</p>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "server.address=127.0.0.1")
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class SpectroServerIntegrationTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static HttpServer ollamaMock;

    /** The user_message text that makes the scripted mock emit a run_command
     *  tool call instead of its default plain-text answer (Task 10's persist
     *  test needs a real permission_request to answer). */
    private static final String RUN_COMMAND_TRIGGER_TEXT = "Run the approved shell command.";

    /** Every /api/chat request body's "model" field, in arrival order — Task 15's
     *  proof that a session's provider call actually carried its workspace-scoped
     *  model (recording is orthogonal to the scripted-answer branching below, so
     *  it runs first, unconditionally, on every request). */
    private static final List<String> requestedModels = new CopyOnWriteArrayList<>();

    /** The raw /api/chat request bodies, parallel to {@link #requestedModels} —
     *  the thinking reseed proof reads the ws-model request and checks its
     *  "think" field (present iff the harness requested reasoning). */
    private static final List<String> requestedBodies = new CopyOnWriteArrayList<>();

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @BeforeAll
    static void scriptedOllamaAndConfig() throws IOException {
        ollamaMock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        ollamaMock.createContext("/api/chat", exchange -> {
            // The request body decides the scripted answer: a role:"tool" message
            // means a tool result rode back (answer plainly, no more calls); the
            // persist test's trigger text means "call run_command"; everything
            // else keeps the original plain-text reply every other test expects.
            String requestBody =
                    new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            requestedBodies.add(requestBody);
            try {
                requestedModels.add(JSON.readTree(requestBody).path("model").asText());
            } catch (IOException malformed) {
                // best effort — the scripted branch below still answers by substring match
            }
            String ndjson;
            if (requestBody.contains("\"role\":\"tool\"")) {
                ndjson = """
                        {"message":{"content":"Ran it."},"done":false}
                        {"message":{"content":""},"done":true,"prompt_eval_count":9,"eval_count":2}
                        """;
            } else if (requestBody.contains(RUN_COMMAND_TRIGGER_TEXT)) {
                ndjson = """
                        {"message":{"content":"","tool_calls":[{"function":{"name":"run_command","arguments":{"command":"echo hi"}}}]},"done":false}
                        {"message":{"content":""},"done":true,"prompt_eval_count":8,"eval_count":4}
                        """;
            } else {
                ndjson = """
                        {"message":{"content":"Hello from the mock."},"done":false}
                        {"message":{"content":""},"done":true,"prompt_eval_count":7,"eval_count":3}
                        """;
            }
            byte[] body = ndjson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        // the vision capability probe — the mock model can see, so an
        // attached image passes the OllamaProvider's fail-fast check.
        ollamaMock.createContext("/api/show", exchange -> {
            byte[] body = "{\"capabilities\":[\"completion\",\"vision\"]}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        ollamaMock.start();

        // The server reads ~/.spectro/config.json (user.home is redirected by Gradle):
        // point the provider at the mock — no key, no network.
        Path configPath = Path.of(System.getProperty("user.home"), ".spectro", "config.json");
        Files.createDirectories(configPath.getParent());
        Files.writeString(configPath, """
                { "provider": "ollama", "model": "qwen3",
                  "baseUrl": "http://127.0.0.1:%d" }
                """.formatted(ollamaMock.getAddress().getPort()));
    }

    @AfterAll
    static void stopMock() {
        ollamaMock.stop(0);
    }

    @Test
    void healthAnswersOk() {
        ResponseEntity<String> response = rest.getForEntity("/api/health", String.class);
        assertEquals(200, response.getStatusCode().value());
        assertTrue(response.getBody() != null && response.getBody().contains("\"status\":\"ok\""));
    }

    @Test
    void sessionsListIsAJsonArray() {
        ResponseEntity<String> response = rest.getForEntity("/api/sessions", String.class);
        assertEquals(200, response.getStatusCode().value());
        assertTrue(response.getBody() != null && response.getBody().startsWith("["));
    }

    @Test
    void unknownSessionEventsAre404() {
        ResponseEntity<String> response = rest.getForEntity("/api/sessions/nope/events", String.class);
        assertEquals(404, response.getStatusCode().value());
    }

    @Test
    void jobsStateAnswersAnObjectEvenWithoutAStateFile() {
        ResponseEntity<String> response = rest.getForEntity("/api/jobs/state", String.class);
        assertEquals(200, response.getStatusCode().value());
        assertTrue(response.getBody() != null && response.getBody().startsWith("{"),
                "the poller expects a JSON object keyed by job id");
    }

    @Test
    void imagesEndpointServesOnlyContentAddressedNames() throws IOException {
        // user.home is redirected into the build dir, so this touches no real data.
        String sha = "a".repeat(64);
        Path imagesDir = Path.of(System.getProperty("user.home"), ".spectro", "images");
        Files.createDirectories(imagesDir);
        Files.write(imagesDir.resolve(sha + ".png"), new byte[] {(byte) 0x89, 'P', 'N', 'G'});

        ResponseEntity<byte[]> ok = rest.getForEntity("/api/images/" + sha + ".png", byte[].class);
        assertEquals(200, ok.getStatusCode().value());
        assertEquals("image/png", String.valueOf(ok.getHeaders().getContentType()));
        assertEquals(4, ok.getBody() != null ? ok.getBody().length : 0);

        assertEquals(404, rest.getForEntity(
                "/api/images/" + "b".repeat(64) + ".png", byte[].class).getStatusCode().value(),
                "an unknown sha is a plain 404");
        assertEquals(400, rest.getForEntity(
                "/api/images/..%2Fconfig.json", byte[].class).getStatusCode().value(),
                "anything but 64-hex + image extension is rejected before touching the disk");
    }

    @Test
    void aUserMessageStreamsTheCanonicalEventSequence() throws Exception {
        List<JsonNode> events = new ArrayList<>();
        CountDownLatch runEnded = new CountDownLatch(1);

        WebSocket.Listener listener = new WebSocket.Listener() {
            private final StringBuilder frame = new StringBuilder();

            @Override
            public CompletionStage<?> onText(WebSocket socket, CharSequence data, boolean last) {
                frame.append(data);
                if (last) {
                    try {
                        JsonNode event = JSON.readTree(frame.toString());
                        events.add(event);
                        if ("run_end".equals(event.path("type").asText())) {
                            runEnded.countDown();
                        }
                    } catch (IOException ignored) {
                        // not JSON — ignore
                    }
                    frame.setLength(0);
                }
                socket.request(1);
                return null;
            }
        };

        try (HttpClient client = HttpClient.newHttpClient()) {
            WebSocket socket = client.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws"), listener)
                    .join();
            socket.sendText("""
                    {"type":"user_message","text":"Say hello."}""", true);

            assertTrue(runEnded.await(20, TimeUnit.SECONDS), "run_end must arrive");
            socket.sendClose(WebSocket.NORMAL_CLOSURE, "done").join();
        }

        List<String> types = events.stream().map(e -> e.path("type").asText()).toList();
        // The socket-only frames precede the first run (none of them is ever
        // stored in the JSONL): provider_info + permission_mode_info on
        // connect, the SAME pair again from buildAgentOnce's session-moment
        // reseed (fix 1 — idempotent here since nothing actually changed),
        // then workspace_info on first run.
        assertEquals("provider_info", types.getFirst(),
                "the active backend is announced on connect, got " + types);
        JsonNode providerInfo = events.getFirst();
        assertEquals("ollama", providerInfo.path("provider").asText());
        assertEquals("qwen3", providerInfo.path("model").asText());
        assertEquals("127.0.0.1:" + ollamaMock.getAddress().getPort(),
                providerInfo.path("host").asText(),
                "the frame names the real network counterpart");
        assertEquals("permission_mode_info", types.get(1),
                "the permission mode is announced on connect too, got " + types);
        assertEquals("provider_info", types.get(2),
                "the session-moment reseed re-announces provider_info too, got " + types);
        assertEquals("permission_mode_info", types.get(3),
                "...and permission_mode_info right after it, got " + types);
        assertEquals("workspace_info", types.get(4),
                "the workspace announcement precedes the run, got " + types);
        JsonNode workspaceInfo = events.get(4);
        assertFalse(workspaceInfo.path("sessionId").asText().isBlank());
        assertTrue(workspaceInfo.path("path").asText()
                        .endsWith(workspaceInfo.path("sessionId").asText()),
                "the auto workspace is keyed by the session id");
        assertEquals("run_start", types.get(5), "sequence starts with run_start, got " + types);
        assertTrue(types.contains("text_delta"), "text must stream, got " + types);
        assertTrue(types.contains("usage"), "usage must arrive, got " + types);
        assertEquals("run_end", types.getLast());

        // The streamed text is the mock's answer — end to end through core+server.
        String text = events.stream()
                .filter(e -> "text_delta".equals(e.path("type").asText()))
                .map(e -> e.path("text").asText())
                .reduce("", String::concat);
        assertEquals("Hello from the mock.", text);

        // And the same run landed in the JSONL store (one write per event).
        var sessions = dev.spectroscope.core.session.SessionStore.listSessions();
        assertTrue(!sessions.isEmpty(), "the run must have persisted a session");
    }

    @Test
    void abortWithoutARunIsHarmless() throws Exception {
        CountDownLatch closed = new CountDownLatch(1);
        try (HttpClient client = HttpClient.newHttpClient()) {
            WebSocket socket = client.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws"),
                            new WebSocket.Listener() { })
                    .join();
            socket.sendText("""
                    {"type":"abort"}""", true);
            socket.sendClose(WebSocket.NORMAL_CLOSURE, "done")
                    .thenRun(closed::countDown);
            assertTrue(closed.await(5, TimeUnit.SECONDS));
        }
    }

    // ---- attachments ---------------------------------------------

    /** Collects every JSON frame and opens the latch on the given event type. */
    private static WebSocket.Listener collectInto(List<JsonNode> events, String awaitType,
                                                  CountDownLatch latch) {
        return new WebSocket.Listener() {
            private final StringBuilder frame = new StringBuilder();

            @Override
            public CompletionStage<?> onText(WebSocket socket, CharSequence data, boolean last) {
                frame.append(data);
                if (last) {
                    try {
                        JsonNode event = JSON.readTree(frame.toString());
                        events.add(event);
                        if (awaitType.equals(event.path("type").asText())) {
                            latch.countDown();
                        }
                    } catch (IOException ignored) {
                        // not JSON — ignore
                    }
                    frame.setLength(0);
                }
                socket.request(1);
                return null;
            }
        };
    }

    @Test
    void anAttachedImageBecomesABlobAndTheRunStartCarriesReferencesOnly() throws Exception {
        byte[] imageBytes = {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10}; // PNG signature
        String expectedSha256 = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(imageBytes));

        List<JsonNode> events = new ArrayList<>();
        CountDownLatch runEnded = new CountDownLatch(1);
        try (HttpClient client = HttpClient.newHttpClient()) {
            WebSocket socket = client.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws"),
                            collectInto(events, "run_end", runEnded))
                    .join();
            socket.sendText("""
                    {"type":"user_message","text":"What is in this image?",
                     "attachments":[{"mediaType":"image/png","dataBase64":"%s"}]}"""
                    .formatted(Base64.getEncoder().encodeToString(imageBytes)), true);
            assertTrue(runEnded.await(20, TimeUnit.SECONDS), "run_end must arrive");
            socket.sendClose(WebSocket.NORMAL_CLOSURE, "done").join();
        }

        JsonNode runStart = events.stream()
                .filter(e -> "run_start".equals(e.path("type").asText()))
                .findFirst().orElseThrow();
        JsonNode attachment = runStart.path("attachments").get(0);
        assertEquals("image", attachment.path("kind").asText());
        assertEquals("image/png", attachment.path("mediaType").asText());
        assertEquals(expectedSha256, attachment.path("sha256").asText(),
                "the reference must carry the content hash of the uploaded bytes");
        assertTrue(!runStart.toString().contains("dataBase64"),
                "events reference the blob — the bytes never enter the stream");

        // The blob sits NEXT TO the session file, named by its hash, deduplicated.
        Path blobFile = Path.of(attachment.path("blobPath").asText());
        assertTrue(Files.exists(blobFile), "blob file must exist: " + blobFile);
        assertEquals(expectedSha256, blobFile.getFileName().toString());
        assertTrue(java.util.Arrays.equals(imageBytes, Files.readAllBytes(blobFile)),
                "the blob holds exactly the uploaded bytes");

        // And the persisted run_start line carries the same reference (JSONL §7).
        String sessionId = blobFile.getParent().getParent().getFileName().toString();
        List<dev.spectroscope.core.events.RunEvent> stored =
                dev.spectroscope.core.session.SessionStore.readSessionEvents(sessionId);
        var storedStart = (dev.spectroscope.core.events.RunEvent.RunStart) stored.getFirst();
        assertEquals(expectedSha256, storedStart.attachments().getFirst().sha256());
    }

    @Test
    void anOversizedAttachmentIsRejectedAndNoRunStarts() throws Exception {
        // 5 MB + 1 byte of zeros claiming image/png — just past the wire cap.
        // file_upload: oversized REAL images now downscale server-side, so the
        // reject contract narrows to payloads that CANNOT be fitted (undecodable
        // junk, non-images): readable error event, NO run, connection usable.
        String oversized = Base64.getEncoder().encodeToString(new byte[5 * 1024 * 1024 + 1]);

        List<JsonNode> events = new ArrayList<>();
        CountDownLatch runEnded = new CountDownLatch(1);
        try (HttpClient client = HttpClient.newHttpClient()) {
            WebSocket socket = client.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws"),
                            collectInto(events, "run_end", runEnded))
                    .join();
            // The listener latches on run_end; watch for the error frame by polling
            // the collected list (the error must arrive without any run events).
            socket.sendText("""
                    {"type":"user_message","text":"too big",
                     "attachments":[{"mediaType":"image/png","dataBase64":"%s"}]}"""
                    .formatted(oversized), true);
            // provider_info + permission_mode_info arrive on connect regardless — wait for the ERROR.
            for (int i = 0; i < 100 && events.stream()
                    .noneMatch(e -> "error".equals(e.path("type").asText())); i++) {
                Thread.sleep(100);
            }
            JsonNode rejection = events.stream()
                    .filter(e -> "error".equals(e.path("type").asText()))
                    .findFirst().orElseThrow(() ->
                            new AssertionError("the rejection must answer with an error event"));
            assertTrue(rejection.path("message").asText().contains("Attachment")
                            && rejection.path("message").asText().contains("decode"),
                    "the un-fittable payload names the decode failure, got: "
                            + rejection.path("message").asText());

            // The same socket still works — proof the rejected upload started nothing.
            socket.sendText("""
                    {"type":"user_message","text":"Say hello."}""", true);
            assertTrue(runEnded.await(20, TimeUnit.SECONDS),
                    "a valid message after the rejection must still run");
            socket.sendClose(WebSocket.NORMAL_CLOSURE, "done").join();
        }

        List<String> types = events.stream().map(e -> e.path("type").asText()).toList();
        assertEquals("provider_info", types.getFirst(), "connect announces the backend first");
        assertEquals("permission_mode_info", types.get(1), "connect also announces the permission mode");
        assertEquals("error", types.get(2));
        // The rejected upload never reaches buildAgentOnce (no agent yet); the
        // valid message then builds it for the first time — the session-moment
        // reseed re-announces provider_info + permission_mode_info (fix 1,
        // idempotent here) — before announcing the workspace (socket-only) and running.
        assertEquals("provider_info", types.get(3),
                "the reseed re-announces provider_info too, got " + types);
        assertEquals("permission_mode_info", types.get(4),
                "...and permission_mode_info right after it, got " + types);
        assertEquals("workspace_info", types.get(5));
        assertEquals("run_start", types.get(6),
                "the ONLY run events come from the second, valid message: " + types);
    }

    @Test
    void aPickedWorkspacePinsTheSessionBeforeTheFirstRunAndIsFixedAfterIt() throws Exception {
        Path picked = Files.createTempDirectory("spectroscope-picked-ws");
        List<JsonNode> events = new ArrayList<>();
        CountDownLatch runEnded = new CountDownLatch(1);
        try (HttpClient client = HttpClient.newHttpClient()) {
            WebSocket socket = client.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws"),
                            collectInto(events, "run_end", runEnded))
                    .join();
            socket.sendText("""
                    {"type":"set_workspace","path":"%s"}""".formatted(picked), true);
            for (int i = 0; i < 100 && events.stream()
                    .noneMatch(e -> "workspace_info".equals(e.path("type").asText())); i++) {
                Thread.sleep(100);
            }
            JsonNode info = events.stream()
                    .filter(e -> "workspace_info".equals(e.path("type").asText()))
                    .findFirst().orElseThrow(() ->
                            new AssertionError("set_workspace must answer with workspace_info"));
            assertEquals(picked.toAbsolutePath().normalize().toString(), info.path("path").asText(),
                    "the announced workspace is the picked folder");
            assertTrue(info.path("configured").asBoolean(), "a picked folder counts as configured");

            // The Files tab and the sandbox agree: the REST tree roots at the
            // pin (shared per-session state), not at the config/auto rules.
            String sessionId = info.path("sessionId").asText();
            ResponseEntity<String> files =
                    rest.getForEntity("/api/files?session=" + sessionId, String.class);
            assertEquals(200, files.getStatusCode().value(),
                    "the picked workspace must be browsable by session id");
            assertTrue(files.getBody() != null
                            && files.getBody().contains("\"root\":\"" + picked.getFileName() + "\""),
                    "the tree roots at the picked folder, got: " + files.getBody());

            // The run then works inside the picked folder — and afterwards the
            // workspace is fixed: a second pick is refused readably.
            socket.sendText("""
                    {"type":"user_message","text":"Say hello."}""", true);
            assertTrue(runEnded.await(20, TimeUnit.SECONDS), "run_end must arrive");
            socket.sendText("""
                    {"type":"set_workspace","path":"%s"}""".formatted(picked), true);
            for (int i = 0; i < 100 && events.stream()
                    .noneMatch(e -> e.path("message").asText("").contains("fixed once")); i++) {
                Thread.sleep(100);
            }
            socket.sendClose(WebSocket.NORMAL_CLOSURE, "done").join();
        }

        assertTrue(events.stream().anyMatch(e -> "error".equals(e.path("type").asText())
                        && e.path("message").asText().contains("fixed once the agent has run")),
                "a late set_workspace answers a readable refusal");
        // Exactly ONE workspace_info: the pick announced it, the run reused it.
        assertEquals(1, events.stream()
                .filter(e -> "workspace_info".equals(e.path("type").asText())).count());
    }

    @Test
    void theAgentBuildsFromTheWorkspaceScopedConfig() throws Exception {
        // Task 15: the session moment — once the workspace resolves, its own
        // .spectro/settings.json joins the config chain and the agent is built
        // from THAT (session-scoped) config, not the connect-time snapshot.
        // "thinking": false pins the reseed of the connect-time thinking seed:
        // the boot default is true, so the wire request would carry think:true
        // unless the workspace scope really reached the agent build.
        Path ws = Files.createTempDirectory("spectroscope-ws-scoped");
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), """
                { "model": "ws-model", "thinking": false }
                """);

        List<JsonNode> events = new ArrayList<>();
        CountDownLatch runEnded = new CountDownLatch(1);
        try (HttpClient client = HttpClient.newHttpClient()) {
            WebSocket socket = client.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws"),
                            collectInto(events, "run_end", runEnded))
                    .join();

            // Pin the session to the workspace BEFORE the agent is built.
            socket.sendText("""
                    {"type":"set_workspace","path":"%s"}""".formatted(ws), true);
            for (int i = 0; i < 100 && events.stream()
                    .noneMatch(e -> "workspace_info".equals(e.path("type").asText())); i++) {
                Thread.sleep(100);
            }
            assertTrue(events.stream().anyMatch(e -> "workspace_info".equals(e.path("type").asText())),
                    "set_workspace must answer with workspace_info before the run starts");

            // The first prompt builds the agent — the session moment.
            socket.sendText("""
                    {"type":"user_message","text":"Say hello."}""", true);
            assertTrue(runEnded.await(20, TimeUnit.SECONDS), "run_end must arrive");
            socket.sendClose(WebSocket.NORMAL_CLOSURE, "done").join();
        }

        assertTrue(requestedModels.stream().anyMatch("ws-model"::equals),
                "the provider call carried the workspace scope's model");

        // The thinking seed followed the workspace scope too: the Ollama wire
        // sends "think":true only when the harness requests reasoning, and
        // omits the field entirely when it is off (NON_NULL serialization).
        JsonNode wsRequest = null;
        for (String body : requestedBodies) {
            JsonNode parsed = JSON.readTree(body);
            if ("ws-model".equals(parsed.path("model").asText())) {
                wsRequest = parsed;
                break;
            }
        }
        assertTrue(wsRequest != null, "the ws-model request body must have been recorded");
        assertFalse(wsRequest.path("think").asBoolean(false),
                "thinking:false in the workspace scope must reach the wire (no think:true)");

        // Final wave (fix 1): the reseed must be VISIBLE on the wire too, not
        // just at the provider call — the header chip and composer gear learn
        // a workspace override the moment it takes effect, via a re-announced
        // provider_info frame (like every other provider_info, never in the
        // JSONL). "ollama" is the ws provider (unchanged from the boot config
        // here); "ws-model" is what actually changed and could only appear if
        // the frame were built from the reseeded session config.
        assertTrue(events.stream().anyMatch(e -> "provider_info".equals(e.path("type").asText())
                        && "ollama".equals(e.path("provider").asText())
                        && "ws-model".equals(e.path("model").asText())),
                "the session-moment reseed must re-announce provider_info with the workspace's "
                        + "model, got " + events.stream().map(e -> e.path("type").asText()).toList());
    }

    @Test
    void aBrokenWorkspaceScopeReportsLoudlyAndTheRunStillCompletes() throws Exception {
        // Task 15 fallback pin: a workspace file setting a forbidden
        // process-global ("workspace" inside a workspace scope) is rejected by
        // loadForWorkspace — the session must report it as a readable error
        // frame and still run on the connect-time view, never half-apply.
        Path ws = Files.createTempDirectory("spectroscope-ws-broken");
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), """
                { "workspace": "/elsewhere" }
                """);

        List<JsonNode> events = new ArrayList<>();
        CountDownLatch runEnded = new CountDownLatch(1);
        try (HttpClient client = HttpClient.newHttpClient()) {
            WebSocket socket = client.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws"),
                            collectInto(events, "run_end", runEnded))
                    .join();

            socket.sendText("""
                    {"type":"set_workspace","path":"%s"}""".formatted(ws), true);
            for (int i = 0; i < 100 && events.stream()
                    .noneMatch(e -> "workspace_info".equals(e.path("type").asText())); i++) {
                Thread.sleep(100);
            }
            assertTrue(events.stream().anyMatch(e -> "workspace_info".equals(e.path("type").asText())),
                    "set_workspace must answer with workspace_info before the run starts");

            socket.sendText("""
                    {"type":"user_message","text":"Say hello."}""", true);
            assertTrue(runEnded.await(20, TimeUnit.SECONDS),
                    "the run must still complete on the connect-time view");
            socket.sendClose(WebSocket.NORMAL_CLOSURE, "done").join();
        }

        assertTrue(events.stream().anyMatch(e -> "error".equals(e.path("type").asText())
                        && e.path("message").asText().contains("workspace settings ignored")),
                "the broken scope must surface as a readable error frame, got "
                        + events.stream().map(e -> e.path("type").asText()).toList());
        assertTrue(events.stream().anyMatch(e -> "run_end".equals(e.path("type").asText())),
                "run_end must arrive despite the broken workspace file");
    }

    @Test
    void aPersistedRuleLandsInTheWorkspaceProjectFile() throws Exception {
        Path ws = Files.createTempDirectory("spectroscope-settings-persist");
        // Isolate from any earlier (pre-fix) run of this same test: the OLD
        // behaviour would have left a rule in the launch-dir file.
        Path launchDirSettings = Path.of(System.getProperty("user.dir"), ".spectro", "settings.json");
        Files.deleteIfExists(launchDirSettings);

        List<JsonNode> events = new ArrayList<>();
        CountDownLatch runEnded = new CountDownLatch(1);
        try (HttpClient client = HttpClient.newHttpClient()) {
            WebSocket socket = client.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws"),
                            collectInto(events, "run_end", runEnded))
                    .join();

            // 1. Pin the session to a real workspace (not the per-session auto temp folder).
            socket.sendText("""
                    {"type":"set_workspace","path":"%s"}""".formatted(ws), true);
            for (int i = 0; i < 100 && events.stream()
                    .noneMatch(e -> "workspace_info".equals(e.path("type").asText())); i++) {
                Thread.sleep(100);
            }
            assertTrue(events.stream().anyMatch(e -> "workspace_info".equals(e.path("type").asText())),
                    "set_workspace must answer with workspace_info before the run starts");

            // 2. A prompt that makes the scripted mock call run_command, which needs permission.
            socket.sendText("""
                    {"type":"user_message","text":"%s"}""".formatted(RUN_COMMAND_TRIGGER_TEXT), true);
            for (int i = 0; i < 100 && events.stream()
                    .noneMatch(e -> "permission_request".equals(e.path("type").asText())); i++) {
                Thread.sleep(100);
            }
            JsonNode request = events.stream()
                    .filter(e -> "permission_request".equals(e.path("type").asText()))
                    .findFirst().orElseThrow(() ->
                            new AssertionError("run_command must trigger a permission_request, got " + events));
            String callId = request.path("callId").asText();

            // 3. Approve, remember AND persist the rule.
            socket.sendText("""
                    {"type":"permission_response","callId":"%s","allowed":true,"remember":true,"persist":true}"""
                    .formatted(callId), true);

            // 4. Let the run finish.
            assertTrue(runEnded.await(20, TimeUnit.SECONDS), "run_end must arrive");
            socket.sendClose(WebSocket.NORMAL_CLOSURE, "done").join();
        }

        String written = Files.readString(ws.resolve(".spectro/settings.json"));
        assertTrue(written.contains("run_command:"),
                "the rule lives in the WORKSPACE project file, got: " + written);
        assertFalse(Files.exists(launchDirSettings)
                        && Files.readString(launchDirSettings).contains("run_command:"),
                "the launch-dir file stays untouched when a real workspace exists");
    }

    @Test
    void aProviderSwitchAnnouncesTheNewBackendAsAFrame() throws Exception {
        // The switch must be VISIBLE on the wire: a second provider_info frame
        // (trace row, header chip, host column) — never a silent client-side swap.
        List<JsonNode> events = new ArrayList<>();
        CountDownLatch unused = new CountDownLatch(1);
        try (HttpClient client = HttpClient.newHttpClient()) {
            WebSocket socket = client.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws"),
                            collectInto(events, "never", unused))
                    .join();
            socket.sendText("""
                    {"type":"set_provider","provider":"openai","model":"my-local"}""", true);
            for (int i = 0; i < 100 && events.size() < 3; i++) {
                Thread.sleep(100);
            }
            socket.sendClose(WebSocket.NORMAL_CLOSURE, "done").join();
        }

        assertTrue(events.size() >= 3,
                "connect (provider + permission mode) + switch must all announce, got " + events);
        JsonNode boot = events.get(0);
        assertEquals("provider_info", boot.path("type").asText());
        assertEquals("ollama", boot.path("provider").asText());

        assertEquals("permission_mode_info", events.get(1).path("type").asText(),
                "the boot permission mode is announced right after the boot provider");

        JsonNode switched = events.get(2);
        assertEquals("provider_info", switched.path("type").asText());
        assertEquals("openai", switched.path("provider").asText());
        assertEquals("my-local", switched.path("model").asText());
        // The config points at the mock (not the untouched Ollama default), so
        // the openai host follows the configured base url unchanged.
        assertEquals("127.0.0.1:" + ollamaMock.getAddress().getPort(),
                switched.path("host").asText());
    }

    @Test
    void aBadSettingsPatchAnswers400WithTheReadableReasonInTheResponseBody() {
        // SettingsController#applyPatch throws ResponseStatusException with a
        // readable reason (here: SettingsWriter's "unknown settings key"
        // message) — Spring's DEFAULT error-rendering strips that reason from
        // the JSON body unless server.error.include-message=always is set.
        // SettingsControllerTest calls the controller method directly and
        // reads e.getReason(), which never exercises that rendering step; only
        // a real HTTP round trip through Spring Boot's error machinery can
        // prove the client actually receives the message.
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<String> request = new HttpEntity<>("{\"providr\":\"x\"}", headers);

        ResponseEntity<String> response =
                rest.exchange("/api/settings/user", HttpMethod.PUT, request, String.class);

        assertEquals(400, response.getStatusCode().value());
        assertTrue(response.getBody() != null && response.getBody().contains("unknown settings key"),
                "the error JSON's message field must carry the readable reason, got: "
                        + response.getBody());
    }
}
