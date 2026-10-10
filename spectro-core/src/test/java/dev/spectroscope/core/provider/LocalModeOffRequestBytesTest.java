package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.ToolGroup;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.subagents.RoleCatalog;
import dev.spectroscope.core.subagents.SubagentConfig;
import dev.spectroscope.core.subagents.SubagentManager;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 493, criterion 6: with the Local mode switch off, the {@code tools}
 * array and the system prompt a chat posts to Anthropic and to an
 * OpenAI-compatible server are the ones v0.14.4 posted, byte for byte.
 *
 * <p>The parent carries the standard tools (so {@code read_file} with its
 * read share), the spawn tools and the role tools, as the browser session
 * registers them. The four values the switch writes are handed to the agent
 * the way an open session hands them over once the switch is off and nothing
 * is held: read from the settings files of a folder that sets nothing, through
 * the same setters the session calls at the top of every prompt.</p>
 *
 * <p>The captures in {@code localmode-v0144/} were taken on an export of the
 * v0.14.4 tree ({@code git archive 8d7fcf48}) by the capture class kept in
 * {@code kanban/evidence/493/v0144-capture/}, which builds the same parent
 * with the v0.14.4 API and writes the two fields of each body.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class LocalModeOffRequestBytesTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final List<String> ANTHROPIC_SSE = List.of(
            "{\"type\":\"message_start\",\"message\":{\"id\":\"msg_493\",\"type\":\"message\","
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

    /** The parent of one browser chat, with the switch off and nothing held. */
    private String firstBody(LlmProvider provider, Path emptyFolder) {
        SpectroConfig released = SpectroConfig.load(SpectroConfig.Overrides.none(), emptyFolder);
        Path cwd = Path.of("/work");
        AtomicReference<Set<ToolGroup>> groups = new AtomicReference<>(released.toolGroupsOffSet());
        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(cwd)
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of())
                .webTools(List.of())
                .toolGroupsOff(groups::get)
                .build());
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all(SpectroConfig.DEFAULT_COMMAND_TIMEOUT_SECONDS).forEach(registry::register);
        manager.tools().forEach(registry::register);
        manager.devTools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt(RoleCatalog.BASE_SYSTEM_PROMPT + cwd)
                .registry(registry)
                .cwd(cwd)
                .agentId("main")
                .onPermission(request -> true)
                .toolGroupsOff(groups::get)
                .build());
        // What SessionConnection hands the agent at the top of a prompt once
        // the switch is off and the chat holds nothing.
        parent.setSessionsPerChat(released.sessionsPerChat());
        parent.setCareParagraph(released.careParagraph());
        parent.setReadSharePercent(released.readSharePercent());
        try (EventStream stream = manager.run(parent, "go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(event -> { });
        }
        String body = received.get();
        assertNotNull(body, "premise: the provider posted a request");
        return body;
    }

    private static String fixture(String name) throws IOException {
        try (InputStream in = LocalModeOffRequestBytesTest.class.getResourceAsStream(
                "/localmode-v0144/" + name)) {
            assertNotNull(in, "the v0.14.4 capture " + name + " is not on the test classpath");
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /** The tools array and the system prompt of a body, as the bytes the
     *  provider serialized: one line each, read back out of the body. */
    static String toolsAndSystem(String body) throws IOException {
        JsonNode tree = JSON.readTree(body);
        JsonNode system = tree.has("system") ? tree.get("system") : tree.path("messages").get(0);
        return JSON.writeValueAsString(tree.get("tools")) + "\n" + JSON.writeValueAsString(system) + "\n";
    }

    @Test
    void anthropicReceivesTheV0144ToolsAndSystemPromptWithTheSwitchOff(@TempDir Path folder)
            throws IOException {
        String body = firstBody(new AnthropicProvider("claude-opus-4-8", true, "test-key", baseUrl), folder);
        String sent = toolsAndSystem(body);
        assertTrue(sent.contains("\"read_file\"") && sent.contains("\"spawn_agents\""),
                "premise: the body carries read_file and the spawn tools");
        assertEquals(fixture("anthropic-tools-and-system.txt"), sent);
    }

    @Test
    void openAiReceivesTheV0144ToolsAndSystemPromptWithTheSwitchOff(@TempDir Path folder)
            throws IOException {
        String body = firstBody(new OpenAiCompatProvider(
                new OpenAiCompatProvider.Options(baseUrl, "test-model", null)), folder);
        String sent = toolsAndSystem(body);
        assertTrue(sent.contains("\"read_file\"") && sent.contains("\"spawn_agents\""),
                "premise: the body carries read_file and the spawn tools");
        assertEquals(fixture("openai-tools-and-system.txt"), sent);
    }

    /** The positive half: the same parent with the switch's values set posts
     *  something else, so the comparison above can tell the two apart. */
    @Test
    void theSwitchsValuesChangeTheBody(@TempDir Path folder) throws IOException {
        SpectroConfig released = SpectroConfig.load(SpectroConfig.Overrides.none(), folder);
        assertEquals(null, released.sessionsPerChat(), "premise: the folder sets nothing");
        String plain = toolsAndSystem(firstBody(
                new AnthropicProvider("claude-opus-4-8", true, "test-key", baseUrl), folder));
        Files.createDirectories(folder.resolve(".spectro"));
        Files.writeString(folder.resolve(SpectroConfig.PROJECT_SETTINGS),
                "{ \"readSharePercent\": 10, \"careParagraph\": \"on\", \"sessionsPerChat\": 3 }");
        received.set(null);
        String local = toolsAndSystem(firstBody(
                new AnthropicProvider("claude-opus-4-8", true, "test-key", baseUrl), folder));
        assertTrue(local.contains("fits 10 %"), local);
        assertTrue(local.contains("Work in small steps."), local);
        assertTrue(!plain.equals(local), "the switch's values left the body as it was");
    }
}
