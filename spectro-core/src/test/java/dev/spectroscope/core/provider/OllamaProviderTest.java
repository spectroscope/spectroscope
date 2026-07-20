package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.provider.LlmProvider.ImageContent;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.PThinkingDelta;
import dev.spectroscope.core.provider.LlmProvider.PToolCall;
import dev.spectroscope.core.provider.LlmProvider.PUsage;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The Ollama wire mapping, proven against a scripted local HTTP server —
 * no Ollama install needed. Covers the NDJSON translation (deltas, generated
 * call ids, usage from the final chunk), the request mapping (system message
 * first, role:"tool" results), and the declarative version probe.
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class OllamaProviderTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private HttpServer server;
    private String baseUrl;
    private final AtomicReference<String> lastChatBody = new AtomicReference<>();
    private volatile String scriptedNdjson = "";
    private volatile int scriptedStatus = 200;         // 4xx to exercise the error path
    private volatile String scriptedErrorBody = "";    // the body served with a non-200 status
    /** Scripted /api/show body; null = 404 (older Ollama without the endpoint). */
    private volatile String scriptedShowJson = null;

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/chat", exchange -> {
            lastChatBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            if (scriptedStatus != 200) {
                byte[] error = scriptedErrorBody.getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(scriptedStatus, error.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(error);
                }
                return;
            }
            byte[] body = scriptedNdjson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.createContext("/api/version", exchange -> {
            byte[] body = "{\"version\":\"0.9.9\"}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        // the vision capability probe. null scriptedShowJson answers 404,
        // exactly like an older Ollama without /api/show.
        server.createContext("/api/show", exchange -> {
            String scripted = scriptedShowJson;
            byte[] body = (scripted != null ? scripted : "{}").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(scripted != null ? 200 : 404, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    private OllamaProvider provider() {
        return new OllamaProvider(new OllamaOptions(baseUrl, "qwen3"));
    }

    private static ProviderRequest request(List<ProviderMessage> messages) {
        return new ProviderRequest("You are a test.", messages, List.of(), 500, new CancelSignal());
    }

    private static ProviderRequest thinkingRequest(List<ProviderMessage> messages) {
        return new ProviderRequest("You are a test.", messages, List.of(), 500, true, new CancelSignal());
    }

    private static List<ProviderMessage> oneUser(String text) {
        return List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent(text))));
    }

    private List<ProviderEvent> collect(ProviderRequest request) {
        List<ProviderEvent> events = new ArrayList<>();
        provider().stream(request).forEach(events::add);
        return events;
    }

    @Test
    void translatesDeltasUsageAndStopFromTheNdjsonStream() {
        scriptedNdjson = """
                {"message":{"content":"Hel"},"done":false}
                {"message":{"content":"lo"},"done":false}
                {"message":{"content":""},"done":true,"prompt_eval_count":42,"eval_count":7}
                """;
        List<ProviderEvent> events = collect(request(List.of(
                new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("Say Hello."))))));

        assertEquals(new PTextDelta("Hel"), events.get(0));
        assertEquals(new PTextDelta("lo"), events.get(1));
        assertEquals(new PUsage(42, 7), events.get(2));
        assertEquals(new PStop(PStop.StopReason.END_TURN), events.get(3));
    }

    @Test
    void mapsToolCallsAndGeneratesCallIds() {
        scriptedNdjson = """
                {"message":{"content":"","tool_calls":[{"function":{"name":"list_dir","arguments":{"path":"."}}}]},"done":false}
                {"message":{"content":""},"done":true,"prompt_eval_count":10,"eval_count":2}
                """;
        List<ProviderEvent> events = collect(request(List.of(
                new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("List files."))))));

        PToolCall call = assertInstanceOf(PToolCall.class, events.getFirst());
        assertEquals("list_dir", call.name());
        assertTrue(call.callId().startsWith("ollama-call-"), "Ollama sends no ids — we generate them");
        assertEquals(".", call.input().path("path").asText());
        assertEquals(new PStop(PStop.StopReason.TOOL_USE), events.getLast(),
                "a turn with tool calls must stop with TOOL_USE");
    }

    @Test
    void stringifiedToolArgumentsAreParsedIntoJson() {
        scriptedNdjson = """
                {"message":{"content":"","tool_calls":[{"function":{"name":"read_file","arguments":"{\\"path\\":\\"pom.xml\\"}"}}]},"done":true}
                """;
        List<ProviderEvent> events = collect(request(List.of(
                new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("Read it."))))));

        PToolCall call = assertInstanceOf(PToolCall.class, events.getFirst());
        assertEquals("pom.xml", call.input().path("path").asText(),
                "string arguments must be parsed, never string-matched");
    }

    @Test
    void requestCarriesSystemFirstAndToolResultsAsToolRole() throws IOException {
        scriptedNdjson = """
                {"message":{"content":"ok"},"done":true}
                """;
        collect(request(List.of(
                new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("Run ls"))),
                new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent("Running"))),
                new ProviderMessage(ProviderMessage.Role.USER,
                        List.of(new ToolResultContent("c1", "ERROR: denied", true))))));

        JsonNode sent = JSON.readTree(lastChatBody.get());
        assertEquals("qwen3", sent.get("model").asText());
        assertTrue(sent.get("stream").asBoolean());
        JsonNode messages = sent.get("messages");
        assertEquals("system", messages.get(0).get("role").asText());
        assertEquals("user", messages.get(1).get("role").asText());
        assertEquals("assistant", messages.get(2).get("role").asText());
        assertEquals("tool", messages.get(3).get("role").asText(),
                "tool results travel as role:\"tool\" messages");
        assertEquals("ERROR: denied", messages.get(3).get("content").asText());
        assertEquals(500, sent.get("options").get("num_predict").asInt());
    }

    @Test
    void nativeThinkingFieldBecomesThinkingDeltasBeforeTheAnswer() {
        // gpt-oss / qwen3 stream reasoning in message.thinking while content is empty,
        // then fill content for the answer.
        scriptedNdjson = """
                {"message":{"content":"","thinking":"Let me "},"done":false}
                {"message":{"content":"","thinking":"add."},"done":false}
                {"message":{"content":"42"},"done":false}
                {"message":{"content":""},"done":true,"prompt_eval_count":9,"eval_count":3}
                """;
        List<ProviderEvent> events = collect(thinkingRequest(oneUser("What is 17+25?")));

        assertEquals(new PThinkingDelta("Let me "), events.get(0));
        assertEquals(new PThinkingDelta("add."), events.get(1));
        assertEquals(new PTextDelta("42"), events.get(2));
        assertEquals(new PUsage(9, 3), events.get(3));
        assertEquals(new PStop(PStop.StopReason.END_TURN), events.get(4));
    }

    @Test
    void inlineThinkTagsAreSplitEvenAcrossAChunkBoundary() {
        // Some models inline <think>…</think> in content. The closing tag lands split
        // across two chunks ("</thi" + "nk>") — the splitter must still separate them.
        scriptedNdjson = """
                {"message":{"content":"<think>reason"},"done":false}
                {"message":{"content":"ing</thi"},"done":false}
                {"message":{"content":"nk>answer"},"done":true,"prompt_eval_count":4,"eval_count":2}
                """;
        List<ProviderEvent> events = collect(request(oneUser("Hi")));

        String thinking = events.stream()
                .filter(PThinkingDelta.class::isInstance)
                .map(e -> ((PThinkingDelta) e).text())
                .reduce("", String::concat);
        String answer = events.stream()
                .filter(PTextDelta.class::isInstance)
                .map(e -> ((PTextDelta) e).text())
                .reduce("", String::concat);
        assertEquals("reasoning", thinking, "inner text becomes thinking");
        assertEquals("answer", answer, "outer text becomes the answer");
    }

    @Test
    void thinkTrueIsSentInTheRequestBodyWhenThinkingIsEnabled() throws IOException {
        scriptedNdjson = """
                {"message":{"content":"ok"},"done":true}
                """;
        collect(thinkingRequest(oneUser("Think, please.")));
        JsonNode sent = JSON.readTree(lastChatBody.get());
        assertTrue(sent.get("think").asBoolean(), "think:true must be posted when thinking is on");

        // And it must be absent when thinking is off (no coercion on unwilling models).
        collect(request(oneUser("No thinking.")));
        JsonNode plain = JSON.readTree(lastChatBody.get());
        assertTrue(plain.get("think") == null || plain.get("think").isNull(),
                "think must be omitted when thinking is off");
    }

    @Test
    void a4xxMentioningThinkingBecomesAReadableError() {
        scriptedStatus = 400;
        scriptedErrorBody = "{\"error\":\"\\\"think\\\" is not supported by this model\"}";
        RuntimeException error = assertThrows(RuntimeException.class,
                () -> collect(thinkingRequest(oneUser("Reason about this."))));
        assertTrue(error.getMessage().contains("does not support"),
                "the error must explain the model does not support thinking");
        assertTrue(error.getMessage().contains("SPECTRO_THINKING=0"),
                "the error must point at the way to disable thinking");
    }

    @Test
    void theDeclarativeVersionProbeWorks() {
        assertEquals("0.9.9", provider().serverVersion().orElseThrow());
    }

    @Test
    void anUnreachableServerYieldsAnEmptyVersion() {
        OllamaProvider dead = new OllamaProvider(
                new OllamaOptions("http://127.0.0.1:1", "qwen3"));
        assertTrue(dead.serverVersion().isEmpty());
    }

    // ---- vision ---------------------------------------------------

    private static ProviderRequest imageRequest() {
        return request(List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(
                new ImageContent("image/png", "aWJt"),
                new TextContent("What is in this image?")))));
    }

    @Test
    void imagesTravelAsABase64ArrayOnTheUserMessage() throws IOException {
        scriptedShowJson = "{\"capabilities\":[\"completion\",\"vision\"]}";
        scriptedNdjson = """
                {"message":{"content":"A logo."},"done":true,"prompt_eval_count":9,"eval_count":2}
                """;
        collect(imageRequest());

        JsonNode sent = JSON.readTree(lastChatBody.get());
        JsonNode userMessage = sent.get("messages").get(1); // 0 = system
        assertEquals("user", userMessage.get("role").asText());
        assertEquals("What is in this image?", userMessage.get("content").asText());
        JsonNode images = userMessage.get("images");
        assertTrue(images != null && images.isArray() && images.size() == 1,
                "the chat API expects an images array on the user message");
        assertEquals("aWJt", images.get(0).asText(),
                "raw base64 — never a data: URL prefix");
        assertTrue(sent.get("messages").get(0).get("images") == null,
                "the system message never carries images");
    }

    @Test
    void documentsFailFastWithAReadableMessage() {
        // Ollama's chat API has no document channel — a silent drop would let
        // the model hallucinate over a PDF it never saw. Fail fast, readably.
        ProviderRequest withPdf = request(List.of(new ProviderMessage(
                ProviderMessage.Role.USER, List.of(
                        new LlmProvider.DocumentContent("application/pdf", "UERGQllURVM=", "paper.pdf"),
                        new TextContent("Summarize.")))));

        IllegalStateException failure = org.junit.jupiter.api.Assertions.assertThrows(
                IllegalStateException.class, () -> collect(withPdf));
        assertTrue(failure.getMessage().contains("document"),
                "names the problem, got: " + failure.getMessage());
        assertTrue(failure.getMessage().contains("anthropic") || failure.getMessage().contains("openai"),
                "points at a provider that can, got: " + failure.getMessage());
    }

    @Test
    void aTextOnlyModelFailsFastWithAReadableError() {
        scriptedShowJson = "{\"capabilities\":[\"completion\",\"tools\"]}"; // no "vision"
        IllegalStateException rejected = assertThrows(IllegalStateException.class,
                () -> collect(imageRequest()));
        assertTrue(rejected.getMessage().startsWith("Model without vision"),
                "the error must name the problem, got: " + rejected.getMessage());
        assertTrue(rejected.getMessage().contains("qwen3-vl"),
                "the error must point at a vision model to pull");
        assertEquals(null, lastChatBody.get(),
                "the image must never be dropped silently — no chat call happened");
    }

    @Test
    void anOlderOllamaWithoutCapabilitiesDoesNotBlockVisionRequests() throws IOException {
        scriptedShowJson = null; // /api/show answers 404 — best effort: do not block
        scriptedNdjson = """
                {"message":{"content":"ok"},"done":true}
                """;
        collect(imageRequest());
        JsonNode sent = JSON.readTree(lastChatBody.get());
        assertEquals(1, sent.get("messages").get(1).get("images").size());
    }

    @Test
    void aChatLevel400WithImagesIsSharpenedToTheVisionError() {
        scriptedShowJson = null;   // capability check fails open ...
        scriptedStatus = 400;      // ... but the chat call rejects the request
        scriptedErrorBody = "{\"error\":\"this model does not support images\"}";

        IllegalStateException rejected = assertThrows(IllegalStateException.class,
                () -> collect(imageRequest()));
        assertTrue(rejected.getMessage().startsWith("Model without vision"));
    }

    @Test
    void textOnlyRequestsSkipTheCapabilityProbe() {
        scriptedShowJson = "{\"capabilities\":[\"completion\"]}"; // would reject images
        scriptedNdjson = """
                {"message":{"content":"plain"},"done":true}
                """;
        List<ProviderEvent> events = collect(request(List.of(
                new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("hi"))))));
        assertEquals(new PTextDelta("plain"), events.getFirst(),
                "text-only traffic must not pay the vision check");
    }

    @Test
    void aRetryableStatusBecomesATransientProviderException() {
        scriptedStatus = 503;
        scriptedErrorBody = "{\"error\":\"server busy\"}";
        TransientProviderException transient_ = assertThrows(TransientProviderException.class,
                () -> collect(request(oneUser("Hello."))));
        assertTrue(transient_.getMessage().contains("503"),
                "the transient error must carry the status, got: " + transient_.getMessage());
    }

    @Test
    void aTerminalBadRequestStaysNonTransient() {
        scriptedStatus = 400;
        scriptedErrorBody = "{\"error\":\"malformed request\"}";
        RuntimeException error = assertThrows(RuntimeException.class,
                () -> collect(request(oneUser("Hello."))));
        assertFalse(error instanceof TransientProviderException,
                "a plain 400 must not be classified as retryable");
        assertFalse(RetryPolicy.from(2).isTransient(error),
                "the retry layer must not re-send a terminal status");
        assertTrue(error.getMessage().contains("400"));
    }
}
