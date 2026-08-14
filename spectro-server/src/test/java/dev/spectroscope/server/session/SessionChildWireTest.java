package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.wire.LlmWireRecorder;
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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 231, the live product gap: a subagent's exchange must land in the SAME
 * {@code .llm.jsonl} the parent writes on. Card 184 promises "Captured: …
 * subagents"; {@code SubagentConfig}'s javadoc promises "the SAME instance the
 * parent writes on" — and the server door passed a positional {@code null}
 * instead, so every child ran off the record.
 *
 * <p>This test drives the REAL door: a {@link SessionConnection} built the way
 * the websocket handler builds one, a scripted loopback backend that makes the
 * parent spawn one explore child, and then the assertion reads the session's
 * wire FILE — not a recorder a test wired itself. {@code AgentWireBindingTest}
 * already proves the core plumbing works when a recorder is handed through;
 * what it cannot see is the door dropping the recorder, which is exactly the
 * defect this file pins.</p>
 *
 * <p>Bite proof (measured): hand the positional {@code null} back at
 * {@code buildAgentOnce}'s {@code SubagentConfig} and this goes red with
 * "child agentIds on the wire: []" while the parent's own lines stay on file —
 * restore, green.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class SessionChildWireTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The explore child's system prompt opener — how the mock tells a child's
     *  call from the parent's (the parent's request also contains the word
     *  "subagent" in its spawn-tool DESCRIPTIONS, so the match must be on the
     *  system prompt, not the word). */
    private static final String CHILD_PROMPT_MARKER = "You are a research subagent (type explore)";

    private HttpServer mock;

    @AfterEach
    void stopMock() {
        if (mock != null) {
            mock.stop(0);
        }
    }

    /**
     * A scripted Ollama on loopback: the parent's first call answers with a
     * {@code spawn_agent} tool call, the child's call (recognized by its role
     * system prompt) answers plain text, the parent's post-tool call closes
     * the run. Same NDJSON shapes {@code SpectroServerIntegrationTest} uses.
     *
     * @return the base url to point the provider at
     */
    private String startScriptedBackend() throws IOException {
        mock = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        mock.createContext("/api/chat", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            String ndjson;
            if (body.contains(CHILD_PROMPT_MARKER)) {
                ndjson = """
                        {"message":{"content":"memo: the workspace is empty."},"done":false}
                        {"message":{"content":""},"done":true,"prompt_eval_count":6,"eval_count":3}
                        """;
            } else if (body.contains("\"role\":\"tool\"")) {
                ndjson = """
                        {"message":{"content":"Delegated and done."},"done":false}
                        {"message":{"content":""},"done":true,"prompt_eval_count":9,"eval_count":2}
                        """;
            } else {
                ndjson = """
                        {"message":{"content":"","tool_calls":[{"function":{"name":"spawn_agent","arguments":{"type":"explore","task":"look around the workspace"}}}]},"done":false}
                        {"message":{"content":""},"done":true,"prompt_eval_count":8,"eval_count":4}
                        """;
            }
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

    @Test
    void aChildRunsExchangeLandsInTheParentsLlmWire(@TempDir Path workspace) throws Exception {
        String baseUrl = startScriptedBackend();
        // The backend rides in the WORKSPACE scope, not in a flag override: the
        // session moment (adoptSessionConfig) re-resolves the hierarchy with
        // Overrides.none(), so a flag-layer baseUrl would be dropped exactly
        // when the agent is built. The workspace scope survives that moment —
        // the same seam SpectroServerIntegrationTest's ws-model test pins —
        // and the @TempDir keeps it isolated from every other test's settings.
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(baseUrl));
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", baseUrl, null, null, workspace.toString()));
        FakeSocket socket = new FakeSocket("ws-231", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config, null);
        connection.start();
        try {
            connection.onUserMessage("Delegate: start exactly one explore subagent.", null);

            String frames = awaitRunEnd(socket);
            assertThat(frames)
                    .as("test premise: a child actually ran (the merged stream announced the spawn)")
                    .contains("agent_spawn");

            String sessionId = sessionIdFrom(frames);
            Path wireFile = LlmWireRecorder.fileFor(sessionId);
            assertThat(wireFile)
                    .as("test premise: the session records its llm-wire at all")
                    .exists();

            List<JsonNode> lines = Files.readAllLines(wireFile).stream()
                    .map(SessionChildWireTest::parse)
                    .toList();
            List<String> requestAgents = lines.stream()
                    .filter(line -> "llm_request".equals(line.path("type").asText()))
                    .map(line -> line.path("agentId").asText())
                    .toList();
            assertThat(requestAgents)
                    .as("test premise: the parent's own calls are on the record")
                    .contains("main");
            assertThat(requestAgents)
                    .as("card 231: the child's exchange lands in the SAME .llm.jsonl the parent"
                            + " writes on — child agentIds on the wire: "
                            + requestAgents.stream().filter(id -> !"main".equals(id)).toList())
                    .contains("explore-1");
            assertThat(lines.stream()
                    .filter(line -> "llm_response".equals(line.path("type").asText()))
                    .map(line -> line.path("agentId").asText()))
                    .as("the child's response line pairs with its request on the same file")
                    .contains("explore-1");
        } finally {
            connection.onClose();
        }
    }

    /** Polls the recorded frames until run_end arrives — the run happens on its
     *  own virtual thread and the fake socket only records. */
    private static String awaitRunEnd(FakeSocket socket) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45);
        while (System.nanoTime() < deadline) {
            String joined = socket.textJoined();
            if (joined.contains("\"run_end\"")) {
                return joined;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("no run_end frame arrived; frames so far:\n" + socket.textJoined());
    }

    /** The session id, read from the workspace_info frame the connection sent. */
    private static String sessionIdFrom(String frames) {
        Matcher matcher = Pattern.compile("\"sessionId\":\"([A-Za-z0-9-]+)\"").matcher(frames);
        if (!matcher.find()) {
            throw new AssertionError("no sessionId in any frame:\n" + frames);
        }
        return matcher.group(1);
    }

    private static JsonNode parse(String line) {
        try {
            return JSON.readTree(line);
        } catch (IOException malformed) {
            throw new AssertionError("unparseable wire line: " + line, malformed);
        }
    }
}
