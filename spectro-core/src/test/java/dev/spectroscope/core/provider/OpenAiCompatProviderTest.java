package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.wire.LlmWireTap;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
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
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The OpenAI-compatible wire mapping against a scripted local SSE server —
 * fragmented tool-call assembly, usage from the trailing chunk, and the
 * request format (tool results as role:"tool" with tool_call_id).
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class OpenAiCompatProviderTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private HttpServer server;
    private String baseUrl;
    private final AtomicReference<String> lastBody = new AtomicReference<>();
    private volatile String scriptedSse = "";
    private volatile int scriptedStatus = 200;
    private volatile String scriptedErrorBody = "";

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        com.sun.net.httpserver.HttpHandler chatHandler = exchange -> {
            lastBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            if (scriptedStatus != 200) {
                byte[] error = scriptedErrorBody.getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(scriptedStatus, error.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(error);
                }
                return;
            }
            byte[] body = scriptedSse.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        };
        // bare-host backends (openai, lmstudio, openrouter) POST here…
        server.createContext("/v1/chat/completions", chatHandler);
        // …while gemini's OpenAI-compat surface hangs off /v1beta/openai.
        server.createContext("/v1beta/openai/chat/completions", chatHandler);
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    private List<ProviderEvent> collect(ProviderRequest request) {
        OpenAiCompatProvider provider = new OpenAiCompatProvider(
                new OpenAiCompatProvider.Options(baseUrl, "local-model", null));
        List<ProviderEvent> events = new ArrayList<>();
        provider.stream(request).forEach(events::add);
        return events;
    }

    private static ProviderRequest request(List<ProviderMessage> messages) {
        return new ProviderRequest("You are a test.", messages, List.of(), 500, new CancelSignal());
    }

    private static ProviderRequest tapped(List<ProviderMessage> messages, LlmWireTap tap) {
        return new ProviderRequest("You are a test.", messages, List.of(), 500,
                ProviderRequest.Reasoning.DEFAULT, null, new CancelSignal(), tap);
    }

    private static List<ProviderMessage> oneUser(String text) {
        return List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent(text))));
    }

    @Test
    void aCancelDuringAStalledStreamAbortsPromptlyInsteadOfHanging() throws Exception {
        // The stop button, reproduced against an SSE server that streams one delta
        // then stalls. Cancelling must abort promptly — the JDK transport close
        // unblocks the read, and the cancelled EOF ends ABORTED, not END_TURN.
        CountDownLatch requestArrived = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        server.removeContext("/v1/chat/completions");
        server.createContext("/v1/chat/completions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0); // chunked: an open SSE stream
            OutputStream out = exchange.getResponseBody();
            try {
                out.write("data: {\"choices\":[{\"delta\":{\"content\":\"hi \"}}]}\n\n"
                        .getBytes(StandardCharsets.UTF_8));
                out.flush();
                requestArrived.countDown();
                release.await(8, TimeUnit.SECONDS); // then STALL
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } finally {
                exchange.close();
            }
        });

        CancelSignal signal = new CancelSignal();
        ProviderRequest req = new ProviderRequest("sys",
                List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("go")))),
                List.of(), 500, signal);
        OpenAiCompatProvider provider = new OpenAiCompatProvider(
                new OpenAiCompatProvider.Options(baseUrl, "local-model", null));
        Iterator<ProviderEvent> it = provider.stream(req).iterator();

        assertTrue(it.hasNext());
        assertEquals("hi ", assertInstanceOf(PTextDelta.class, it.next()).text());
        assertTrue(requestArrived.await(5, TimeUnit.SECONDS));

        AtomicReference<ProviderEvent> nextEvent = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        Thread reader = Thread.ofVirtual().start(() -> {
            if (it.hasNext()) {
                nextEvent.set(it.next());
            }
            done.countDown();
        });

        Thread.sleep(300);
        signal.cancel();

        boolean aborted = done.await(3, TimeUnit.SECONDS);
        release.countDown();
        reader.join(1_000);

        assertTrue(aborted, "cancelling a stalled openai-compatible stream must abort promptly, not hang");
        assertEquals(PStop.StopReason.ABORTED,
                assertInstanceOf(PStop.class, nextEvent.get()).reason());
    }

    @Test
    void aCancelDuringAFastStreamReturnsInstantlyAndTearsTheConnectionDown() throws Exception {
        // The live card-78 stop bug, reproduced: a local reasoning model streams
        // deltas FAST (llama-server, huge <think> flood). Spring's response close
        // DRAINS the remaining body, so cancel() used to sit on the cancelling
        // thread reading the whole rest of the generation (15.8 s measured), the
        // server never saw a disconnect and kept generating, and the concurrent
        // drain corrupted the JDK stream (NoSuchElementException out of cancel()
        // — which killed the WebSocket session upstream). Pins, in order: the
        // cancelling thread detaches instantly and without an exception, the
        // reader ends ABORTED promptly, and the server actually SEES the
        // disconnect (that is what stops llama-server's generation).
        CountDownLatch firstDelta = new CountDownLatch(1);
        CountDownLatch serverSawDisconnect = new CountDownLatch(1);
        server.removeContext("/v1/chat/completions");
        server.createContext("/v1/chat/completions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0); // chunked: an open SSE stream
            OutputStream out = exchange.getResponseBody();
            try {
                // ~6 s of continuous deltas — far past every latency bound below,
                // bounded so a failing run still terminates.
                for (int i = 0; i < 1200; i++) {
                    out.write(("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"t" + i
                            + " \"}}]}\n\n").getBytes(StandardCharsets.UTF_8));
                    out.flush();
                    firstDelta.countDown();
                    Thread.sleep(5);
                }
            } catch (IOException clientGone) {
                serverSawDisconnect.countDown(); // the teardown llama-server needs
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } finally {
                exchange.close();
            }
        });

        CancelSignal signal = new CancelSignal();
        ProviderRequest req = new ProviderRequest("sys",
                List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("go")))),
                List.of(), 500, signal);
        OpenAiCompatProvider provider = new OpenAiCompatProvider(
                new OpenAiCompatProvider.Options(baseUrl, "local-model", null));
        Iterator<ProviderEvent> it = provider.stream(req).iterator();

        // Drain the flood on a reader thread until the stream ends.
        AtomicReference<ProviderEvent> lastEvent = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        Thread reader = Thread.ofVirtual().start(() -> {
            try {
                while (it.hasNext()) {
                    lastEvent.set(it.next());
                }
            } finally {
                done.countDown();
            }
        });

        assertTrue(firstDelta.await(5, TimeUnit.SECONDS));
        Thread.sleep(150); // mid-flood, like the owner's click

        long cancelStarted = System.nanoTime();
        signal.cancel();   // must neither block on a drain nor throw
        long cancelMillis = (System.nanoTime() - cancelStarted) / 1_000_000;

        assertTrue(cancelMillis < 1_500,
                "cancel() must detach instantly, not drain the stream (took " + cancelMillis + " ms)");
        assertTrue(done.await(3, TimeUnit.SECONDS),
                "the reader must end promptly after a mid-flood cancel");
        assertEquals(PStop.StopReason.ABORTED,
                assertInstanceOf(PStop.class, lastEvent.get()).reason());
        assertTrue(serverSawDisconnect.await(5, TimeUnit.SECONDS),
                "the server must SEE the disconnect — that is what stops the model's generation");
        reader.join(1_000);
    }

    @Test
    void streamsTextUsageAndStop() {
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"Hel"}}]}

                data: {"choices":[{"delta":{"content":"lo"}}]}

                data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

                data: {"usage":{"prompt_tokens":11,"completion_tokens":4},"choices":[]}

                data: [DONE]
                """;
        List<ProviderEvent> events = collect(request(List.of(
                new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("Hi"))))));

        assertEquals(new PTextDelta("Hel"), events.get(0));
        assertEquals(new PTextDelta("lo"), events.get(1));
        assertEquals(new PUsage(11, 4), events.get(2));
        assertEquals(new PStop(PStop.StopReason.END_TURN), events.get(3));
    }

    @Test
    void documentContentBecomesAFileContentPart() {
        // view_file (file_upload): PDFs ride the OpenAI wire as a "file"
        // content part with a data-URI — the shape gpt-4o/5.x accept on
        // chat/completions.
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}

                data: [DONE]
                """;
        collect(request(List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(
                new LlmProvider.DocumentContent("application/pdf", "UERGQllURVM=", "paper.pdf"),
                new TextContent("Summarize the paper."))))));

        String body = lastBody.get();
        assertTrue(body.contains("\"type\":\"file\""), "a file part, got: " + body);
        assertTrue(body.contains("\"filename\":\"paper.pdf\""), "the filename, got: " + body);
        assertTrue(body.contains("\"file_data\":\"data:application/pdf;base64,UERGQllURVM=\""),
                "the data URI, got: " + body);
    }

    // ---- reasoning (LM Studio / vLLM): the provider always parses; the
    // ---- harness-level emission filter owns visibility (thinking toggle).

    @Test
    void reasoningContentDeltasBecomeThinkingDeltas() {
        // LM Studio with "Reasoning Section Parsing" ON strips the model's
        // <think> tags server-side and streams the inside as reasoning_content.
        scriptedSse = """
                data: {"choices":[{"delta":{"reasoning_content":"Let me think"}}]}

                data: {"choices":[{"delta":{"content":"Answer."}}]}

                data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

                data: [DONE]
                """;
        List<ProviderEvent> events = collect(request(List.of(
                new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("Hi"))))));

        assertEquals(new LlmProvider.PThinkingDelta("Let me think"), events.get(0));
        assertEquals(new PTextDelta("Answer."), events.get(1));
    }

    @Test
    void plainReasoningFieldIsReadToo() {
        // Some servers (vLLM and friends) name the field plain "reasoning".
        scriptedSse = """
                data: {"choices":[{"delta":{"reasoning":"hmm"}}]}

                data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}

                data: [DONE]
                """;
        List<ProviderEvent> events = collect(request(List.of(
                new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("Hi"))))));

        assertEquals(new LlmProvider.PThinkingDelta("hmm"), events.get(0));
        assertEquals(new PTextDelta("Done."), events.get(1));
    }

    @Test
    void inlineThinkTagsAreSplitIntoThinkingAndAnswer() {
        // Parsing OFF (or a server without it): the raw <think> tags ride
        // inside content — the splitter must separate them, even when a tag
        // spans two chunks, instead of leaking tags into the answer.
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"<think>plan"}}]}

                data: {"choices":[{"delta":{"content":" it</think>Answer"}}]}

                data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

                data: [DONE]
                """;
        List<ProviderEvent> events = collect(request(List.of(
                new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("Hi"))))));

        assertEquals(new LlmProvider.PThinkingDelta("plan"), events.get(0));
        assertEquals(new LlmProvider.PThinkingDelta(" it"), events.get(1));
        assertEquals(new PTextDelta("Answer"), events.get(2));
        assertTrue(events.stream().noneMatch(e ->
                        e instanceof PTextDelta t && t.text().contains("think")),
                "no tag may leak into the answer, got: " + events);
    }

    @Test
    void assemblesFragmentedToolCallDeltas() {
        scriptedSse = """
                data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}

                data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]}}]}

                data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]}}]}

                data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

                data: [DONE]
                """;
        List<ProviderEvent> events = collect(request(List.of(
                new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("Read a.txt"))))));

        PToolCall call = assertInstanceOf(PToolCall.class, events.getFirst());
        assertEquals("call_1", call.callId());
        assertEquals("read_file", call.name());
        assertEquals("a.txt", call.input().path("path").asText(),
                "fragmented argument deltas must assemble into parsed JSON");
        assertEquals(new PStop(PStop.StopReason.TOOL_USE), events.getLast());
    }

    @Test
    void requestCarriesToolResultsWithTheirCallIds() throws IOException {
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}

                data: [DONE]
                """;
        collect(request(List.of(
                new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("Run it"))),
                new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(
                        new LlmProvider.ToolCallContent("call_9", "run_command",
                                JSON.createObjectNode().put("command", "ls")))),
                new ProviderMessage(ProviderMessage.Role.USER, List.of(
                        new ToolResultContent("call_9", "file-a\nfile-b", false))))));

        JsonNode sent = JSON.readTree(lastBody.get());
        assertEquals("local-model", sent.get("model").asText());
        assertTrue(sent.get("stream").asBoolean());
        assertTrue(sent.get("stream_options").get("include_usage").asBoolean());

        JsonNode messages = sent.get("messages");
        assertEquals("system", messages.get(0).get("role").asText());
        assertEquals("user", messages.get(1).get("role").asText());
        JsonNode assistant = messages.get(2);
        assertEquals("assistant", assistant.get("role").asText());
        assertEquals("call_9", assistant.get("tool_calls").get(0).get("id").asText());
        assertTrue(assistant.get("tool_calls").get(0).get("function").get("arguments").isTextual(),
                "OpenAI wire carries arguments as a JSON string");
        JsonNode toolMessage = messages.get(3);
        assertEquals("tool", toolMessage.get("role").asText());
        assertEquals("call_9", toolMessage.get("tool_call_id").asText());
    }

    @Test
    void theCompletionCapIsClampedForOpenAisPerModelLimits() throws IOException {
        // The harness default (32k) suits Anthropic and local servers, but
        // api.openai.com rejects a max_tokens above the model's own cap with
        // HTTP 400 (gpt-4o-mini: 16384) — the wire must clamp, not pass through.
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}

                data: [DONE]
                """;
        collect(new LlmProvider.ProviderRequest("You are a test.",
                List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("Hi")))),
                List.of(), 32_000, new CancelSignal()));

        JsonNode sent = JSON.readTree(lastBody.get());
        assertEquals(OpenAiCompatProvider.MAX_TOKENS_CAP, sent.get("max_tokens").asInt());
        assertTrue(sent.get("max_completion_tokens") == null,
                "a LOCAL server gets the classic field only");

        // A smaller explicit budget passes through untouched.
        collect(request(List.of(new ProviderMessage(
                ProviderMessage.Role.USER, List.of(new TextContent("Hi"))))));
        assertEquals(500, JSON.readTree(lastBody.get()).get("max_tokens").asInt());
    }

    @Test
    void imagesRideTheUserMessageAsDataUriContentParts() throws IOException {
        // Vision on the OpenAI wire: the user content flips from a string to
        // the content-array — image parts as base64 data URIs, text after.
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"red"},"finish_reason":"stop"}]}

                data: [DONE]
                """;
        collect(request(List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(
                new LlmProvider.ToolResultContent("c1", "Attached red.png", false),
                new LlmProvider.ImageContent("image/png", "UkVEUE5H"),
                new TextContent("what color?"))))));

        JsonNode sent = JSON.readTree(lastBody.get());
        JsonNode messages = sent.get("messages");
        assertEquals("tool", messages.get(1).get("role").asText(), "tool result rides role tool");
        JsonNode vision = messages.get(2);
        assertEquals("user", vision.get("role").asText());
        assertTrue(vision.get("content").isArray(), "vision turns use the content array");
        assertEquals("image_url", vision.get("content").get(0).get("type").asText());
        assertEquals("data:image/png;base64,UkVEUE5H",
                vision.get("content").get(0).get("image_url").get("url").asText());
        assertEquals("what color?", vision.get("content").get(1).get("text").asText());
    }

    @Test
    void gptFiveWithToolsNeedsReasoningEffortNoneOnTheCloud() {
        // The live error: "Function tools with reasoning_effort are not
        // supported for gpt-5.6-luna in /v1/chat/completions. … set
        // reasoning_effort to 'none'." — cloud + gpt-5.x + tools gets the
        // explicit "none"; everyone else never sees the field. (Seam widened
        // by card 88: the same rule now lives in reasoningWireFor and
        // outranks any requested effort.)
        var defaultMode = LlmProvider.ProviderRequest.Reasoning.DEFAULT;
        assertEquals("none", OpenAiCompatProvider.reasoningWireFor(
                "openai", "https://api.openai.com", "gpt-5.6-luna", true, defaultMode, null)
                .reasoningEffort());
        assertEquals("none", OpenAiCompatProvider.reasoningWireFor(
                "openai", "https://api.openai.com", "gpt-5.4-nano", true, defaultMode, null)
                .reasoningEffort());
        assertEquals(null, OpenAiCompatProvider.reasoningWireFor(
                "openai", "https://api.openai.com", "gpt-5.6-luna", false, defaultMode, null)
                .reasoningEffort());
        assertEquals(null, OpenAiCompatProvider.reasoningWireFor(
                "openai", "https://api.openai.com", "gpt-4o-mini", true, defaultMode, null)
                .reasoningEffort());
        assertEquals(null, OpenAiCompatProvider.reasoningWireFor(
                "openai", "http://localhost:1234", "gpt-5.6-luna", true, defaultMode, null)
                .reasoningEffort());
    }

    @Test
    void theCloudTakesTheModernCompletionCapField() {
        // api.openai.com's current models REJECT the legacy max_tokens with
        // HTTP 400 ("Unsupported parameter") — the cloud rides
        // max_completion_tokens; every local compat server keeps the classic
        // field. The classifier drives the wire branch.
        assertTrue(OpenAiCompatProvider.isOpenAiCloud("https://api.openai.com"));
        assertTrue(OpenAiCompatProvider.isOpenAiCloud("https://api.openai.com/v1"));
        assertTrue(!OpenAiCompatProvider.isOpenAiCloud("http://localhost:1234"));
        assertTrue(!OpenAiCompatProvider.isOpenAiCloud("http://127.0.0.1:11434"));
        assertTrue(!OpenAiCompatProvider.isOpenAiCloud(null));
    }

    @Test
    void aRetryableStatusBecomesATransientProviderException() {
        scriptedStatus = 503;
        scriptedErrorBody = "{\"error\":\"overloaded\"}";
        TransientProviderException transient_ = assertThrows(TransientProviderException.class,
                () -> collect(request(List.of(new ProviderMessage(
                        ProviderMessage.Role.USER, List.of(new TextContent("Hi")))))));
        assertTrue(transient_.getMessage().contains("503"));
    }

    // ---- vision: the refusal is the only capability source here (card 252) ----

    @Test
    void anImageRefusalTeachesTheProviderThatThisModelCannotSee() {
        // The owner's wedge, verbatim: deepseek answers 400 and names images.
        // The OpenAI wire has no capability endpoint, so the server's own refusal
        // is the only fact available — and it must be REMEMBERED, or the next
        // prompt re-sends the same image and fails the same way, forever.
        OpenAiCompatProvider provider = new OpenAiCompatProvider(
                new OpenAiCompatProvider.Options(baseUrl, "deepseek-v4-flash", null));
        assertEquals(LlmProvider.Vision.UNKNOWN, provider.vision(),
                "before the send nothing is known — and nothing is claimed");
        scriptedStatus = 400;
        scriptedErrorBody = "{\"error\":{\"message\":\"The provided messages contain images, "
                + "but deepseek-v4-flash does not support image inputs\"}}";

        IllegalStateException refused = assertThrows(IllegalStateException.class,
                () -> provider.stream(request(List.of(new ProviderMessage(
                        ProviderMessage.Role.USER, List.of(
                                new LlmProvider.ImageContent("image/png", "aWJt"),
                                new TextContent("What is this?")))))).forEach(event -> { }));
        assertTrue(refused.getMessage().startsWith("Model without vision"),
                "the raw body is sharpened into something actionable, got: " + refused.getMessage());
        assertEquals(LlmProvider.Vision.BLIND, provider.vision(),
                "the harness learned it: the next request is fenced before the send");
    }

    @Test
    void aBadRequestThatSaysNothingAboutImagesLeavesTheSightUnknown() {
        // A 400 has many causes (a tool schema the server rejects, a context
        // overflow). Marking a model blind on any of them would silently stop
        // sending images to a model that can see them.
        OpenAiCompatProvider provider = new OpenAiCompatProvider(
                new OpenAiCompatProvider.Options(baseUrl, "gpt-4o", null));
        scriptedStatus = 400;
        scriptedErrorBody = "{\"error\":{\"message\":\"Invalid schema for function 'run_command'\"}}";

        assertThrows(IllegalStateException.class,
                () -> provider.stream(request(List.of(new ProviderMessage(
                        ProviderMessage.Role.USER, List.of(
                                new LlmProvider.ImageContent("image/png", "aWJt"),
                                new TextContent("What is this?")))))).forEach(event -> { }));
        assertEquals(LlmProvider.Vision.UNKNOWN, provider.vision());
    }

    @Test
    void aTerminalStatusStaysNonTransientForTheRetryLayer() {
        scriptedStatus = 401;
        scriptedErrorBody = "{\"error\":\"bad key\"}";
        RuntimeException error = assertThrows(RuntimeException.class,
                () -> collect(request(List.of(new ProviderMessage(
                        ProviderMessage.Role.USER, List.of(new TextContent("Hi")))))));
        assertFalse(error instanceof TransientProviderException);
        assertFalse(RetryPolicy.from(2).isTransient(error),
                "the retry layer must not re-send a 401");
        assertTrue(error.getMessage().contains("401"));
    }

    @Test
    void compatPathTakesTheV1SegmentForBareHostsButNotForGemini() {
        // openai / lmstudio / openrouter are bare hosts (or host+/api): version lives in /v1.
        assertEquals("/v1/chat/completions",
                OpenAiCompatProvider.compatPath("https://api.openai.com", "/chat/completions"));
        assertEquals("/v1/models",
                OpenAiCompatProvider.compatPath("https://openrouter.ai/api", "/models"));
        assertEquals("/v1/chat/completions",
                OpenAiCompatProvider.compatPath("http://localhost:1234", "/chat/completions"));
        // gemini's compat base already carries its version (/v1beta/openai) — no extra /v1.
        assertEquals("/chat/completions",
                OpenAiCompatProvider.compatPath(
                        "https://generativelanguage.googleapis.com/v1beta/openai", "/chat/completions"));
        assertEquals("/models",
                OpenAiCompatProvider.compatPath(
                        "https://generativelanguage.googleapis.com/v1beta/openai", "/models"));
        // a CUSTOM base that already ends in a version segment (openai's own
        // documented https://api.openai.com/v1, or a proxy at .../v1) must NOT get
        // a doubled /v1/v1 — the trailing version counts as already-versioned.
        assertEquals("/chat/completions",
                OpenAiCompatProvider.compatPath("https://api.openai.com/v1", "/chat/completions"));
        assertEquals("/models",
                OpenAiCompatProvider.compatPath("https://proxy.internal/v1/", "/models"));
    }

    @Test
    void geminiShapedBaseRoutesUnderV1betaOpenaiNotV1() {
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"hi"}}]}

                data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

                data: [DONE]
                """;
        // base carries /v1beta/openai like the gemini preset — the provider must POST to
        // /v1beta/openai/chat/completions, NOT /v1beta/openai/v1/chat/completions.
        OpenAiCompatProvider provider = new OpenAiCompatProvider(
                new OpenAiCompatProvider.Options(baseUrl + "/v1beta/openai", "gemini-2.5-flash", null));
        List<ProviderEvent> events = new ArrayList<>();
        provider.stream(request(List.of(
                new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("Hi")))))).forEach(events::add);

        assertEquals(new PTextDelta("hi"), events.get(0));
        assertEquals(new PStop(PStop.StopReason.END_TURN), events.get(events.size() - 1));
    }

    // ---- the llm-wire tap (card 184): recorded == posted, by construction ---

    @Test
    void tapRecordsTheRequestBodyByteEqualToWhatTheServerReceived() {
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}

                data: [DONE]
                """;
        RecordingWireTap tap = new RecordingWireTap();
        collect(tapped(oneUser("Hi"), tap));

        assertEquals(1, tap.requests.size());
        LlmWireTap.WireRequest recorded = tap.requests.getFirst();
        assertEquals(lastBody.get(), recorded.body(),
                "the tap must get the exact string the server received");
        assertEquals("bytes", recorded.fidelity());
        assertEquals("local-model", recorded.model());
        assertEquals("POST", recorded.method());
        assertEquals("http", recorded.transport());
        assertEquals(baseUrl + "/v1/chat/completions", recorded.url());
    }

    @Test
    void tapRecordsEveryStreamLineTheServerSentAndACleanOutcome() {
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"Hel"}}]}

                data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

                data: [DONE]
                """;
        RecordingWireTap tap = new RecordingWireTap();
        collect(tapped(oneUser("Hi"), tap));

        // EVERY line read off the connection is teed: data payloads, the
        // blank SSE separators, and the [DONE] terminator, all verbatim.
        assertEquals(scriptedSse.lines().toList(), tap.lines);
        assertEquals(1, tap.outcomes.size());
        LlmWireTap.WireOutcome outcome = tap.outcomes.getFirst();
        assertEquals(200, outcome.status());
        assertEquals("bytes", outcome.fidelity());
        assertEquals(null, outcome.body(), "streamed responses ride line(), not body");
        assertFalse(outcome.aborted());
        assertEquals(null, outcome.error());
    }

    @Test
    void tapCarriesRealHeaderValuesTheRecorderRedactsLater() {
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}

                data: [DONE]
                """;
        RecordingWireTap tap = new RecordingWireTap();
        OpenAiCompatProvider provider = new OpenAiCompatProvider(
                new OpenAiCompatProvider.Options(baseUrl, "local-model", "sk-real-key", "lmstudio"));
        provider.stream(tapped(oneUser("Hi"), tap)).forEach(event -> { });

        LlmWireTap.WireRequest recorded = tap.requests.getFirst();
        assertEquals("lmstudio", recorded.provider(), "the configured dialect is the label");
        assertEquals("Bearer sk-real-key", recorded.headers().get("Authorization"),
                "the provider passes REAL header values; redaction is the recorder's job");
        assertEquals("application/json", recorded.headers().get("Content-Type"));
    }

    @Test
    void tapRecordsTheHttpErrorPathWithStatusAndDetailBody() {
        scriptedStatus = 503;
        scriptedErrorBody = "{\"error\":\"overloaded\"}";
        RecordingWireTap tap = new RecordingWireTap();
        assertThrows(TransientProviderException.class,
                () -> collect(tapped(oneUser("Hi"), tap)));

        assertEquals(1, tap.requests.size(), "the request WAS posted and must be on record");
        assertEquals(1, tap.outcomes.size());
        LlmWireTap.WireOutcome outcome = tap.outcomes.getFirst();
        assertEquals(503, outcome.status());
        assertEquals(scriptedErrorBody, outcome.body(),
                "the error detail body is the outcome's single payload");
        assertFalse(outcome.aborted());
    }

    @Test
    void tapKeepsPartialLinesAndMarksAbortedOnCancel() throws Exception {
        CountDownLatch requestArrived = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        server.removeContext("/v1/chat/completions");
        server.createContext("/v1/chat/completions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0); // chunked: an open SSE stream
            OutputStream out = exchange.getResponseBody();
            try {
                out.write("data: {\"choices\":[{\"delta\":{\"content\":\"hi \"}}]}\n\n"
                        .getBytes(StandardCharsets.UTF_8));
                out.flush();
                requestArrived.countDown();
                release.await(8, TimeUnit.SECONDS); // then STALL
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } finally {
                exchange.close();
            }
        });

        RecordingWireTap tap = new RecordingWireTap();
        CancelSignal signal = new CancelSignal();
        ProviderRequest req = new ProviderRequest("sys", oneUser("go"), List.of(), 500,
                ProviderRequest.Reasoning.DEFAULT, null, signal, tap);
        OpenAiCompatProvider provider = new OpenAiCompatProvider(
                new OpenAiCompatProvider.Options(baseUrl, "local-model", null));
        Iterator<ProviderEvent> it = provider.stream(req).iterator();

        assertTrue(it.hasNext());
        it.next();
        assertTrue(requestArrived.await(5, TimeUnit.SECONDS));

        CountDownLatch done = new CountDownLatch(1);
        Thread reader = Thread.ofVirtual().start(() -> {
            while (it.hasNext()) {
                it.next();
            }
            done.countDown();
        });
        Thread.sleep(300);
        signal.cancel();
        assertTrue(done.await(3, TimeUnit.SECONDS));
        release.countDown();
        reader.join(1_000);

        assertEquals(1, tap.outcomes.size());
        assertTrue(tap.outcomes.getFirst().aborted(),
                "a cancelled stream must record aborted=true");
        assertTrue(tap.lines.contains("data: {\"choices\":[{\"delta\":{\"content\":\"hi \"}}]}"),
                "the partial lines received before the cancel must survive, got: " + tap.lines);
    }

    @Test
    void aNullTapChangesNothing() {
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"Hel"}}]}

                data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

                data: {"usage":{"prompt_tokens":11,"completion_tokens":4},"choices":[]}

                data: [DONE]
                """;
        // The explicit full-arity null: the stream must translate exactly as the
        // tap-free constructors do (which the rest of this suite already pins).
        List<ProviderEvent> events = collect(tapped(oneUser("Hi"), null));

        assertEquals(new PTextDelta("Hel"), events.get(0));
        assertEquals(new PUsage(11, 4), events.get(1));
        assertEquals(new PStop(PStop.StopReason.END_TURN), events.get(2));
    }

    @Test
    void aTransportFailureClosesTheWirePairWithNullStatus() {
        // Connection refused: Spring throws BEFORE the exchange callback runs.
        // The wire pair must still close — one llm_request, one llm_response
        // with the contract's null-status "never answered" arm — or every
        // retry attempt would leave a dangling request line (card 184 review).
        RecordingWireTap tap = new RecordingWireTap();
        OpenAiCompatProvider provider = new OpenAiCompatProvider(
                new OpenAiCompatProvider.Options("http://127.0.0.1:1", "m", null));
        LlmProvider.ProviderRequest request = new LlmProvider.ProviderRequest(
                "sys", List.of(new ProviderMessage(ProviderMessage.Role.USER,
                        List.of(new TextContent("hi")))), List.of(),
                100, LlmProvider.ProviderRequest.Reasoning.DEFAULT, null,
                new CancelSignal(), tap);
        assertThrows(RuntimeException.class,
                () -> provider.stream(request).iterator().hasNext());
        assertEquals(1, tap.requests.size());
        assertEquals(1, tap.outcomes.size());
        assertNull(tap.outcomes.getFirst().status(), "no connection ever answered");
        assertTrue(tap.outcomes.getFirst().error() != null
                && !tap.outcomes.getFirst().error().isBlank());
    }
}
