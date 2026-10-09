package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

/**
 * A stand-in for the Copilot runtime that speaks the SDK's JSON-RPC over a
 * loopback socket (Content-Length framing, protocol version 3), so the real
 * {@code com.github.copilot.CopilotClient} connects to it through {@code cliUrl}.
 *
 * <p>Every request the SDK sends is answered with a plausible result and kept,
 * so a test can read what the provider asked for. Turns are scripted: each
 * {@code session.send} starts the next script on its own thread, and a script
 * emits {@code session.event} notifications and waits for the SDK's answers the
 * way the real runtime does (shapes copied from card 478's live logs).</p>
 */
final class FakeCopilotRuntime implements AutoCloseable {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    private final ServerSocket server;
    private final List<JsonNode> requests = new CopyOnWriteArrayList<>();
    private final Map<String, BlockingQueue<JsonNode>> byMethod = new ConcurrentHashMap<>();
    private final BlockingQueue<Consumer<Turn>> scripts = new LinkedBlockingQueue<>();
    private final Map<Long, BlockingQueue<JsonNode>> clientAnswers = new ConcurrentHashMap<>();
    private final AtomicLong serverRequestIds = new AtomicLong(1000);
    private final AtomicBoolean aborted = new AtomicBoolean();
    private volatile Consumer<Turn> abortTail = turn -> { };
    private final List<Throwable> scriptFailures = new CopyOnWriteArrayList<>();
    private volatile Socket socket;
    private volatile OutputStream out;
    private volatile String sessionId;
    private volatile JsonNode createParams;
    private volatile boolean dead;
    private volatile boolean closed;
    private volatile boolean failModels;

    FakeCopilotRuntime() throws IOException {
        server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
        Thread accept = new Thread(this::acceptAndRead, "fake-copilot-runtime");
        accept.setDaemon(true);
        accept.start();
    }

    /** @return the address the SDK's {@code cliUrl} option takes */
    String cliUrl() {
        return "http://127.0.0.1:" + server.getLocalPort();
    }

    /** Makes every {@code models.list} answer with a JSON-RPC error, as a runtime without a login does. */
    /** What {@code auth.getStatus} answers; card 495. Not signed in until a test says otherwise. */
    private volatile Map<String, Object> authStatus = Map.of("isAuthenticated", false,
            "statusMessage", "Not authenticated");

    FakeCopilotRuntime authStatus(Map<String, Object> status) {
        this.authStatus = status;
        return this;
    }

    FakeCopilotRuntime failModels() {
        failModels = true;
        return this;
    }

    /** Queues the script the next {@code session.send} runs. */
    FakeCopilotRuntime onSend(Consumer<Turn> script) {
        scripts.add(script);
        return this;
    }

    /**
     * What the runtime still emits after {@code session.abort} and before its
     * {@code abort} and {@code session.idle} events: deltas already in flight.
     */
    FakeCopilotRuntime abortTail(Consumer<Turn> tail) {
        abortTail = tail;
        return this;
    }

    JsonNode createParams() {
        return createParams;
    }

    List<JsonNode> requests() {
        return List.copyOf(requests);
    }

    /** @return every request of one method, in arrival order */
    List<JsonNode> requests(String method) {
        List<JsonNode> found = new ArrayList<>();
        for (JsonNode request : requests) {
            if (method.equals(request.path("method").asText())) {
                found.add(request.path("params"));
            }
        }
        return found;
    }

    /** Blocks until a request of {@code method} arrives, and consumes it. */
    JsonNode await(String method, Duration timeout) {
        try {
            JsonNode params = queue(method).poll(timeout.toMillis(), TimeUnit.MILLISECONDS);
            if (params == null) {
                throw new AssertionError("no " + method + " within " + timeout);
            }
            return params;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError(e);
        }
    }

    List<Throwable> scriptFailures() {
        return scriptFailures;
    }

    @Override
    public void close() throws IOException {
        closed = true;
        dead = true;
        Socket s = socket;
        if (s != null) {
            s.close();
        }
        server.close();
    }

    // ---- the wire --------------------------------------------------------

    /** Serves one client after the other: a client that comes back after a death is a new runtime. */
    private void acceptAndRead() {
        while (!closed) {
            Socket s;
            try {
                s = server.accept();
            } catch (IOException stopped) {
                return; // the test closed the runtime
            }
            dead = false;
            socket = s;
            try {
                out = s.getOutputStream();
                InputStream in = s.getInputStream();
                while (!dead) {
                    JsonNode message = read(in);
                    if (message == null) {
                        break;
                    }
                    if (message.has("method")) {
                        requests.add(message);
                        queue(message.get("method").asText()).add(message.path("params"));
                        answer(message);
                    } else if (message.has("id")) {
                        BlockingQueue<JsonNode> waiting = clientAnswers.get(message.get("id").asLong());
                        if (waiting != null) {
                            waiting.add(message);
                        }
                    }
                }
            } catch (IOException gone) {
                // a script made the runtime die, or the client went away
            }
        }
    }

