package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.provider.LlmProvider.PUsage;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 468: the prompt cache field a llama.cpp server reads, and the cached
 * prompt tokens an OpenAI-compatible response reports. One test per guarantee,
 * so each can be bitten on its own.
 *
 * <p>The field rule follows the primary sources read on 2026-10-09: the
 * llama.cpp server README lists {@code cache_prompt} as a {@code /completion}
 * option and says the {@code /completion}-specific options are also accepted on
 * {@code /v1/chat/completions}; the LM Studio chat-completions page and the
 * OpenAI reference name no such field.</p>
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class PromptCacheHintTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String PLAIN_STREAM = """
            data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}

            data: {"usage":{"prompt_tokens":11,"completion_tokens":1},"choices":[]}

            data: [DONE]

            """;

    private HttpServer server;
    private String baseUrl;
    private final AtomicReference<String> lastBody = new AtomicReference<>();
    private final AtomicInteger hits = new AtomicInteger();
    private volatile String scriptedSse = PLAIN_STREAM;
    private volatile int scriptedStatus = 200;
    private volatile String scriptedErrorBody = "";

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            hits.incrementAndGet();
            lastBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            boolean ok = scriptedStatus == 200;
            byte[] body = (ok ? scriptedSse : scriptedErrorBody).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type",
                    ok ? "text/event-stream" : "application/json");
            exchange.sendResponseHeaders(scriptedStatus, body.length);
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

    private static ProviderRequest oneTurn() {
        return new ProviderRequest("You are a test.",
                List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("Hi")))),
                List.of(), 100, new CancelSignal());
    }

    private List<ProviderEvent> run(String dialect, boolean promptCaching) {
        OpenAiCompatProvider provider = new OpenAiCompatProvider(
                new OpenAiCompatProvider.Options(baseUrl, "m", null, dialect, promptCaching));
        List<ProviderEvent> events = new ArrayList<>();
        provider.stream(oneTurn()).forEach(events::add);
        return events;
    }

    private JsonNode sentBody(String dialect, boolean promptCaching) throws IOException {
        run(dialect, promptCaching);
        return JSON.readTree(lastBody.get());
    }

    private PUsage usageOf(List<ProviderEvent> events) {
        return events.stream().filter(PUsage.class::isInstance).map(PUsage.class::cast)
                .findFirst().orElseThrow();
    }

    private static String resource(String name) throws IOException {
        try (InputStream in = PromptCacheHintTest.class.getResourceAsStream("/provider/" + name)) {
            assertNotNull(in, "fixture " + name + " is on the test classpath");
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    // ---- the request field ------------------------------------------------

    @Test
    void aLlamaCppRequestCarriesCachePromptTrue() throws IOException {
        JsonNode body = sentBody("llamacpp", true);
        assertTrue(body.has("cache_prompt"), "the field is on the wire: " + body);
        assertTrue(body.get("cache_prompt").isBoolean());
        assertTrue(body.get("cache_prompt").booleanValue());
    }

    @Test
    void theBundledLlamaServerCarriesCachePromptTrue() throws IOException {
        // spectro-local is a stock llama-server behind a second name.
        JsonNode body = sentBody("spectro-local", true);
        assertTrue(body.path("cache_prompt").isBoolean(), "the field is on the wire: " + body);
        assertTrue(body.get("cache_prompt").booleanValue());
    }

    @Test
    void promptCachingOffLeavesTheCacheFieldOffTheLlamaCppWire() throws IOException {
        // Off omits the field, so the server's own default decides. A config
        // that turned promptCaching off for Anthropic does not make a stock
        // llama-server read the whole chat again on every turn.
        JsonNode body = sentBody("llamacpp", false);
        assertTrue(body.has("messages"), "a real request body was captured: " + body);
        assertFalse(body.has("cache_prompt"), "no cache field when the setting is off: " + body);
        assertNull(OpenAiCompatProvider.cachePromptFor("llamacpp", false));
        assertNull(OpenAiCompatProvider.cachePromptFor("spectro-local", false));
    }

    @Test
    void theOpenAiDialectCarriesNoCachePrompt() throws IOException {
        JsonNode body = sentBody("openai", true);
        assertTrue(body.has("messages"), "a real request body was captured: " + body);
        assertFalse(body.has("cache_prompt"), "the cloud gets no llama.cpp field: " + body);
        assertNull(OpenAiCompatProvider.cachePromptFor("openai", true));
        assertNull(OpenAiCompatProvider.cachePromptFor("openai", false));
    }

    @Test
    void lmStudioCarriesNoCachePrompt() throws IOException {
        JsonNode body = sentBody("lmstudio", true);
        assertTrue(body.has("messages"), "a real request body was captured: " + body);
        assertFalse(body.has("cache_prompt"), "LM Studio documents no such field: " + body);
    }

    @Test
    void anEndpointOfUnknownMakeCarriesNoCachePrompt() throws IOException {
        JsonNode body = sentBody(null, true);
        assertTrue(body.has("messages"), "a real request body was captured: " + body);
        assertFalse(body.has("cache_prompt"), "an unknown server gets no guessed field: " + body);
    }

    @Test
    void theCloudGatewaysCarryNoCachePrompt() {
        assertNull(OpenAiCompatProvider.cachePromptFor("openrouter", true));
        assertNull(OpenAiCompatProvider.cachePromptFor("gemini", true));
        assertEquals(Boolean.TRUE, OpenAiCompatProvider.cachePromptFor("llamacpp", true),
                "the positive half: the same function does answer for llama.cpp");
    }

    // ---- the cached count -------------------------------------------------

    @Test
    void cachedTokensAreParsedFromARecordedLlamaCppResponse() throws IOException {
        // Recorded on 2026-10-09 from llama-server b10090, turn two of a short
        // chat: prompt_tokens 39 of which cached_tokens 20, timings cache_n 20,
        // prompt_n 19. The remainder is the uncached part, the cache rides apart.
        scriptedSse = resource("llamacpp-b10090-turn-two.sse");
        assertEquals(new PUsage(19, 4, 20, 0), usageOf(run("llamacpp", true)));
    }

    @Test
    void theTimingsAreTheFallbackWhenUsageCarriesNoDetails() {
        // The same recorded chunk with prompt_tokens_details removed: the shape
        // of a server that reports timings only. prompt_n is the uncached part
        // and cache_n the reused part, by llama.cpp's own definition.
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"Bye."},"finish_reason":"stop"}]}

                data: {"choices":[],"usage":{"completion_tokens":4,"prompt_tokens":39,"total_tokens":43},"timings":{"cache_n":20,"prompt_n":19,"predicted_n":4}}

                data: [DONE]

                """;
        assertEquals(new PUsage(19, 4, 20, 0), usageOf(run("llamacpp", true)));
    }

    @Test
    void anOpenAiShapedCachedCountIsReadOnAnyCompatibleEndpoint() {
        // The usage shape is OpenAI's own, so the reading is not tied to a dialect.
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}

                data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":1024}}}

                data: [DONE]

                """;
        assertEquals(new PUsage(176, 7, 1024, 0), usageOf(run("lmstudio", true)));
    }

    @Test
    void aReportedZeroLeavesTheRawPromptCount() {
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}

                data: {"choices":[],"usage":{"prompt_tokens":39,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":0}},"timings":{"cache_n":0,"prompt_n":39}}

                data: [DONE]

                """;
        assertEquals(new PUsage(39, 4), usageOf(run("llamacpp", true)));
    }

    @Test
    void aNegativeCacheCountInTheTimingsIsReadAsZeroCachedTokens() {
        // llama.cpp itself never sends a negative count: on master both timings
        // fields are unsigned and start at 0 (server-common.h, read 2026-10-09).
        // Another server that copies the shape may, and a negative cache count
        // would shrink the context the loop adds up.
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}

                data: {"choices":[],"usage":{"prompt_tokens":39,"completion_tokens":4},"timings":{"cache_n":-1,"prompt_n":39}}

                data: [DONE]

                """;
        assertEquals(new PUsage(39, 4), usageOf(run("llamacpp", true)));
    }

    @Test
    void aNegativePromptCountInTheTimingsNeverMakesTheInputNegative() {
        // The same floor on the other timings field: a negative prompt_n would
        // put a negative input count on the wire.
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}

                data: {"choices":[],"usage":{"prompt_tokens":39,"completion_tokens":4},"timings":{"cache_n":20,"prompt_n":-1}}

                data: [DONE]

                """;
        assertEquals(new PUsage(0, 4, 20, 0), usageOf(run("llamacpp", true)));
    }

    @Test
    void aCachedCountAbovePromptTokensNeverMakesTheRemainderNegative() {
        scriptedSse = """
                data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}

                data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":12}}}

                data: [DONE]

                """;
        assertEquals(new PUsage(0, 1, 12, 0), usageOf(run("llamacpp", true)));
    }

    // ---- a backend that refuses the field ---------------------------------

    @Test
    void aBackendThatRejectsTheFieldFailsOnceAndIsNotRetried() {
        scriptedStatus = 400;
        scriptedErrorBody = "{\"error\":{\"message\":\"unknown field: cache_prompt\"}}";
        LlmProvider provider = RetryingProvider.wrap(new OpenAiCompatProvider(
                new OpenAiCompatProvider.Options(baseUrl, "m", null, "llamacpp", true)),
                RetryPolicy.from(3));
        RuntimeException thrown = assertThrows(RuntimeException.class,
                () -> provider.stream(oneTurn()).forEach(event -> { }));
        assertInstanceOf(IllegalStateException.class, thrown);
        assertTrue(thrown.getMessage().contains("400"), thrown.getMessage());
        assertTrue(thrown.getMessage().contains("cache_prompt"),
                "the server's own words name the field: " + thrown.getMessage());
        assertEquals(1, hits.get(), "a refused field is never silently retried");
    }
}
