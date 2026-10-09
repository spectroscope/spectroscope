package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.subagents.RoleCatalog;
import dev.spectroscope.core.subagents.SubagentConfig;
import dev.spectroscope.core.subagents.SubagentManager;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * Card 490, criterion 8: a chat with no session count set sends what v0.14.4
 * sent. The whole request body a parent with the spawn and role tools posts
 * to Anthropic and to an OpenAI-compatible server is compared, byte for byte,
 * with a capture taken from the v0.14.4 tree ({@code 8d7fcf48}).
 *
 * <p>The captures were written by this same test on that tree, with the
 * environment variable {@value #CAPTURE_ENV} naming the folder to write into.
 * Without the variable the test compares and writes nothing.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SpawnToolsRequestBytesTest {

    /** Names a folder to write the bodies into instead of comparing them. */
    static final String CAPTURE_ENV = "SPECTRO_CAPTURE_REQUEST_BODIES";

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final List<String> ANTHROPIC_SSE = List.of(
            "{\"type\":\"message_start\",\"message\":{\"id\":\"msg_490\",\"type\":\"message\","
                    + "\"role\":\"assistant\",\"model\":\"claude-opus-4-8\",\"content\":[],"
                    + "\"stop_reason\":null,\"stop_sequence\":null,"
                    + "\"usage\":{\"input_tokens\":12,\"output_tokens\":1}}}",
            "{\"type\":\"content_block_start\",\"index\":0,"
                    + "\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
            "{\"type\":\"content_block_delta\",\"index\":0,"
                    + "\"delta\":{\"type\":\"text_delta\",\"text\":\"done\"}}",
            "{\"type\":\"content_block_stop\",\"index\":0}",
            "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\","
                    + "\"stop_sequence\":null},\"usage\":{\"output_tokens\":2}}",
            "{\"type\":\"message_stop\"}");

    private static final String OPENAI_SSE = """
            data: {"choices":[{"delta":{"content":"done"}}]}

            data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

            data: [DONE]

            """;

    private HttpServer server;
    private String baseUrl;
    private final AtomicReference<String> received = new AtomicReference<>();

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            String sent = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if ("POST".equals(exchange.getRequestMethod())
                    && (path.endsWith("/chat/completions") || path.endsWith("/messages"))) {
                received.compareAndSet(null, sent);
            }
            String sse;
            if (path.endsWith("/chat/completions")) {
                sse = OPENAI_SSE;
            } else {
                StringBuilder events = new StringBuilder();
                for (String data : ANTHROPIC_SSE) {
                    String name = JSON.readTree(data).get("type").asText();
                    events.append("event: ").append(name).append('\n')
                            .append("data: ").append(data).append("\n\n");
                }
                sse = events.toString();
            }
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

    /**
     * Runs one prompt of a parent that carries the spawn and role tools, the
     * way the browser session registers them, and returns the first body the
     * server received.
     */
    private String firstBody(LlmProvider provider) {
        return firstBody(provider, null);
    }

    private String firstBody(LlmProvider provider, Integer sessionsPerChat) {
        Path cwd = Path.of("/work");
        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(cwd)
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of())
                .webTools(List.of())
                .sessionsPerChat(sessionsPerChat)
                .build());
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        manager.devTools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt(RoleCatalog.BASE_SYSTEM_PROMPT + cwd)
                .registry(registry)
                .cwd(cwd)
                .agentId("main")
                .onPermission(request -> true)
                .sessionsPerChat(sessionsPerChat)
                .build());
        try (EventStream stream = manager.run(parent, "go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(event -> { });
        }
        String body = received.get();
        assertNotNull(body, "premise: the provider posted a request");
        return body;
    }

    private static void compareOrCapture(String name, String body) throws IOException {
        String capture = System.getenv(CAPTURE_ENV);
        if (capture != null && !capture.isBlank()) {
            Path out = Path.of(capture).resolve(name);
            Files.createDirectories(out.getParent());
            Files.writeString(out, body, StandardCharsets.UTF_8);
            return;
        }
        String expected;
        try (InputStream in = SpawnToolsRequestBytesTest.class.getResourceAsStream(
                "/subagents/" + name)) {
            assertNotNull(in, "the v0.14.4 capture " + name + " is not on the test classpath");
            expected = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        assertEquals(expected, body,
                "a chat with no session count set no longer posts what v0.14.4 posted: " + name);
    }

    /** The positive half: with a count set, both spawn tools carry it. */
    private static void assertCarriesTheCount(String body) throws IOException {
        String sentence = "In this chat at most 2 subagents run at the same time;"
                + " further ones wait for a free slot.";
        int carriers = 0;
        for (com.fasterxml.jackson.databind.JsonNode tool : JSON.readTree(body).path("tools")) {
            String name = tool.has("function") ? tool.path("function").path("name").asText()
                    : tool.path("name").asText();
            String description = tool.has("function") ? tool.path("function").path("description").asText()
                    : tool.path("description").asText();
            if (description.contains(sentence)) {
                carriers++;
                org.junit.jupiter.api.Assertions.assertTrue(name.startsWith("spawn_agent"), name);
            }
        }
        assertEquals(2, carriers, "spawn_agent and spawn_agents must both say the count: " + body);
    }

    @Test
    void aChatAtThreeTellsAnthropicTwoHelpersRunAtOnce() throws IOException {
        assertCarriesTheCount(firstBody(
                new AnthropicProvider("claude-opus-4-8", true, "test-key", baseUrl), 3));
    }

    @Test
    void aChatAtThreeTellsOpenAiTwoHelpersRunAtOnce() throws IOException {
        assertCarriesTheCount(firstBody(new OpenAiCompatProvider(
                new OpenAiCompatProvider.Options(baseUrl, "test-model", null)), 3));
    }

    @Test
    void anthropicReceivesTheV0144BodyWhenNoCountIsSet() throws IOException {
        String body = firstBody(new AnthropicProvider("claude-opus-4-8", true, "test-key", baseUrl));
        compareOrCapture("v0.14.4-anthropic-body.json", body);
    }

    @Test
    void openAiReceivesTheV0144BodyWhenNoCountIsSet() throws IOException {
        String body = firstBody(new OpenAiCompatProvider(
                new OpenAiCompatProvider.Options(baseUrl, "test-model", null)));
        compareOrCapture("v0.14.4-openai-body.json", body);
    }
}
