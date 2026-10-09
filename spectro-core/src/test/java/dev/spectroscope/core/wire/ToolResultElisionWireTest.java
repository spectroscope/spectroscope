package dev.spectroscope.core.wire;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.OpenAiCompatProvider;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
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
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 467, the llm-wire half of criterion 4: the {@code llm_request} body the
 * recorder wrote for turn 12 carries the stub and no line of the file, and the
 * agent's event stream still carries the whole result.
 *
 * <p>A scripted OpenAI-compatible server answers twelve turns: a whole-file
 * read in turn 1, a small echo in turns 2 to 11, a closing answer in turn 12.
 * The server does not compare what it received with what the recorder wrote,
 * and the trace and the Lab, which fold the event stream, are not run here.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class ToolResultElisionWireTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String CLAUDE_MD = "LINE-OF-CLAUDE-MD\n".repeat(56_000 / 18 + 1)
            .substring(0, 56_000);

    @TempDir
    Path dir;

    private HttpServer server;
    private String baseUrl;
    private final AtomicInteger posts = new AtomicInteger();

    private static String toolCall(String id, String name, String arguments) {
        return "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"" + id
                + "\",\"function\":{\"name\":\"" + name + "\",\"arguments\":"
                + JSON.valueToTree(arguments) + "}}]}}]}\n\n"
                + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n"
                + "data: [DONE]\n\n";
    }

    private static final String ANSWER = """
            data: {"choices":[{"delta":{"content":"done"}}]}

            data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

            data: [DONE]

            """;

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            int turn = posts.incrementAndGet();
            String sse = turn == 1 ? toolCall("c1", "read_file", "{\"path\":\"CLAUDE.md\"}")
                    : turn <= 11 ? toolCall("e" + turn, "echo", "{\"value\":" + turn + "}")
                    : ANSWER;
            byte[] bytes = sse.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    private static Tool tool(String name, String output) {
        return new Tool() {
            public String name() { return name; }
            public String description() { return name; }
            public JsonNode inputSchema() { return JSON.createObjectNode().put("type", "object"); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return output; }
        };
    }

    @Test
    void theWireShowsTheStubAsSentAndTheEventStreamKeepsTheWholeResult() throws IOException {
        Path sidecar = dir.resolve("session.llm.jsonl");
        ToolRegistry registry = new ToolRegistry();
        registry.register(tool("read_file", CLAUDE_MD));
        registry.register(tool("echo", "ok"));
        List<RunEvent> events = new ArrayList<>();
        try (LlmWireRecorder recorder = new LlmWireRecorder(sidecar, LlmWireRecorder.DEFAULT_CEILING_BYTES)) {
            Agent agent = new Agent(AgentOptions.builder()
                    .provider(new OpenAiCompatProvider(
                            new OpenAiCompatProvider.Options(baseUrl, "test-model", null)))
                    .systemPrompt("test")
                    .registry(registry)
                    .cwd(dir)
                    .agentId("main")
                    .onPermission(request -> true)
                    .llmWire(recorder)
                    .maxTurns(20)
                    .build());
            try (EventStream stream = agent.run("read CLAUDE.md and keep going",
                    new RunOptions(new CancelSignal(), List.of()))) {
                stream.forEach(events::add);
            }
        }

        List<JsonNode> requests = new ArrayList<>();
        for (String line : Files.readAllLines(sidecar)) {
            JsonNode node = JSON.readTree(line);
            if ("llm_request".equals(node.path("type").asText())
                    && "main".equals(node.path("agentId").asText())) {
                requests.add(node);
            }
        }
        assertEquals(12, requests.size(), "premise: twelve exchanges on the record");

        String turnTwo = requests.get(1).path("body").asText();
        String turnTwelve = requests.get(11).path("body").asText();
        assertTrue(turnTwo.contains("LINE-OF-CLAUDE-MD"), "premise: turn 2 sent the file");
        assertFalse(turnTwelve.contains("LINE-OF-CLAUDE-MD"),
                "the wire shows the 56 kB going out again in turn 12");
        assertTrue(turnTwelve.contains("is left out of this request"),
                "the wire does not show the stub that was sent in its place");

        RunEvent.ToolResult result = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance).map(RunEvent.ToolResult.class::cast)
                .filter(r -> "c1".equals(r.callId())).findFirst().orElseThrow();
        // The test stops at the event stream. The trace tab and the Lab fold
        // these events (live or from the session file) and are not run here.
        assertEquals(CLAUDE_MD, result.output(),
                "the event stream lost bytes of a result the request only stubbed");
    }
}
