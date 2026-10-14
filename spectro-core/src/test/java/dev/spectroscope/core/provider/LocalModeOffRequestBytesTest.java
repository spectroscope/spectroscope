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
 *
 * <p>Card 601 changed the two spawn descriptions on purpose. Every read of a
 * v0.14.4 capture applies exactly that change ({@link Card601SpawnTexts}); the
 * messaging-on baseline was captured again after it.</p>
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
        // Card 503: the two messaging tools, registered where the session
        // registers them, after the spawn and role tools.
        dev.spectroscope.core.messaging.MessagingTools.forSeat(new dev.spectroscope.core.messaging.SessionSeat(
                () -> null, () -> "s", () -> manager, () -> true, "main")).forEach(registry::register);
        // Card 505: wait_agents after the two messaging tools, and the parent's
        // inbox wired to the agent and the manager, as the session does both.
        manager.backgroundTools().forEach(registry::register);
        dev.spectroscope.core.peer.PeerInbox inbox = new dev.spectroscope.core.peer.PeerInbox();
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt(RoleCatalog.BASE_SYSTEM_PROMPT + cwd)
                .registry(registry)
                .cwd(cwd)
                .agentId("main")
                .onPermission(request -> true)
                .toolGroupsOff(groups::get)
                .peerInbox(inbox)
                .build());
        manager.parentInbox(inbox);
        // What SessionConnection hands the agent at the top of a prompt once
        // the switch is off and the chat holds nothing.
        parent.setSessionsPerChat(released.sessionsPerChat());
        parent.setCareParagraph(released.careParagraph());
        parent.setReadSharePercent(released.readSharePercent());
        parent.setAgentMessaging(released.agentMessaging());
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
            // Card 601 changed the two spawn descriptions on purpose, and only those.
            return Card601SpawnTexts.applied(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    /** The tools array and the system prompt of a body, as the bytes the
     *  provider serialized: one line each, read back out of the body. */
    static String toolsAndSystem(String body) throws IOException {
        JsonNode tree = JSON.readTree(body);
        JsonNode system = tree.has("system") ? tree.get("system") : tree.path("messages").get(0);
        return JSON.writeValueAsString(tree.get("tools")) + "\n" + JSON.writeValueAsString(system) + "\n";
    }

    /** Card 503, owner decision 9 in its provisional form: the fixture's
     *  folder sets agentMessaging false, so this test proves v0.14.4 bytes
     *  with messaging off, not for a default installation. */
    private static void messagingOff(Path folder) throws IOException {
        Files.createDirectories(folder.resolve(".spectro"));
        Files.writeString(folder.resolve(SpectroConfig.PROJECT_SETTINGS), "{ \"agentMessaging\": false }");
    }

    @Test
    void anthropicReceivesTheV0144ToolsAndSystemPromptWithTheSwitchOff(@TempDir Path folder)
            throws IOException {
        messagingOff(folder);
        String body = firstBody(new AnthropicProvider("claude-opus-4-8", true, "test-key", baseUrl), folder);
        String sent = toolsAndSystem(body);
        assertTrue(sent.contains("\"read_file\"") && sent.contains("\"spawn_agents\""),
                "premise: the body carries read_file and the spawn tools");
        assertEquals(fixture("anthropic-tools-and-system.txt"), sent);
    }

    @Test
    void openAiReceivesTheV0144ToolsAndSystemPromptWithTheSwitchOff(@TempDir Path folder)
            throws IOException {
        messagingOff(folder);
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
        messagingOff(folder);
        SpectroConfig released = SpectroConfig.load(SpectroConfig.Overrides.none(), folder);
        assertEquals(null, released.sessionsPerChat(), "premise: the folder sets nothing else");
        String plain = toolsAndSystem(firstBody(
                new AnthropicProvider("claude-opus-4-8", true, "test-key", baseUrl), folder));
        Files.createDirectories(folder.resolve(".spectro"));
        Files.writeString(folder.resolve(SpectroConfig.PROJECT_SETTINGS),
                "{ \"readSharePercent\": 10, \"careParagraph\": \"on\", \"sessionsPerChat\": 3,"
                        + " \"agentMessaging\": false }");
        received.set(null);
        String local = toolsAndSystem(firstBody(
                new AnthropicProvider("claude-opus-4-8", true, "test-key", baseUrl), folder));
        assertTrue(local.contains("fits 10 %"), local);
        assertTrue(local.contains("Work in small steps."), local);
        assertTrue(!plain.equals(local), "the switch's values left the body as it was");
    }

    // ── card 503: the second capture, with the key on ─────────────────────

    /** Where a capture run writes the messaging-on baseline instead of comparing. */
    private static final String CAPTURE_ON_ENV = "SPECTRO_CAPTURE_MESSAGING_ON";
    /** Where the measured size of the two definitions is written, when set. */
    private static final String SIZE_OUT_ENV = "SPECTRO_MESSAGING_SIZE_OUT";

    private static String fixtureOn(String name, String sent) throws IOException {
        String capture = System.getenv(CAPTURE_ON_ENV);
        if (capture != null && !capture.isBlank()) {
            Path out = Path.of(capture).resolve(name);
            Files.createDirectories(out.getParent());
            Files.writeString(out, sent, StandardCharsets.UTF_8);
            return sent;
        }
        try (InputStream in = LocalModeOffRequestBytesTest.class.getResourceAsStream("/messaging-on/" + name)) {
            assertNotNull(in, "the messaging-on capture " + name + " is not on the test classpath");
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static com.fasterxml.jackson.databind.node.ArrayNode withoutCacheMarks(JsonNode tools) {
        com.fasterxml.jackson.databind.node.ArrayNode out = JSON.createArrayNode();
        for (JsonNode tool : tools) {
            com.fasterxml.jackson.databind.node.ObjectNode copy = tool.deepCopy();
            copy.remove("cache_control");
            out.add(copy);
        }
        return out;
    }

    private static String nameOf(JsonNode tool) {
        return tool.has("function") ? tool.path("function").path("name").asText() : tool.path("name").asText();
    }

    /** A copy of a spawn_agents definition without what card 505 adds: the
     *  {@code background} field and the sentence about it. */
    private static JsonNode withoutBackground(JsonNode tool) {
        com.fasterxml.jackson.databind.node.ObjectNode copy = tool.deepCopy();
        com.fasterxml.jackson.databind.node.ObjectNode body = copy.has("function")
                ? (com.fasterxml.jackson.databind.node.ObjectNode) copy.get("function") : copy;
        String schemaKey = body.has("parameters") ? "parameters" : "input_schema";
        ((com.fasterxml.jackson.databind.node.ObjectNode) body.get(schemaKey).get("properties")).remove("background");
        String description = body.path("description").asText();
        body.put("description", description.replace(SubagentManager.BACKGROUND_SENTENCE, ""));
        return copy;
    }

    private static boolean offersBackground(JsonNode tool) {
        JsonNode body = tool.has("function") ? tool.get("function") : tool;
        JsonNode schema = body.has("parameters") ? body.get("parameters") : body.get("input_schema");
        return schema.path("properties").has("background")
                && body.path("description").asText().contains(SubagentManager.BACKGROUND_SENTENCE);
    }

    /** The on body is the v0.14.4 capture plus the three messaging definitions
     *  (card 503's two and card 505's wait_agents) and the background field
     *  on spawn_agents, and it is the new baseline for a default installation. */
    private void theKeyOnAddsTheMessagingDefinitionsAndTheBackgroundField(LlmProvider provider, String capture,
                                                                         String provName, Path folder)
            throws IOException {
        String on = toolsAndSystem(firstBody(provider, folder));
        String[] onLines = on.split("\n");
        String[] v0144 = fixture(capture).split("\n");
        assertEquals(v0144[1], onLines[1], "the system prompt does not move");
        JsonNode onTools = JSON.readTree(onLines[0]);
        JsonNode offTools = JSON.readTree(v0144[0]);
        com.fasterxml.jackson.databind.node.ArrayNode expected = withoutCacheMarks(offTools);
        com.fasterxml.jackson.databind.node.ArrayNode actual = withoutCacheMarks(onTools);
        assertEquals(offTools.size() + 3, onTools.size(), "three definitions more");
        assertEquals("send_message", nameOf(onTools.get(onTools.size() - 3)));
        assertEquals("list_agents", nameOf(onTools.get(onTools.size() - 2)));
        assertEquals("wait_agents", nameOf(onTools.get(onTools.size() - 1)));
        com.fasterxml.jackson.databind.node.ArrayNode head = JSON.createArrayNode();
        int spawnAgents = -1;
        for (int i = 0; i < offTools.size(); i++) {
            if ("spawn_agents".equals(nameOf(actual.get(i)))) {
                spawnAgents = i;
                assertTrue(offersBackground(actual.get(i)), "spawn_agents offers background with the key on");
                head.add(withoutBackground(actual.get(i)));
            } else {
                head.add(actual.get(i));
            }
        }
        assertTrue(spawnAgents >= 0, "premise: the body carries spawn_agents");
        assertEquals(expected, head, "every v0.14.4 definition is unchanged in its place, but for background");
        assertEquals(fixtureOn(capture, on), on, "the messaging-on baseline");
        // Card 503's bound holds for its two definitions, measured on them alone.
        int pair = JSON.writeValueAsString(actual.get(onTools.size() - 3)).length()
                + JSON.writeValueAsString(actual.get(onTools.size() - 2)).length() + 2;
        assertTrue(pair > 0 && pair <= 1_200, "the two messaging definitions add " + pair + " characters");
        int added = onLines[0].length() - v0144[0].length();
        String sizeOut = System.getenv(SIZE_OUT_ENV);
        if (sizeOut != null && !sizeOut.isBlank()) {
            Files.writeString(Path.of(sizeOut), provName + " messaging_pair_chars=" + pair + " added_chars="
                    + added + " tools_off_chars=" + v0144[0].length() + " tools_on_chars=" + onLines[0].length()
                    + "\n", StandardCharsets.UTF_8, java.nio.file.StandardOpenOption.CREATE,
                    java.nio.file.StandardOpenOption.APPEND);
        }
    }

    @Test
    void anthropicWithTheKeyOnCarriesTheMessagingDefinitionsAndTheBackgroundField(@TempDir Path folder)
            throws IOException {
        theKeyOnAddsTheMessagingDefinitionsAndTheBackgroundField(new AnthropicProvider("claude-opus-4-8", true, "test-key", baseUrl),
                "anthropic-tools-and-system.txt", "anthropic", folder);
    }

    @Test
    void openAiWithTheKeyOnCarriesTheMessagingDefinitionsAndTheBackgroundField(@TempDir Path folder)
            throws IOException {
        theKeyOnAddsTheMessagingDefinitionsAndTheBackgroundField(new OpenAiCompatProvider(
                new OpenAiCompatProvider.Options(baseUrl, "test-model", null)),
                "openai-tools-and-system.txt", "openai", folder);
    }
}