    private void answer(JsonNode message) throws IOException {
        if (!message.has("id") || message.get("id").isNull()) {
            return; // a notification
        }
        String method = message.get("method").asText();
        JsonNode params = message.path("params");
        if ("models.list".equals(method) && failModels) {
            ObjectNode error = NODES.objectNode();
            error.put("code", -32603);
            error.put("message", "not signed in");
            ObjectNode response = NODES.objectNode();
            response.put("jsonrpc", "2.0");
            response.set("id", message.get("id"));
            response.set("error", error);
            write(response);
            return;
        }
        JsonNode result = switch (method) {
            case "connect" -> object(Map.of("protocolVersion", 3));
            case "session.create" -> {
                sessionId = params.path("sessionId").asText();
                createParams = params;
                yield object(Map.of("sessionId", sessionId));
            }
            case "session.send" -> {
                Consumer<Turn> script = scripts.poll();
                String target = params.path("sessionId").asText();
                if (script != null) {
                    Thread t = new Thread(() -> runScript(script, target), "fake-copilot-turn");
                    t.setDaemon(true);
                    t.start();
                }
                yield object(Map.of("messageId", UUID.randomUUID().toString()));
            }
            case "session.abort" -> {
                aborted.set(true);
                String target = params.path("sessionId").asText();
                Thread t = new Thread(() -> {
                    sleep(20);
                    Turn turn = new Turn(target);
                    abortTail.accept(turn);
                    turn.event("abort", object(Map.of("reason", "user_initiated")));
                    turn.event("session.idle", object(Map.of("aborted", true)));
                }, "fake-copilot-abort");
                t.setDaemon(true);
                t.start();
                yield NODES.nullNode();
            }
            case "models.list" -> modelsFixture();
            case "auth.getStatus" -> object(authStatus);
            case "session.detach", "session.tools.handlePendingToolCall",
                 "session.permissions.handlePendingPermissionRequest" -> object(Map.of("success", true));
            default -> NODES.objectNode();
        };
        ObjectNode response = NODES.objectNode();
        response.put("jsonrpc", "2.0");
        response.set("id", message.get("id"));
        response.set("result", result);
        write(response);
    }

    private void runScript(Consumer<Turn> script, String target) {
        try {
            script.accept(new Turn(target));
        } catch (Throwable failure) {
            scriptFailures.add(failure);
        }
    }

    private BlockingQueue<JsonNode> queue(String method) {
        return byMethod.computeIfAbsent(method, m -> new LinkedBlockingQueue<>());
    }

