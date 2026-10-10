package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionWindow;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 488: the completion budget each provider adapter puts on the wire,
 * captured from the request bodies a real run sends to a scripted server.
 *
 * <p>The run is the same for all three adapters that send the field
 * (Anthropic {@code max_tokens}, OpenAI-compatible {@code max_tokens},
 * Ollama {@code options.num_predict}): a long system prompt, six tool calls
 * that each return about 4,000 characters, then an answer. The server reports
 * the input of each request as its body length divided by four, so compaction
 * trips the way it would on a real backend that counts like the harness's own
 * estimate.</p>
 *
 * <p>The window reaches each adapter the way it does in a real session:
 * Ollama from {@code /api/ps}, the OpenAI-compatible path from LM Studio's
 * model listing, Anthropic from the session window at 8,192 (no Claude model
 * publishes a window that small) and from the published table at 200,000.</p>
 *
 * <p>At 200,000 every body is compared byte for byte with the body v0.14.4
 * sent for the same request, recorded in
 * {@code completion-budget/v0.14.4-<adapter>-200000.jsonl.gz} (one body per
 * line, captured from v0.14.4's loop on 2026-10-09). At 8,192 no request may
 * ask for more than the window has left after its input, by the server's
 * count: the server counts the JSON framing of each body, which the
 * harness's estimate does not see, and the input reserve has to cover it.</p>
 *
 * <p>With {@code SPECTRO_CAPTURE_DIR} set, every body and a summary line per
 * request are also written there for the card's tables.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CompletionBudgetWireTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String SYSTEM = "You are the agent of a scripted test run. ".repeat(300);
    private static final String PART = "A line of a source file in the scripted test run.\n".repeat(80);
    private static final int TOOL_TURNS = 6;

    @TempDir
    Path dir;

    private HttpServer server;
    private final List<String> bodies = Collections.synchronizedList(new ArrayList<>());

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    @ParameterizedTest(name = "{0} at a window of {1}")
    @CsvSource({
        "anthropic, 8192",
        "openai, 8192",
        "ollama, 8192",
        "anthropic, 200000",
        "openai, 200000",
        "ollama, 200000",
    })
    void theCompletionBudgetOnTheWireFollowsTheWindow(String adapter, int window) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        LlmProvider provider = switch (adapter) {
            case "anthropic" -> anthropic(base);
            case "openai" -> openai(base, window);
            case "ollama" -> ollama(base, window);
            default -> throw new IllegalArgumentException(adapter);
        };
        server.start();

        SessionWindow sessionWindow = new SessionWindow();
        if ("anthropic".equals(adapter) && window == 8_192) {
            sessionWindow.set(8_192);
        }
        ToolRegistry registry = new ToolRegistry();
        registry.register(new Tool() {
            public String name() { return "read_part"; }
            public String description() { return "read the next part"; }
            public JsonNode inputSchema() { return JSON.createObjectNode().put("type", "object"); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return PART; }
        });
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt(SYSTEM)
                .registry(registry)
                .cwd(dir)
                .agentId("main")
                .onPermission(request -> true)
                .maxTurns(20)
                .sessionWindow(sessionWindow)
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("read every part, then answer",
                new RunOptions(new CancelSignal(), List.of()))) {
            stream.forEach(events::add);
        }
        assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.RunEnd end
                        && "end_turn".equals(end.stopReason())),
                "premise: the run reached its answer; events were " + events.stream()
                        .filter(e -> e instanceof RunEvent.ErrorEvent).toList());

        // 70 % of the window is the threshold (CompactionThreshold); the rest
        // is what a completion may use.
        int reserve = window - (int) ((long) window * 7 / 10);
        int adapterCap = "openai".equals(adapter) ? OpenAiCompatProvider.MAX_TOKENS_CAP : Integer.MAX_VALUE;
        int expected = Math.min(adapterCap, Math.min(Agent.DEFAULT_MAX_TOKENS, reserve));

        List<String> lines = new ArrayList<>();
        List<int[]> sentByRequest = new ArrayList<>();
        int oversize = 0;
        int maxOvershoot = 0;
        for (int i = 0; i < bodies.size(); i++) {
            JsonNode body = JSON.readTree(bodies.get(i));
            int sent = completionField(adapter, body);
            boolean summary = !hasTools(body);
            int inputEstimate = inputOf(bodies.get(i));
            boolean over = inputEstimate + sent > window;
            oversize += over ? 1 : 0;
            maxOvershoot = Math.max(maxOvershoot, inputEstimate + sent - window);
            sentByRequest.add(new int[] {sent, summary ? 1 : 0});
            lines.add(String.join("\t", adapter, String.valueOf(window), String.valueOf(i + 1),
                    summary ? "summary" : "turn", String.valueOf(sent), String.valueOf(inputEstimate),
                    String.valueOf(over)));
        }
        // Written before any assertion, so a red run leaves its capture behind.
        capture(adapter, window, lines, oversize, maxOvershoot);

        int turnRequests = 0;
        for (int i = 0; i < sentByRequest.size(); i++) {
            int sent = sentByRequest.get(i)[0];
            if (sentByRequest.get(i)[1] == 0) {
                turnRequests++;
                if (window == 200_000) {
                    assertEquals(expected, sent, "request " + (i + 1) + " of " + adapter
                            + " at a window of " + window + " sent " + sent);
                } else {
                    // Below the threshold the reserve decides; on the turn whose
                    // input passed it, what the window leaves after that input.
                    assertTrue(sent <= expected && sent >= 512, "request " + (i + 1) + " of "
                            + adapter + " at a window of " + window + " sent " + sent);
                }
            } else {
                assertTrue(sent <= reserve, "the summarizer asked for " + sent);
            }
        }
        assertEquals(TOOL_TURNS + 1, turnRequests, "premise: every turn of the script was sent");
        if (window == 8_192) {
            // The input bound reached the wire: on the turn whose input passed
            // the threshold the request asks for less than the reserve.
            assertTrue(sentByRequest.stream().anyMatch(r -> r[1] == 0 && r[0] < expected),
                    "no turn request of " + adapter + " was held below the reserve: " + lines);
            assertEquals(0, oversize, "requests of " + adapter + " whose input by the server's"
                    + " count plus the budget sent exceed 8,192: " + lines);
        } else {
            List<String> recorded = recordedBodies(adapter, window);
            assertEquals(recorded.size(), bodies.size(), "premise: as many requests as v0.14.4 sent");
            for (int i = 0; i < recorded.size(); i++) {
                assertEquals(recorded.get(i), bodies.get(i), "request " + (i + 1) + " of " + adapter
                        + " at a window of " + window + " differs from v0.14.4");
            }
        }
    }

    /** The bodies v0.14.4 sent for this run, one per line, from the test resources. */
    private static List<String> recordedBodies(String adapter, int window) throws IOException {
        String name = "/completion-budget/v0.14.4-" + adapter + "-" + window + ".jsonl.gz";
        try (var in = CompletionBudgetWireTest.class.getResourceAsStream(name)) {
            assertTrue(in != null, "premise: the recorded fixture " + name + " is on the test classpath");
            String text = new String(new java.util.zip.GZIPInputStream(in).readAllBytes(), StandardCharsets.UTF_8);
            return List.of(text.split("\n"));
        }
    }

    private void capture(String adapter, int window, List<String> lines, int oversize, int maxOvershoot)
            throws IOException {
        String target = System.getenv("SPECTRO_CAPTURE_DIR");
        if (target == null || target.isBlank()) {
            return;
        }
        Path out = Path.of(target).resolve(adapter + "-" + window);
        Files.createDirectories(out);
        for (int i = 0; i < bodies.size(); i++) {
            Files.writeString(out.resolve(String.format("%02d.json", i + 1)), bodies.get(i));
        }
        Files.write(Path.of(target).resolve("requests.tsv"), lines,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        Files.writeString(Path.of(target).resolve("oversize.tsv"),
                adapter + "\t" + window + "\t" + bodies.size() + "\t" + oversize + "\t" + maxOvershoot + "\n",
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
    }

    private static int completionField(String adapter, JsonNode body) {
        return switch (adapter) {
            case "anthropic" -> body.path("max_tokens").asInt(-1);
            case "openai" -> body.has("max_tokens") ? body.path("max_tokens").asInt(-1)
                    : body.path("max_completion_tokens").asInt(-1);
            case "ollama" -> body.path("options").path("num_predict").asInt(-1);
            default -> throw new IllegalArgumentException(adapter);
        };
    }

    private static boolean hasTools(JsonNode body) {
        return body.path("tools").isArray() && !body.path("tools").isEmpty();
    }

    /** The number of turn requests (those that carry tools) seen so far, this one included. */
    private int turnNumber(String body) throws IOException {
        int turns = 0;
        for (String seen : List.copyOf(bodies)) {
            if (hasTools(JSON.readTree(seen))) {
                turns++;
            }
        }
        return turns;
    }

    private String record(HttpExchange exchange) throws IOException {
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        bodies.add(body);
        return body;
    }

    private static int inputOf(String body) {
        return (body.getBytes(StandardCharsets.UTF_8).length + 3) / 4;
    }

    private static void send(HttpExchange exchange, String contentType, String payload) throws IOException {
        byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", contentType);
        exchange.sendResponseHeaders(200, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    // ---- Anthropic -------------------------------------------------------------

    private LlmProvider anthropic(String base) {
        server.createContext("/v1/messages", exchange -> {
            String body = record(exchange);
            JsonNode request = JSON.readTree(body);
            int turn = turnNumber(body);
            List<String> data = new ArrayList<>();
            data.add("{\"type\":\"message_start\",\"message\":{\"id\":\"msg_" + bodies.size()
                    + "\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-haiku-4-5\","
                    + "\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,"
                    + "\"usage\":{\"input_tokens\":" + inputOf(body) + ",\"output_tokens\":1}}}");
            String stop;
            if (hasTools(request) && turn <= TOOL_TURNS) {
                data.add("{\"type\":\"content_block_start\",\"index\":0,\"content_block\":"
                        + "{\"type\":\"tool_use\",\"id\":\"toolu_" + turn + "\",\"name\":\"read_part\",\"input\":{}}}");
                data.add("{\"type\":\"content_block_delta\",\"index\":0,\"delta\":"
                        + "{\"type\":\"input_json_delta\",\"partial_json\":\"{}\"}}");
                stop = "tool_use";
            } else {
                String text = hasTools(request) ? "done" : "summary of the earlier parts";
                data.add("{\"type\":\"content_block_start\",\"index\":0,\"content_block\":"
                        + "{\"type\":\"text\",\"text\":\"\"}}");
                data.add("{\"type\":\"content_block_delta\",\"index\":0,\"delta\":"
                        + "{\"type\":\"text_delta\",\"text\":\"" + text + "\"}}");
                stop = "end_turn";
            }
            data.add("{\"type\":\"content_block_stop\",\"index\":0}");
            data.add("{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"" + stop
                    + "\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":5}}");
            data.add("{\"type\":\"message_stop\"}");
            StringBuilder sse = new StringBuilder();
            for (String line : data) {
                sse.append("event: ").append(JSON.readTree(line).get("type").asText()).append('\n')
                        .append("data: ").append(line).append("\n\n");
            }
            send(exchange, "text/event-stream", sse.toString());
        });
        return new AnthropicProvider("claude-haiku-4-5", false, "test-key", base);
    }

    // ---- OpenAI-compatible -----------------------------------------------------

    private LlmProvider openai(String base, int window) {
        server.createContext("/api/v1/models", exchange -> {
            exchange.getRequestBody().readAllBytes();
            send(exchange, "application/json", "{\"models\":[{\"key\":\"test-model\","
                    + "\"loaded_instances\":[{\"id\":\"test-model\",\"config\":{\"context_length\":"
                    + window + "}}]}]}");
        });
        server.createContext("/v1/chat/completions", exchange -> {
            String body = record(exchange);
            JsonNode request = JSON.readTree(body);
            int turn = turnNumber(body);
            String sse;
            if (hasTools(request) && turn <= TOOL_TURNS) {
                sse = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c" + turn
                        + "\",\"function\":{\"name\":\"read_part\",\"arguments\":\"{}\"}}]}}]}\n\n"
                        + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n";
            } else {
                String text = hasTools(request) ? "done" : "summary of the earlier parts";
                sse = "data: {\"choices\":[{\"delta\":{\"content\":\"" + text + "\"}}]}\n\n"
                        + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n";
            }
            sse += "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":" + inputOf(body)
                    + ",\"completion_tokens\":5}}\n\n" + "data: [DONE]\n\n";
            send(exchange, "text/event-stream", sse);
        });
        return new OpenAiCompatProvider(new OpenAiCompatProvider.Options(base, "test-model", null));
    }

    // ---- Ollama ----------------------------------------------------------------

    private LlmProvider ollama(String base, int window) {
        server.createContext("/api/ps", exchange -> {
            exchange.getRequestBody().readAllBytes();
            send(exchange, "application/json", "{\"models\":[{\"name\":\"test-model\","
                    + "\"model\":\"test-model\",\"context_length\":" + window + "}]}");
        });
        server.createContext("/api/chat", exchange -> {
            String body = record(exchange);
            JsonNode request = JSON.readTree(body);
            int turn = turnNumber(body);
            String first;
            if (hasTools(request) && turn <= TOOL_TURNS) {
                first = "{\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":"
                        + "[{\"function\":{\"name\":\"read_part\",\"arguments\":{}}}]},\"done\":false}\n";
            } else {
                String text = hasTools(request) ? "done" : "summary of the earlier parts";
                first = "{\"message\":{\"role\":\"assistant\",\"content\":\"" + text + "\"},\"done\":false}\n";
            }
            String last = "{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,"
                    + "\"prompt_eval_count\":" + inputOf(body) + ",\"eval_count\":5}\n";
            send(exchange, "application/x-ndjson", first + last);
        });
        return new OllamaProvider(new OllamaOptions(base, "test-model"));
    }
}
