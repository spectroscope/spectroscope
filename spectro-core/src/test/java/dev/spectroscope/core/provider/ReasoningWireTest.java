package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest.Reasoning;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * What {@code Reasoning.OFF} and an effort level become ON THE WIRE, per
 * provider, against scripted loopback servers — the {@code TranslateWireTest}
 * pattern. A controller- or builder-level seam cannot see what leaves the
 * machine, and that blindness is exactly how card 115 happened: OFF reached a
 * wire field in one provider out of three while every measurement ran through
 * that one. Each test here pins the POSTED body, including the cases where the
 * honest answer is "nothing, because the endpoint has no such field".
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS)
class ReasoningWireTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static List<ProviderMessage> oneUser(String text) {
        return List.of(new ProviderMessage(ProviderMessage.Role.USER,
                List.of(new TextContent(text))));
    }

    private static ProviderRequest request(Reasoning mode, String effort) {
        return new ProviderRequest("sys", oneUser("hi"), List.of(), 512, mode, effort,
                new CancelSignal());
    }

    // ---- ollama: the think field, boolean or level, family-gated ----------

    @Nested
    class Ollama {

        private HttpServer server;
        private String baseUrl;
        private final AtomicReference<String> lastBody = new AtomicReference<>();

        @BeforeEach
        void scriptedOllama() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/api/chat", exchange -> {
                lastBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                byte[] ndjson = ("""
                        {"message":{"content":"ok"},"done":true,"prompt_eval_count":3,"eval_count":1}
                        """).getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
                exchange.sendResponseHeaders(200, ndjson.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(ndjson);
                }
            });
            server.start();
            baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
        }

        @AfterEach
        void stop() {
            server.stop(0);
        }

        private JsonNode posted(String model, Reasoning mode, String effort) throws IOException {
            OllamaProvider provider = new OllamaProvider(new OllamaOptions(baseUrl, model));
            for (ProviderEvent ignored : provider.stream(request(mode, effort))) {
                // drain — the request body is the subject
            }
            return JSON.readTree(lastBody.get());
        }

        @Test
        void anEffortLevelRidesTheThinkFieldForQwen3() throws IOException {
            JsonNode think = posted("qwen3:8b", Reasoning.ON, "high").get("think");
            assertNotNull(think, "qwen3 takes levels on the think field");
            assertEquals("high", think.asText());
        }

        @Test
        void offOnAToggleFamilyStaysThinkFalse() throws IOException {
            JsonNode think = posted("glm-5.2:cloud", Reasoning.OFF, null).get("think");
            assertNotNull(think, "the off switch must be spent, not omitted");
            assertFalse(think.asBoolean());
        }

        @Test
        void offOnGptOssSendsNothingBecauseNoOffStateExists() throws IOException {
            // gpt-oss ignores true/false; a fabricated think:false would
            // pretend an off switch the model does not have.
            assertNull(posted("gpt-oss:20b", Reasoning.OFF, null).get("think"));
        }

        @Test
        void anUnlistedEffortValueFallsBackToTheToggle() throws IOException {
            JsonNode think = posted("qwen3:8b", Reasoning.ON, "xhigh").get("think");
            assertNotNull(think);
            assertTrue(think.isBoolean(), "xhigh is not in qwen3's level set, the toggle rides instead");
            assertTrue(think.asBoolean());
        }
    }

    // ---- openai-compat: four dialects, three possible fields --------------

    @Nested
    class OpenAiCompat {

        private HttpServer server;
        private String baseUrl;
        private final AtomicReference<String> lastBody = new AtomicReference<>();

        @BeforeEach
        void scriptedCompatServer() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", exchange -> {
                lastBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                byte[] sse = ("""
                        data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}

                        data: [DONE]

                        """).getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
                exchange.sendResponseHeaders(200, sse.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(sse);
                }
            });
            server.start();
            baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
        }

        @AfterEach
        void stop() {
            server.stop(0);
        }

        private JsonNode posted(String dialect, String model, Reasoning mode, String effort)
                throws IOException {
            OpenAiCompatProvider provider = new OpenAiCompatProvider(
                    new OpenAiCompatProvider.Options(baseUrl, model, null, dialect));
            for (ProviderEvent ignored : provider.stream(request(mode, effort))) {
                // drain — the request body is the subject
            }
            return JSON.readTree(lastBody.get());
        }

        @Test
        void theBundledEngineSwitchesOffViaTheChatTemplateNotReasoningEffort() throws IOException {
            // MEASURED 2026-07-28 against the bundled llama-server (b10107,
            // Qwen3-1.7B): reasoning_effort:"none" was silently ignored (300
            // reasoning tokens), chat_template_kwargs.enable_thinking=false
            // suppressed reasoning entirely (0 tokens, answer in 3).
            JsonNode sent = posted("spectro-local", "qwen3-4b", Reasoning.OFF, null);
            JsonNode kwargs = sent.get("chat_template_kwargs");
            assertNotNull(kwargs, "the measured off switch must be on the wire: " + sent);
            assertFalse(kwargs.get("enable_thinking").asBoolean());
            assertNull(sent.get("reasoning_effort"),
                    "the pinned build ignores reasoning_effort — sending it would pretend");
        }

        @Test
        void theBundledVibeThinkerHasNoOffSoNothingIsSent() throws IOException {
            JsonNode sent = posted("spectro-local", "vibethinker-3b", Reasoning.OFF, null);
            assertNull(sent.get("chat_template_kwargs"), "no template gate exists: " + sent);
            assertNull(sent.get("reasoning_effort"));
        }

        @Test
        void lmstudioNeverSeesAReasoningFieldBecauseNoneWorks() throws IOException {
            // Per-request reasoning control does not exist on LM Studio's
            // chat/completions (upstream #988/#1250) — an emitted field would
            // claim a control the endpoint does not have.
            JsonNode sent = posted("lmstudio", "some-model", Reasoning.OFF, "high");
            assertNull(sent.get("reasoning_effort"), "off must not pretend: " + sent);
            assertNull(sent.get("reasoning"));
            assertNull(sent.get("chat_template_kwargs"));
        }

        @Test
        void openrouterSpeaksTheNestedReasoningObject() throws IOException {
            JsonNode off = posted("openrouter", "anthropic/claude-sonnet-5", Reasoning.OFF, null);
            assertNull(off.get("reasoning_effort"), "openrouter does not read the flat field");
            assertFalse(off.get("reasoning").get("enabled").asBoolean());

            JsonNode effort = posted("openrouter", "openai/gpt-5.6", Reasoning.DEFAULT, "high");
            assertEquals("high", effort.get("reasoning").get("effort").asText());
        }

        @Test
        void geminiOffIsLegalOnlyWhereTheModelHasAZeroState() throws IOException {
            JsonNode flash = posted("gemini", "gemini-2.5-flash", Reasoning.OFF, null);
            assertEquals("none", flash.get("reasoning_effort").asText());

            JsonNode pro = posted("gemini", "gemini-3.1-pro", Reasoning.OFF, null);
            assertNull(pro.get("reasoning_effort"),
                    "3.x has no zero-thinking state, nothing may be sent: " + pro);
        }

        @Test
        void aGenericLocalBaseGetsBothBestEffortOffForms() throws IOException {
            // No dialect stamp: an operator's own llama.cpp/vLLM behind the
            // openai label. Both accepted off forms ride; servers ignore the
            // one their template does not read.
            JsonNode sent = posted(null, "some-gguf", Reasoning.OFF, null);
            assertEquals("none", sent.get("reasoning_effort").asText());
            assertFalse(sent.get("chat_template_kwargs").get("enable_thinking").asBoolean());
        }
    }

    // ---- anthropic: the SDK's POSTED body, captured on loopback -----------

    @Nested
    class Anthropic {

        private HttpServer server;
        private String baseUrl;
        private final AtomicReference<String> lastBody = new AtomicReference<>();

        @BeforeEach
        void scriptedAnthropic() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", exchange -> {
                lastBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                // The captured request is the subject; a scripted error ends
                // the stream without faking a full SSE event sequence.
                byte[] error = "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"scripted\"}}"
                        .getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(400, error.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(error);
                }
            });
            server.start();
            baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
        }

        @AfterEach
        void stop() {
            server.stop(0);
        }

        private JsonNode posted(String model, Reasoning mode, String effort) throws IOException {
            AnthropicProvider provider = new AnthropicProvider(model, false, "test-key", baseUrl);
            try {
                for (ProviderEvent ignored : provider.stream(request(mode, effort))) {
                    // drain until the scripted 400 surfaces
                }
            } catch (RuntimeException scripted) {
                // expected — the server answers 400 after the body arrived
            }
            assertNotNull(lastBody.get(), "the SDK must have posted a body before the 400");
            return JSON.readTree(lastBody.get());
        }

        @Test
        void offOnADefaultOnModelPostsThinkingDisabled() throws IOException {
            JsonNode sent = posted("claude-sonnet-5", Reasoning.OFF, null);
            assertEquals("disabled", sent.get("thinking").get("type").asText());
            assertNull(sent.get("output_config"), "effort never composes with OFF");
        }

        @Test
        void offOnFableSendsNothingBecauseDisabledIsA400() throws IOException {
            JsonNode sent = posted("claude-fable-5", Reasoning.OFF, null);
            assertNull(sent.get("thinking"),
                    "fable rejects disabled — no off switch exists: " + sent);
        }

        @Test
        void offOnAnOptInGenerationOmitsThinkingLikeItsDefault() throws IOException {
            // 4.7/4.8 default to thinking OFF when the field is absent —
            // absence IS the off switch there.
            assertNull(posted("claude-opus-4-8", Reasoning.OFF, null).get("thinking"));
        }

        @Test
        void anEffortLevelPostsOutputConfigNextToAdaptiveThinking() throws IOException {
            JsonNode sent = posted("claude-opus-4-8", Reasoning.ON, "xhigh");
            assertEquals("xhigh", sent.get("output_config").get("effort").asText());
            assertEquals("adaptive", sent.get("thinking").get("type").asText());
        }

        @Test
        void aBudgetLegacyModelNeverSeesOutputConfig() throws IOException {
            JsonNode sent = posted("claude-sonnet-4-5", Reasoning.ON, "high");
            assertNull(sent.get("output_config"), "4.5 rejects output_config.effort: " + sent);
            assertEquals("enabled", sent.get("thinking").get("type").asText());
        }

        @Test
        void theEffortValueIsGatedByTheModelsRow() throws IOException {
            // xhigh is a 400 on the 4.6 pair — the request must not pretend.
            JsonNode sent = posted("claude-opus-4-6", Reasoning.DEFAULT, "xhigh");
            assertNull(sent.get("output_config"), "xhigh is not in the 4.6 row: " + sent);
        }
    }
}
