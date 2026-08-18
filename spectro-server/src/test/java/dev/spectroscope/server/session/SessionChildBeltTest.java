package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
import dev.spectroscope.core.tools.Tool;
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
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 270, the capability half: a child agent has the same hands as its parent.
 *
 * <p>Measured on 2026-08-17, before this card:
 * {@code SessionConnection.buildAgentOnce} hand-assembled a child's belt as
 * {@code StandardTools.all()} plus {@code use_skill}. The settings belt — the
 * browser family, the launch family, generate_image, the three web tools — and
 * the MCP tools registered one line earlier went into the PARENT's registry
 * only. So a child could not open a page and could not touch a single MCP
 * server the operator had configured, and the baseline session in
 * {@code konzept/ORCHESTRATION.md} §2 caught the model working that out for
 * itself and declining the {@code test} role because of it. The refusal was
 * factually correct.</p>
 *
 * <p>The pin drives the REAL door, like {@link SessionChildWireTest} beside it:
 * a {@link SessionConnection} built the way the websocket handler builds one, a
 * scripted loopback backend that makes the parent spawn one worker, a REAL MCP
 * server on loopback that the session's own configuration mounts, and then the
 * assertion reads what the CHILD's tool call answered. Asking the manager for a
 * list of names would have passed on the day this broke; only the child's own
 * {@code tool_result} can tell "I hold this tool" from "unknown tool".</p>
 *
 * <p>The same run carries the security criterion. An MCP tool is
 * permission-gated, so the child's call has to reach the operator: the test
 * refuses to answer any prompt that does not name {@code worker-1} as the
 * asker, and a second test denies one and reads the refusal back out of the
 * child's own transcript. Widening a belt widens reach; the gate is what keeps
 * that honest.</p>
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS)
class SessionChildBeltTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The worker child's system prompt opener — how the mock tells a child's
     *  call from the parent's (the parent's own request carries the word
     *  "subagent" inside its spawn-tool descriptions). */
    private static final String WORKER_MARKER = "You are a work subagent (type worker)";

    private HttpServer backend;
    private HttpServer mcp;

    @AfterEach
    void stopServers() {
        if (backend != null) {
            backend.stop(0);
        }
        if (mcp != null) {
            mcp.stop(0);
        }
    }

    /**
     * A real MCP server over HTTP on loopback: {@code initialize},
     * {@code tools/list} with one {@code ping}, and {@code tools/call}
     * answering a phrase nothing else in this file produces.
     *
     * @return the url an operator would put in the {@code mcpServers} block
     */
    private String startMcpServer() throws IOException {
        mcp = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        mcp.createContext("/", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            JsonNode frame = JSON.readTree(body);
            String method = frame.path("method").asText();
            String id = frame.path("id").isNumber() ? frame.path("id").asText() : null;
            String result = switch (method) {
                case "initialize" -> """
                        {"protocolVersion":"2024-11-05","serverInfo":{"name":"notes","version":"1"},
                         "capabilities":{}}""";
                case "tools/list" -> """
                        {"tools":[{"name":"ping","description":"answers with a phrase",
                                   "inputSchema":{"type":"object","properties":{}}}]}""";
                case "tools/call" -> """
                        {"content":[{"type":"text","text":"pong from the operator's own server"}]}""";
                default -> "{}";
            };
            byte[] answer = (id == null ? "" : """
                    {"jsonrpc":"2.0","id":%s,"result":%s}""".formatted(id, result))
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        mcp.start();
        return "http://127.0.0.1:" + mcp.getAddress().getPort() + "/";
    }

    /**
     * A scripted Ollama on loopback. The parent spawns exactly one worker; the
     * worker reaches for the operator's MCP tool, then for the browser family,
     * then answers; the parent closes the run.
     *
     * @return the base url to point the provider at
     */
    private String startScriptedBackend() throws IOException {
        backend = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicInteger childTurn = new AtomicInteger();
        backend.createContext("/api/chat", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            String ndjson;
            if (body.contains(WORKER_MARKER)) {
                ndjson = switch (childTurn.getAndIncrement()) {
                    case 0 -> toolCall("mcp__notes__ping", "{}");
                    case 1 -> toolCall("browser_read_page", "{}");
                    default -> text("child done");
                };
            } else if (body.contains("\"role\":\"tool\"")) {
                ndjson = text("Delegated and done.");
            } else {
                ndjson = toolCall("spawn_agent",
                        "{\"type\":\"worker\",\"task\":\"use the operator's tools\"}");
            }
            byte[] answer = ndjson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            exchange.sendResponseHeaders(200, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        backend.start();
        return "http://127.0.0.1:" + backend.getAddress().getPort();
    }

    private static String text(String content) {
        return """
                {"message":{"content":"%s"},"done":false}
                {"message":{"content":""},"done":true,"prompt_eval_count":6,"eval_count":3}
                """.formatted(content);
    }

    private static String toolCall(String name, String arguments) {
        return """
                {"message":{"content":"","tool_calls":[{"function":{"name":"%s","arguments":%s}}]},"done":false}
                {"message":{"content":""},"done":true,"prompt_eval_count":8,"eval_count":4}
                """.formatted(name, arguments);
    }

    @Test
    void aChildReachesTheOperatorsMcpServerAndABrowserReader(@TempDir Path workspace)
            throws Exception {
        String mcpUrl = startMcpServer();
        String backendUrl = startScriptedBackend();
        FakeSocket socket = new FakeSocket("ws-270", "ws://localhost/ws");
        SpectroConfig config = configuredIn(workspace, backendUrl, mcpUrl);
        SessionConnection connection = new SessionConnection(socket, JSON, config, null);
        connection.start();
        Thread gate = answerEveryPromptFrom(connection, socket, "worker-1", true);
        try {
            connection.onUserMessage("Delegate: start exactly one worker subagent.", null);
            String frames = awaitRunEnd(socket);

            assertThat(frames)
                    .as("test premise: a child actually ran")
                    .contains("agent_spawn");
            // The premise that used to stand here read `frames` for the tool's
            // NAME and called it proof that the PARENT holds it — but the string
            // it found was the CHILD's own tool_call frame, which the script
            // emits unconditionally. It measured nothing and named the wrong
            // agent. The belt itself is the honest premise, and it is asserted
            // in aChildIsNotHandedTheVerbsThatBelongToTheMainAgentAlone, which
            // reads connection.childBelt() and connection.belt() directly.

            assertThat(childResultFor(frames, "mcp__notes__ping"))
                    .as("card 270: the MCP tools the operator configured reach a child")
                    .contains("pong from the operator's own server")
                    .doesNotContain("unknown tool");
            assertThat(childResultFor(frames, "browser_read_page"))
                    .as("card 270: a browser tool reaches a child — a detached browser "
                            + "is an answer, an unknown tool is a missing hand")
                    .doesNotContain("unknown tool");
            // The script drives ONE of the seven, so the name says "a reader".
            // That one call proves the MECHANISM; the family's membership is a
            // different claim and is asserted over the belt rather than guessed
            // from a single call.
            assertThat(connection.childBelt().stream().map(Tool::name).toList())
                    .as("and the whole family arrived, not just the one the script called")
                    .contains("browser_navigate", "browser_read_page", "browser_find",
                            "browser_eval", "browser_resize", "browser_read_console",
                            "launch_start", "launch_list", "launch_logs");

            assertThat(askersAt(socket))
                    .as("security criterion: a child's guarded tool really asks, and the "
                            + "prompt names the CHILD as the asker")
                    .contains("worker-1|mcp__notes__ping");
        } finally {
            gate.interrupt();
            connection.onClose();
        }
    }

    @Test
    void aDeniedChildCallComesBackWithTheGatesOwnRefusal(@TempDir Path workspace)
            throws Exception {
        // Renamed, not loosened. It used to claim "exactly like a denied PARENT
        // call" while its only assertion read childResultFor(...), which filters
        // on agentId().startsWith("worker") — the parent's single tool call in
        // this script is spawn_agent, which is permission-free, so there was no
        // parent refusal to compare against and none was ever measured. What it
        // does measure is real and worth keeping: the child's denied call comes
        // back with the gate's own sentence rather than silence.
        String mcpUrl = startMcpServer();
        String backendUrl = startScriptedBackend();
        FakeSocket socket = new FakeSocket("ws-270-deny", "ws://localhost/ws");
        SpectroConfig config = configuredIn(workspace, backendUrl, mcpUrl);
        SessionConnection connection = new SessionConnection(socket, JSON, config, null);
        connection.start();
        Thread gate = answerEveryPromptFrom(connection, socket, "worker-1", false);
        try {
            connection.onUserMessage("Delegate: start exactly one worker subagent.", null);
            String frames = awaitRunEnd(socket);

            assertThat(childResultFor(frames, "mcp__notes__ping"))
                    .as("the gate decides a child's call the same way it decides the parent's")
                    .contains("the user denied the execution");
        } finally {
            gate.interrupt();
            connection.onClose();
        }
    }

    @Test
    void aChildIsNotHandedTheVerbsThatBelongToTheMainAgentAlone(@TempDir Path workspace)
            throws Exception {
        // Card 270's belt half widened a child to the parent's whole assembly.
        // Three things were deliberately kept OFF it, and every one of them is a
        // fence made of a single line's POSITION in buildAgentOnce — nothing a
        // reader of the diff can tell from an accident. Before this test, moving
        // any of those lines onto childBase left 2651 tests green:
        //
        //   update_plan       — a child writing the flat UI plan snapshot would
        //                       clobber the operator's own view (card 270).
        //   ask_user_question — decided at the merge of this half, after card 265
        //                       landed: a child raising its own question parks the
        //                       operator behind a spawn they never approved.
        //   spawn_agent/s     — depth stays 1 by construction.
        String backendUrl = startScriptedBackend();
        FakeSocket socket = new FakeSocket("ws-270-main-only", "ws://localhost/ws");
        SpectroConfig config = configuredIn(workspace, backendUrl, startMcpServer());
        SessionConnection connection = new SessionConnection(socket, JSON, config, null);
        connection.start();
        try {
            connection.onUserMessage("Build the belt.", null);
            awaitBelt(connection);

            List<String> childNames = connection.childBelt().stream().map(Tool::name).toList();
            assertThat(childNames)
                    .as("the verbs that belong to the main agent alone never reach a child")
                    .doesNotContain("update_plan", "ask_user_question", "spawn_agent",
                            "spawn_agents");

            List<String> parentNames = connection.belt().specs().stream()
                    .map(ToolSpec::name).toList();
            assertThat(parentNames)
                    .as("test premise: the parent really does hold them, so the absence "
                            + "above is a decision and not an empty session")
                    .contains("update_plan", "ask_user_question", "spawn_agent");

            assertThat(childNames)
                    .as("and what the card DID widen is on it — the belt is not simply short")
                    .contains("browser_read_page", "launch_list", "mcp__notes__ping",
                            "web_fetch", "generate_image");
        } finally {
            connection.onClose();
        }
    }

    /** Polls until the session has assembled its belts (the build is lazy, on
     *  the first prompt).
     *  @param connection the session under test */
    private static void awaitBelt(SessionConnection connection) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            if (!connection.childBelt().isEmpty() && connection.belt() != null) return;
            Thread.sleep(25);
        }
        throw new AssertionError("the session never assembled a belt");
    }

    /** The workspace-scoped configuration both tests start from. */
    private static SpectroConfig configuredIn(Path workspace, String backendUrl, String mcpUrl)
            throws IOException {
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s",
                  "mcpServers": { "notes": { "url": "%s", "type": "http" } } }
                """.formatted(backendUrl, mcpUrl));
        return SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", backendUrl, null, null, workspace.toString()));
    }

    /**
     * Stands in for the operator at the gate — and refuses to answer any prompt
     * that does not come from the expected asker, so a prompt raised under the
     * parent's name would hang this test rather than pass it.
     *
     * @param connection  the session whose prompts are being answered
     * @param socket      the recording socket the prompts arrive on
     * @param expectedAsker the agentId every prompt in this run must carry
     * @param allow       the verdict to give
     * @return the answering thread, to be interrupted by the caller
     */
    private static Thread answerEveryPromptFrom(SessionConnection connection, FakeSocket socket,
                                                String expectedAsker, boolean allow) {
        return Thread.ofVirtual().name("card-270-gate").start(() -> {
            List<String> answered = new java.util.ArrayList<>();
            while (!Thread.currentThread().isInterrupted()) {
                for (JsonNode frame : framesOf(socket)) {
                    if (!"permission_request".equals(frame.path("type").asText())) {
                        continue;
                    }
                    String callId = frame.path("callId").asText();
                    if (answered.contains(callId)
                            || !expectedAsker.equals(frame.path("agentId").asText())) {
                        continue;
                    }
                    answered.add(callId);
                    connection.onPermissionResponse(callId, allow, false, false);
                }
                try {
                    Thread.sleep(25);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        });
    }

    /** Who was asked about what, one "agentId|tool" entry per permission prompt. */
    private static List<String> askersAt(FakeSocket socket) {
        return framesOf(socket).stream()
                .filter(frame -> "permission_request".equals(frame.path("type").asText()))
                .map(frame -> frame.path("agentId").asText() + "|" + frame.path("name").asText())
                .toList();
    }

    /** Every frame this socket received, parsed; unparseable frames are skipped
     *  (the connection also sends non-event frames). */
    private static List<JsonNode> framesOf(FakeSocket socket) {
        List<JsonNode> out = new java.util.ArrayList<>();
        for (String raw : socket.textJoined().split("\n")) {
            try {
                out.add(JSON.readTree(raw));
            } catch (IOException notAnEvent) {
                // a frame this test does not read
            }
        }
        return out;
    }

    /** What the CHILD's call to {@code toolName} answered — read out of the
     *  tool_result the child's own agentId is stamped on. */
    private static String childResultFor(String frames, String toolName) {
        String callId = null;
        for (String raw : frames.split("\n")) {
            JsonNode frame;
            try {
                frame = JSON.readTree(raw);
            } catch (IOException notAnEvent) {
                continue;
            }
            if ("tool_call".equals(frame.path("type").asText())
                    && toolName.equals(frame.path("name").asText())
                    && frame.path("agentId").asText().startsWith("worker")) {
                callId = frame.path("callId").asText();
            }
            if (callId != null && "tool_result".equals(frame.path("type").asText())
                    && callId.equals(frame.path("callId").asText())) {
                return frame.path("output").asText();
            }
        }
        throw new AssertionError("the child never called " + toolName
                + " (or its result never arrived); frames:\n" + frames);
    }

    /** Polls the recorded frames until the MAIN run's run_end arrives. */
    private static String awaitRunEnd(FakeSocket socket) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (System.nanoTime() < deadline) {
            String joined = socket.textJoined();
            if (joined.contains("Delegated and done.")) {
                Thread.sleep(200); // let the closing run_end land too
                return socket.textJoined();
            }
            Thread.sleep(50);
        }
        throw new AssertionError("the run never finished; frames so far:\n" + socket.textJoined());
    }
}