    private synchronized void write(JsonNode message) throws IOException {
        byte[] body = JSON.writeValueAsBytes(message);
        out.write(("Content-Length: " + body.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write(body);
        out.flush();
    }

    private static JsonNode read(InputStream in) throws IOException {
        int length = -1;
        StringBuilder line = new StringBuilder();
        while (true) {
            int c = in.read();
            if (c == -1) {
                return null;
            }
            if (c == '\n') {
                String header = line.toString().trim();
                line.setLength(0);
                if (header.isEmpty()) {
                    break;
                }
                if (header.toLowerCase().startsWith("content-length:")) {
                    length = Integer.parseInt(header.substring("content-length:".length()).trim());
                }
            } else {
                line.append((char) c);
            }
        }
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        byte[] buffer = new byte[Math.max(length, 0)];
        int read = 0;
        while (read < length) {
            int n = in.read(buffer, read, length - read);
            if (n == -1) {
                return null;
            }
            read += n;
        }
        body.write(buffer, 0, length);
        return JSON.readTree(body.toByteArray());
    }

    private static JsonNode modelsFixture() {
        try (InputStream in = FakeCopilotRuntime.class.getResourceAsStream("/copilot/models-list.json")) {
            return JSON.readTree(in);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static ObjectNode object(Map<String, ?> fields) {
        return JSON.valueToTree(fields);
    }

    static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** What a script can do: emit events, wait for the SDK, call the SDK, die. */
    final class Turn {

        /** The runtime session this turn belongs to; events go there even after a newer one opened. */
        private final String target;

        Turn(String target) {
            this.target = target;
        }

        /** Sends one {@code session.event} notification. */
        void event(String type, ObjectNode data) {
            ObjectNode event = NODES.objectNode();
            event.put("id", UUID.randomUUID().toString());
            event.put("timestamp", OffsetDateTime.now().toString());
            event.putNull("parentId");
            event.put("type", type);
            event.set("data", data);
            ObjectNode params = NODES.objectNode();
            params.put("sessionId", target);
            params.set("event", event);
            ObjectNode notification = NODES.objectNode();
            notification.put("jsonrpc", "2.0");
            notification.put("method", "session.event");
            notification.set("params", params);
            try {
                write(notification);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }

        void delta(String text) {
            event("assistant.message_delta", object(Map.of("messageId", "msg-1", "deltaContent", text)));
        }

        void reasoning(String text) {
            event("assistant.reasoning_delta", object(Map.of("reasoningId", "r-1", "deltaContent", text)));
        }

        /** The usage shape of a live run: inputTokens counts the cached part too. */
        void usage(long input, long output, long cacheRead, long cacheWrite, String finishReason) {
            event("assistant.usage", object(Map.of("model", "claude-sonnet-5", "inputTokens", input,
                    "outputTokens", output, "cacheReadTokens", cacheRead, "cacheWriteTokens", cacheWrite,
                    "finishReason", finishReason)));
        }

        void message(String content, List<Map<String, Object>> toolRequests) {
            ObjectNode data = object(Map.of("messageId", "msg-1", "content", content));
            ArrayNode requests = data.putArray("toolRequests");
            toolRequests.forEach(r -> requests.add(JSON.valueToTree(r)));
            event("assistant.message", data);
        }

        void idle() {
            event("session.idle", object(Map.of("aborted", false)));
        }

        /**
         * Asks the SDK's permission handler, the way the runtime does before it
         * runs a tool, and returns the result kind the SDK sent back.
         */
        String askPermission(Map<String, Object> permissionRequest) {
            String requestId = UUID.randomUUID().toString();
            event("permission.requested", object(Map.of("requestId", requestId,
                    "permissionRequest", permissionRequest)));
            while (true) {
                JsonNode answer = await("session.permissions.handlePendingPermissionRequest", Duration.ofSeconds(10));
                if (requestId.equals(answer.path("requestId").asText())) {
                    return answer.path("result").path("kind").asText();
                }
            }
        }

        /** Hands one tool call to the SDK and returns the request id to wait on. */
        String requestTool(String toolCallId, String name, Map<String, Object> arguments) {
            String requestId = UUID.randomUUID().toString();
            event("external_tool.requested", object(Map.of("requestId", requestId, "sessionId", target,
                    "toolCallId", toolCallId, "toolName", name, "arguments", arguments)));
            return requestId;
        }

        /** Waits for the SDK to deliver a parked tool result. */
        JsonNode awaitToolResult(String requestId, Duration timeout) {
            long deadline = System.nanoTime() + timeout.toNanos();
            List<JsonNode> others = new ArrayList<>();
            try {
                while (System.nanoTime() < deadline) {
                    JsonNode result = queue("session.tools.handlePendingToolCall")
                            .poll(50, TimeUnit.MILLISECONDS);
                    if (result != null) {
                        if (requestId.equals(result.path("requestId").asText())) {
                            return result;
                        }
                        others.add(result);
                    }
                }
                throw new AssertionError("no tool result for " + requestId + " within " + timeout);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AssertionError(e);
            } finally {
                queue("session.tools.handlePendingToolCall").addAll(others);
            }
        }

        /** Calls the SDK (server to client request) and returns its answer. */
        JsonNode callClient(String method, ObjectNode params) {
            long id = serverRequestIds.incrementAndGet();
            BlockingQueue<JsonNode> answer = new LinkedBlockingQueue<>();
            clientAnswers.put(id, answer);
            ObjectNode request = NODES.objectNode();
            request.put("jsonrpc", "2.0");
            request.put("id", id);
            request.put("method", method);
            request.set("params", params);
            try {
                write(request);
                JsonNode reply = answer.poll(10, TimeUnit.SECONDS);
                if (reply == null) {
                    throw new AssertionError("no answer to " + method);
                }
                return reply;
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AssertionError(e);
            }
        }

        boolean aborted() {
            return aborted.get();
        }

        String sessionId() {
            return target;
        }

        /** The runtime process dies: the connection drops without a goodbye. */
        void die() {
            dead = true;
            try {
                socket.close();
            } catch (IOException ignored) {
                // already gone
            }
        }
    }
}
