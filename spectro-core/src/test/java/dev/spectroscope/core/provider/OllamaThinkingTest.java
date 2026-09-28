package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.provider.LlmProvider.ImageContent;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest.Reasoning;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 447: a model that cannot think runs anyway, whatever the thinking
 * setting says.
 *
 * <p>The owner's run on {@code qwen2.5:7b} ended at once because the global
 * {@code thinking: true} became {@code think: true} on the wire, and ollama
 * 0.32.1 answers that with {@code 400 {"error":"\"qwen2.5:7b\" does not
 * support thinking"}} (measured 2026-09-26 against the machine's ollama; the
 * same model answers 200 with the field omitted or set to false). Each test
 * here runs against a scripted ollama and reads what was POSTED: the
 * {@code /api/show} capability list, the refusal and the retry are all wire
 * facts.</p>
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS)
class OllamaThinkingTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    /** Ollama's refusal as measured, with {@code {model}} standing for the
     *  model id the request named: ollama echoes the requested id in its error
     *  text, and the scripted server does the same. */
    private static final String REFUSAL = "{\"error\":\"\\\"{model}\\\" does not support thinking\"}";
    private static final String ANSWER = """
            {"message":{"content":"Hallo!"},"done":false}
            {"message":{"content":""},"done":true,"prompt_eval_count":31,"eval_count":2}
            """;

    private HttpServer server;
    private String baseUrl;

    /** Every /api/chat body the server received, in order. */
    private final List<String> chatBodies = Collections.synchronizedList(new ArrayList<>());
    /** Scripted answers for /api/chat, one per request; the last one repeats. */
    private final ConcurrentLinkedDeque<Scripted> chatAnswers = new ConcurrentLinkedDeque<>();
    /** Scripted /api/show body; null answers 404. */
    private volatile String showJson;
    private final AtomicInteger showCalls = new AtomicInteger();

    private record Scripted(int status, String body) {}

    @BeforeEach
    void scriptedOllama() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/chat", exchange -> {
            String posted = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            chatBodies.add(posted);
            Scripted answer = chatAnswers.size() > 1 ? chatAnswers.pollFirst() : chatAnswers.peekFirst();
            String model = JSON.readTree(posted).path("model").asText();
            byte[] body = answer.body().replace("{model}", model).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type",
                    answer.status() == 200 ? "application/x-ndjson" : "application/json");
            exchange.sendResponseHeaders(answer.status(), body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.createContext("/api/show", exchange -> {
            exchange.getRequestBody().readAllBytes();
            showCalls.incrementAndGet();
            String scripted = showJson;
            byte[] body = (scripted != null ? scripted : "{\"error\":\"not found\"}")
                    .getBytes(StandardCharsets.UTF_8);
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
    void stop() {
        server.stop(0);
    }

    private void answer(int status, String body) {
        chatAnswers.addLast(new Scripted(status, body));
    }

    private OllamaProvider provider(String model) {
        return new OllamaProvider(new OllamaOptions(baseUrl, model));
    }

    private static List<ProviderMessage> oneUser(String text) {
        return List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent(text))));
    }

    private static ProviderRequest request(Reasoning mode, String effort) {
        return new ProviderRequest("sys", oneUser("hallo"), List.of(), 512, mode, effort,
                new CancelSignal());
    }

    private static ProviderRequest imageRequest(Reasoning mode) {
        return new ProviderRequest("sys", List.of(new ProviderMessage(ProviderMessage.Role.USER,
                List.of(new ImageContent("image/png", "aWJt"), new TextContent("what is this?")))),
                List.of(), 512, mode, null, new CancelSignal());
    }

    /** The refusal ollama sends for a request that names {@code model}. */
    private static String refusalFor(String model) {
        return REFUSAL.replace("{model}", model);
    }

    private static List<ProviderEvent> drain(OllamaProvider provider, ProviderRequest request) {
        List<ProviderEvent> events = new ArrayList<>();
        provider.stream(request).forEach(events::add);
        return events;
    }

    private JsonNode chatBody(int index) throws IOException {
        return JSON.readTree(chatBodies.get(index));
    }

    private static String text(List<ProviderEvent> events) {
        StringBuilder out = new StringBuilder();
        events.stream().filter(PTextDelta.class::isInstance)
                .forEach(event -> out.append(((PTextDelta) event).text()));
        return out.toString();
    }

    // ---- criterion 1 and 2: known from the capability --------------------

    @Test
    void reasoningOnSendsNoThinkToAModelWhoseShowListsNoThinking() throws IOException {
        showJson = "{\"capabilities\":[\"completion\",\"tools\"]}";
        answer(200, ANSWER);

        List<ProviderEvent> events = drain(provider("qwen2.5:7b"), request(Reasoning.ON, null));

        assertNull(chatBody(0).get("think"),
                "a model whose /api/show lacks \"thinking\" must not get think: " + chatBodies.get(0));
        assertEquals("Hallo!", text(events), "and the run answers");
        assertEquals(1, chatBodies.size(), "no refusal, no retry");
    }

    @Test
    void anEffortLevelIsWithheldFromAModelThatCannotThinkEvenWhenItsFamilyRowTakesLevels() throws IOException {
        // qwen3-coder matches the qwen3 row of the table (levels on the think
        // field), while ollama reports no "thinking" for it. The server's answer
        // outranks the family guess, the same order the picker's overlay uses.
        showJson = "{\"capabilities\":[\"completion\",\"tools\"]}";
        answer(200, ANSWER);

        drain(provider("qwen3-coder:30b"), request(Reasoning.ON, "high"));

        assertNull(chatBody(0).get("think"), "a level asks for thinking too: " + chatBodies.get(0));
    }

    @Test
    void aModelWhoseShowListsThinkingStillGetsThinkTrue() throws IOException {
        showJson = "{\"capabilities\":[\"completion\",\"tools\",\"thinking\"]}";
        answer(200, ANSWER);

        drain(provider("glm-5.3:cloud"), request(Reasoning.ON, null));

        JsonNode think = chatBody(0).get("think");
        assertNotNull(think, "a model that can think keeps the field: " + chatBodies.get(0));
        assertTrue(think.isBoolean() && think.asBoolean());
    }

    @Test
    void theShowQuestionIsAskedOnceForTheLifeOfTheProvider() {
        showJson = "{\"capabilities\":[\"completion\",\"tools\"]}";
        answer(200, ANSWER);
        OllamaProvider provider = provider("qwen2.5:7b");

        drain(provider, request(Reasoning.ON, null));
        drain(provider, request(Reasoning.ON, null));

        assertEquals(1, showCalls.get(), "one /api/show for two requests");
        assertEquals(2, chatBodies.size());
    }

    @Test
    void offAndDefaultNeverAskTheShowRouteAndOffStillSendsThinkFalse() throws IOException {
        showJson = "{\"capabilities\":[\"completion\",\"tools\"]}";
        answer(200, ANSWER);
        OllamaProvider provider = provider("qwen2.5:7b");

        drain(provider, request(Reasoning.OFF, null));
        drain(provider, request(Reasoning.DEFAULT, null));

        assertEquals(0, showCalls.get(), "only a request that asks for thinking pays the question");
        JsonNode off = chatBody(0).get("think");
        assertNotNull(off, "OFF keeps its explicit switch: " + chatBodies.get(0));
        assertFalse(off.asBoolean());
        assertNull(chatBody(1).get("think"));
    }

    @Test
    void theShowAnswerIsReadForThinkingOnlyWhenItListsSomething() throws IOException {
        assertEquals(OllamaProvider.Thinking.CANNOT, OllamaProvider.thinkingFrom(
                JSON.readTree("{\"capabilities\":[\"completion\",\"tools\"]}")));
        assertEquals(OllamaProvider.Thinking.THINKS, OllamaProvider.thinkingFrom(
                JSON.readTree("{\"capabilities\":[\"completion\",\"thinking\",\"tools\"]}")));
        // No list, or an empty one, states no fact: the request keeps its field
        // and the refusal path is the safety net.
        assertEquals(OllamaProvider.Thinking.UNKNOWN, OllamaProvider.thinkingFrom(
                JSON.readTree("{\"capabilities\":[]}")));
        assertEquals(OllamaProvider.Thinking.UNKNOWN, OllamaProvider.thinkingFrom(
                JSON.readTree("{\"license\":\"x\"}")));
        assertEquals(OllamaProvider.Thinking.UNKNOWN, OllamaProvider.thinkingFrom(null));
    }

    // ---- criterion 3: learned from a refusal -----------------------------

    @Test
    void aThinkingRefusalIsSentOnceMoreWithoutThinkAndTheAnswerArrives() throws IOException {
        showJson = null; // /api/show says nothing: the refusal is the only fact there is
        answer(400, REFUSAL);
        answer(200, ANSWER);
        OllamaProvider provider = provider("qwen2.5:7b");

        List<ProviderEvent> events = drain(provider, request(Reasoning.ON, null));

        assertEquals("Hallo!", text(events), "the run ends with the text, not with an error");
        assertEquals(new PStop(PStop.StopReason.END_TURN), events.getLast());
        assertEquals(2, chatBodies.size(), "the refused request and its retry");
        assertTrue(chatBody(0).path("think").asBoolean(false), "the first request asked to think");
        assertNull(chatBody(1).get("think"), "the retry carries no think: " + chatBodies.get(1));

        // Remembered for the rest of the provider's life: the next request goes
        // out without think at once, and nothing is refused or retried.
        drain(provider, request(Reasoning.ON, null));
        assertEquals(3, chatBodies.size());
        assertNull(chatBody(2).get("think"), "later requests carry no think: " + chatBodies.get(2));
    }

    @Test
    void aRefusedLevelIsRetriedTheSameWay() throws IOException {
        showJson = null;
        answer(400, REFUSAL);
        answer(200, ANSWER);

        List<ProviderEvent> events = drain(provider("qwen3-coder:30b"), request(Reasoning.ON, "high"));

        assertEquals("high", chatBody(0).path("think").asText());
        assertNull(chatBody(1).get("think"));
        assertEquals("Hallo!", text(events));
    }

    @Test
    void theTapRecordsTheRefusedExchangeAndTheRetryAsTwoExchanges() {
        showJson = null;
        answer(400, REFUSAL);
        answer(200, ANSWER);
        RecordingWireTap tap = new RecordingWireTap();

        drain(provider("qwen2.5:7b"), new ProviderRequest("sys", oneUser("hallo"), List.of(), 512,
                Reasoning.ON, null, new CancelSignal(), tap));

        assertEquals(2, tap.requests.size(), "two requests went out, two are on record");
        assertEquals(chatBodies.get(0), tap.requests.get(0).body());
        assertEquals(chatBodies.get(1), tap.requests.get(1).body());
        assertEquals(2, tap.outcomes.size());
        assertEquals(400, tap.outcomes.get(0).status());
        assertEquals(refusalFor("qwen2.5:7b"), tap.outcomes.get(0).body());
        assertEquals(200, tap.outcomes.get(1).status());
    }

    @Test
    void aThinkingRefusalOnAnImageRequestDoesNotBlindAModelThatCanSee() {
        // translategemma measured 2026-09-26: capabilities completion + vision,
        // no thinking. When /api/show is silent, the refusal of think must be
        // read as what it says, not as the any-400-with-images vision arm.
        showJson = null;
        answer(400, REFUSAL);
        answer(200, ANSWER);
        OllamaProvider provider = provider("translategemma:27b");

        List<ProviderEvent> events = drain(provider, imageRequest(Reasoning.ON));

        assertEquals("Hallo!", text(events));
        assertEquals(LlmProvider.Vision.UNKNOWN, provider.vision(),
                "a refusal of think says nothing about sight");
    }

    // ---- the model id in ollama's words is not ollama's reason -----------
    //
    // Ollama names the requested model in its error text: "\"<id>\" does not
    // support thinking", "model '<id>' not found", "registry.ollama.ai/library/
    // <id> does not support tools" (measured 2026-09-26 against ollama 0.32.1,
    // ollama-measure-review-2026-09-26.txt). A model id that contains "vision"
    // or "thinking" must not be read as the reason for the refusal.

    @Test
    void aThinkingRefusalToAModelNamedVisionIsSentOnceMoreWithoutThink() throws IOException {
        showJson = null;
        answer(400, REFUSAL);
        answer(200, ANSWER);
        OllamaProvider provider = provider("llama3.2-vision:11b");

        List<ProviderEvent> events = drain(provider, request(Reasoning.ON, null));

        assertEquals("Hallo!", text(events), "the run answers after one retry");
        assertEquals(2, chatBodies.size());
        assertNull(chatBody(1).get("think"), "the retry carries no think: " + chatBodies.get(1));
        assertEquals(LlmProvider.Vision.UNKNOWN, provider.vision(),
                "a refusal of think says nothing about sight");
    }

    @Test
    void aThinkingRefusalOfAnImageRequestToAModelNamedVisionLeavesItsSightAlone() throws IOException {
        showJson = null;
        answer(400, REFUSAL);
        answer(200, ANSWER);
        OllamaProvider provider = provider("llama3.2-vision:11b");

        List<ProviderEvent> events = drain(provider, imageRequest(Reasoning.ON));

        assertEquals("Hallo!", text(events), "the run answers after one retry");
        assertEquals(2, chatBodies.size());
        assertNull(chatBody(1).get("think"), "the retry carries no think: " + chatBodies.get(1));
        assertEquals(LlmProvider.Vision.UNKNOWN, provider.vision(),
                "a refusal of think says nothing about sight");
    }

    @Test
    void aNotFoundOnAnImageRequestToAModelNamedVisionDoesNotMarkItBlind() {
        showJson = null;
        answer(404, "{\"error\":\"model '{model}' not found\"}");
        OllamaProvider provider = provider("llama3.2-vision:11b");

        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> drain(provider, imageRequest(Reasoning.DEFAULT)));

        assertTrue(failure.getMessage().contains("not found"), failure.getMessage());
        assertFalse(failure.getMessage().startsWith("Model without vision"), failure.getMessage());
        assertEquals(LlmProvider.Vision.UNKNOWN, provider.vision(),
                "a missing model says nothing about sight");
    }

    @Test
    void aNotFoundForAModelNamedThinkingKeepsThinkOnTheNextRequest() throws IOException {
        showJson = null; // not pulled yet: /api/show answers 404 as well
        answer(404, "{\"error\":\"model '{model}' not found\"}");
        answer(200, ANSWER);
        OllamaProvider provider = provider("qwen3:4b-thinking-2507");

        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> drain(provider, request(Reasoning.ON, null)));

        assertEquals(1, chatBodies.size(), "a missing model is not a think refusal, so no retry");
        assertTrue(failure.getMessage().contains("not found"), failure.getMessage());
        assertFalse(failure.getMessage().contains("does not support thinking"), failure.getMessage());

        // The model is pulled now. The next request still asks it to think.
        List<ProviderEvent> events = drain(provider, request(Reasoning.ON, null));
        assertEquals("Hallo!", text(events));
        assertTrue(chatBody(1).path("think").asBoolean(false),
                "think still goes out: " + chatBodies.get(1));
    }

    @Test
    void aToolsRefusalForAModelNamedThinkingKeepsThinkOnTheNextRequest() throws IOException {
        showJson = "{\"capabilities\":[\"completion\",\"thinking\"]}";
        answer(400, "{\"error\":\"registry.ollama.ai/library/{model} does not support tools\"}");
        answer(200, ANSWER);
        OllamaProvider provider = provider("qwen3:4b-thinking-2507");

        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> drain(provider, request(Reasoning.ON, null)));

        assertEquals(1, chatBodies.size(), "a tools refusal is not a think refusal, so no retry");
        assertTrue(failure.getMessage().contains("does not support tools"), failure.getMessage());
        assertFalse(failure.getMessage().contains("does not support thinking"), failure.getMessage());

        drain(provider, request(Reasoning.ON, null));
        assertTrue(chatBody(1).path("think").asBoolean(false),
                "think still goes out: " + chatBodies.get(1));
    }

    @Test
    void aThinkingRefusalToAModelCalledThinkingIsStillReadAsOne() throws IOException {
        // Only the echo is taken out, the first time the id appears. The
        // reason after it keeps its words even when the id is the keyword.
        showJson = null;
        answer(400, REFUSAL);
        answer(200, ANSWER);

        List<ProviderEvent> events = drain(provider("thinking"), request(Reasoning.ON, null));

        assertEquals("Hallo!", text(events), "the run answers after one retry");
        assertEquals(2, chatBodies.size());
        assertNull(chatBody(1).get("think"), "the retry carries no think: " + chatBodies.get(1));
    }

    // ---- criterion 6: the terminal message -------------------------------

    @Test
    void aRefusalThatRepeatsWithoutThinkEndsTheRunWithAMessageWithoutDashes() {
        showJson = null;
        answer(400, REFUSAL); // repeats for every request

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> drain(provider("qwen2.5:7b"), request(Reasoning.ON, null)));

        assertEquals(2, chatBodies.size(), "exactly one retry, never a loop");
        String message = failure.getMessage();
        assertTrue(message.contains("\"qwen2.5:7b\" does not support thinking"), message);
        assertTrue(message.contains(refusalFor("qwen2.5:7b")), "the server's own words ride along: " + message);
        assertFalse(message.contains("\u2014") || message.contains("\u2013"), "no em or en dash: " + message);
        assertFalse(failure instanceof TransientProviderException, "terminal, not retryable");
    }

    @Test
    void aRequestThatCarriedNoThinkIsNotRetriedOnAThinkingRefusal() {
        showJson = null;
        answer(400, REFUSAL);

        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> drain(provider("qwen2.5:7b"), request(Reasoning.DEFAULT, null)));

        assertEquals(1, chatBodies.size(), "nothing to take off, so nothing to send again");
        assertTrue(failure.getMessage().contains("does not support thinking"), failure.getMessage());
        assertFalse(failure.getMessage().contains("\u2014"), failure.getMessage());
    }

    @Test
    void anErrorAfterTheStreamStartedIsNeverRetried() {
        // The risk the triage named: only a refusal BEFORE the stream opens is
        // sent again. A stream that already delivered text and then fails keeps
        // the transient path it always had.
        showJson = null;
        answer(200, """
                {"message":{"content":"Hal"},"done":false}
                {"error":"thinking failed mid-stream"}
                """);

        assertThrows(TransientProviderException.class,
                () -> drain(provider("qwen2.5:7b"), request(Reasoning.ON, null)));
        assertEquals(1, chatBodies.size(), "a stream that has started is never re-sent");
    }
}
