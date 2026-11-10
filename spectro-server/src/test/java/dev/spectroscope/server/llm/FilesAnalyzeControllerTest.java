package dev.spectroscope.server.llm;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The model's reading of a session's file calls (card 604). Same shape as the
 * run analysis of card 294, with one difference that carries the whole card:
 * the provider is the pair the person picked in the request, never the
 * server's configured default, and a local provider is allowed. Exercised
 * directly (no MockMvc) behind the builder seam, so no test spends a key or
 * opens a socket.
 */
class FilesAnalyzeControllerTest {

    private final ObjectMapper mapper = new ObjectMapper();

    /** A provider whose stream replays a fixed script of events. */
    private static LlmProvider scripted(List<LlmProvider.ProviderEvent> events) {
        return request -> events;
    }

    /** A provider that answers one short reading and stops. */
    private static LlmProvider answering() {
        return scripted(List.of(
                new LlmProvider.PTextDelta("{\"files\":[]}"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
    }

    /**
     * The server's configured default, pinned to a cloud pair no request in
     * this file names. A controller that builds from the default instead of
     * the requested pair therefore shows up as the wrong provider, the wrong
     * model and the wrong address.
     */
    private static SpectroConfig serverDefault() {
        return SpectroConfig.load(SpectroConfig.Overrides.none())
                .withProvider("anthropic", "claude-opus-5");
    }

    private static FilesAnalyzeController controller(LlmProvider provider) {
        return new FilesAnalyzeController(config -> provider, FilesAnalyzeControllerTest::serverDefault);
    }

    /** A request for the local pair the owner tests with. */
    private static FilesAnalyzeController.FilesAnalyzeBody body(String digest) {
        return body(digest, "ollama", "qwen2.5:7b", "en");
    }

    private static FilesAnalyzeController.FilesAnalyzeBody body(String digest, String provider, String model,
                                                                String lang) {
        return new FilesAnalyzeController.FilesAnalyzeBody(digest, provider, model, lang);
    }

    /** Drain the streaming body into parsed NDJSON lines. */
    private List<JsonNode> drain(StreamingResponseBody streaming) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        streaming.writeTo(out);
        List<JsonNode> lines = new ArrayList<>();
        for (String line : out.toString("UTF-8").split("\n")) {
            if (!line.isBlank()) lines.add(mapper.readTree(line));
        }
        return lines;
    }

    private static MockHttpServletRequest remote() {
        MockHttpServletRequest remote = new MockHttpServletRequest();
        remote.setRemoteAddr("203.0.113.7"); // TEST-NET, not loopback
        return remote;
    }

    private static MockHttpServletRequest crossSite() {
        MockHttpServletRequest crossSite = new MockHttpServletRequest();
        crossSite.addHeader("Origin", "https://evil.example");
        return crossSite;
    }

    // ---- the fences and bounds -------------------------------------------

    @Test
    void refusesANonLocalCaller() {
        var response = controller(answering()).analyze(body("#3 1s main run_command: ls"), remote());
        assertEquals(404, response.getStatusCode().value());
    }

    @Test
    void refusesACrossSiteOrigin() {
        // The call can spend the operator's key and carries tool output, so a
        // cross-site page must not trigger it although it arrives via loopback.
        var response = controller(answering()).analyze(body("#3 1s main run_command: ls"), crossSite());
        assertEquals(404, response.getStatusCode().value());
    }

    @Test
    void theEngineReportWearsTheSameFence() {
        FilesAnalyzeController controller = controller(answering());
        assertEquals(404, controller.engine("ollama", "qwen2.5:7b", remote()).getStatusCode().value());
        assertEquals(404, controller.engine("ollama", "qwen2.5:7b", crossSite()).getStatusCode().value());
        assertEquals(200, controller.engine("ollama", "qwen2.5:7b", new MockHttpServletRequest())
                .getStatusCode().value(), "a local caller is answered");
    }

    @Test
    void refusesABlankDigest() {
        var response = controller(answering()).analyze(body("   "), new MockHttpServletRequest());
        assertEquals(400, response.getStatusCode().value());
    }

    @Test
    void refusesAMissingBody() {
        var response = controller(answering()).analyze(null, new MockHttpServletRequest());
        assertEquals(400, response.getStatusCode().value());
    }

    @Test
    void refusesAnOversizeDigest() {
        var over = controller(answering())
                .analyze(body("x".repeat(AnalyzeController.MAX_DIGEST_CHARS + 1)), new MockHttpServletRequest());
        assertEquals(413, over.getStatusCode().value());
        var atTheBound = controller(answering())
                .analyze(body("x".repeat(AnalyzeController.MAX_DIGEST_CHARS)), new MockHttpServletRequest());
        assertEquals(200, atTheBound.getStatusCode().value(), "the bound itself is allowed");
    }

    @Test
    void refusesAMissingPair() throws Exception {
        // Nothing may fall back to the chat's default model: a request that
        // names no pair is refused, and the builder is never reached.
        AtomicReference<SpectroConfig> built = new AtomicReference<>();
        FilesAnalyzeController controller = new FilesAnalyzeController(
                config -> { built.set(config); return answering(); },
                FilesAnalyzeControllerTest::serverDefault);

        List<FilesAnalyzeController.FilesAnalyzeBody> pairless = List.of(
                body("#3 1s main run_command: ls", null, "qwen2.5:7b", "en"),
                body("#3 1s main run_command: ls", "ollama", null, "en"),
                body("#3 1s main run_command: ls", "  ", "qwen2.5:7b", "en"),
                body("#3 1s main run_command: ls", "ollama", "", "en"));
        for (FilesAnalyzeController.FilesAnalyzeBody missing : pairless) {
            var response = controller.analyze(missing, new MockHttpServletRequest());
            assertEquals(400, response.getStatusCode().value(), "refused: " + missing);
            assertNotNull(response.getBody(), "a readable reason rides along: " + missing);
            JsonNode error = drain(response.getBody()).get(0);
            assertFalse(error.get("error").asText().isBlank(), "the reason is a sentence: " + error);
        }

        Map<String, Object> report = controller.engine(null, "qwen2.5:7b", new MockHttpServletRequest()).getBody();
        assertNotNull(report);
        assertEquals(Boolean.FALSE, report.get("available"));
        assertEquals("missing-pair", report.get("reason"));
        report = controller.engine("ollama", " ", new MockHttpServletRequest()).getBody();
        assertNotNull(report);
        assertEquals("missing-pair", report.get("reason"));
        assertNull(report.get("address"), "no address is promised for a call that cannot happen");

        assertNull(built.get(), "no provider was built for a request without a pair");
    }

    @Test
    void refusesTheBuiltInModel() throws Exception {
        // C6: the built-in model is not offered in the first cut, so the
        // server refuses it with a readable sentence instead of reaching the
        // pure config path's own exception about subprocess wiring.
        AtomicReference<SpectroConfig> built = new AtomicReference<>();
        FilesAnalyzeController controller = new FilesAnalyzeController(
                config -> { built.set(config); return answering(); },
                FilesAnalyzeControllerTest::serverDefault);

        var response = controller.analyze(body("#3 1s main run_command: ls", "spectro-local", "qwen3-1.7b", "en"),
                new MockHttpServletRequest());
        assertEquals(400, response.getStatusCode().value());
        assertNotNull(response.getBody());
        JsonNode error = drain(response.getBody()).get(0);
        assertTrue(error.get("error").asText().contains("built-in model"),
                "the refusal names the actual problem: " + error);

        Map<String, Object> report = controller.engine("spectro-local", "qwen3-1.7b", new MockHttpServletRequest())
                .getBody();
        assertNotNull(report);
        assertEquals(Boolean.FALSE, report.get("available"));
        assertEquals("builtin-model", report.get("reason"));
        assertEquals("spectro-local", report.get("provider"));
        assertNull(report.get("address"));

        assertNull(built.get(), "no provider was built for the built-in model");
    }

    // ---- the requested pair ----------------------------------------------

    @Test
    void buildsTheProviderForTheRequestedPair() throws Exception {
        // The server default is anthropic / claude-opus-5; the request names a
        // local pair. The builder must see the request's pair, which also
        // proves a local provider is allowed through.
        AtomicReference<SpectroConfig> built = new AtomicReference<>();
        FilesAnalyzeController controller = new FilesAnalyzeController(
                config -> { built.set(config); return answering(); },
                FilesAnalyzeControllerTest::serverDefault);

        var response = controller.analyze(body("#3 1s main run_command: ls"), new MockHttpServletRequest());
        assertEquals(200, response.getStatusCode().value());
        drain(response.getBody());
        assertNotNull(built.get(), "the provider was built");
        assertEquals("ollama", built.get().provider());
        assertEquals("qwen2.5:7b", built.get().model());

        built.set(null);
        controller.engine("ollama", "qwen2.5:7b", new MockHttpServletRequest());
        assertNotNull(built.get(), "the pre-flight builds the same pair");
        assertEquals("ollama", built.get().provider());
        assertEquals("qwen2.5:7b", built.get().model());
    }

    @Test
    void metaNamesTheRequestedPairAndItsAddress() throws Exception {
        String expectedAddress = serverDefault().withProvider("ollama", "qwen2.5:7b").providerHost();
        assertNotEquals(serverDefault().providerHost(), expectedAddress,
                "the requested pair's address differs from the default's, so this test can tell them apart");

        var response = controller(answering()).analyze(body("#3 1s main run_command: ls"),
                new MockHttpServletRequest());
        JsonNode meta = drain(response.getBody()).get(0).get("meta");
        assertNotNull(meta, "the first line is the meta");
        assertEquals("ollama", meta.get("provider").asText());
        assertEquals("qwen2.5:7b", meta.get("model").asText());
        assertEquals(expectedAddress, meta.get("address").asText());
        assertEquals(3, meta.size(), "meta carries exactly provider, model, address: " + meta);

        Map<String, Object> report = controller(answering())
                .engine("ollama", "qwen2.5:7b", new MockHttpServletRequest()).getBody();
        assertNotNull(report);
        assertEquals(Boolean.TRUE, report.get("available"));
        assertEquals("ollama", report.get("provider"));
        assertEquals("qwen2.5:7b", report.get("model"));
        assertEquals(expectedAddress, report.get("address"), "the pre-flight promises the address the call uses");
    }

    @Test
    void reasoningIsOffAndNoToolsAreSent() {
        AtomicReference<LlmProvider.ProviderRequest> seen = new AtomicReference<>();
        LlmProvider capturing = request -> {
            seen.set(request);
            return List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        };
        try {
            controller(capturing).analyze(body("#7 4s main run_command: python build.py", "ollama", "qwen2.5:7b",
                            "de"), new MockHttpServletRequest())
                    .getBody().writeTo(new ByteArrayOutputStream());
        } catch (Exception ignored) {
            // draining only, the capture is what we assert
        }
        LlmProvider.ProviderRequest request = seen.get();
        assertNotNull(request);
        assertEquals(LlmProvider.ProviderRequest.Reasoning.OFF, request.reasoning(),
                "reasoning is refused, not merely left unasked");
        assertTrue(request.tools().isEmpty(), "a reading advertises no tools");
        assertEquals(FilesAnalyzeController.MAX_TOKENS, request.maxTokens());
        assertEquals(1, request.messages().size(), "the digest is the sole user message");
        assertTrue(request.messages().get(0).content().toString().contains("python build.py"));
        assertTrue(request.system().contains("\"callIndex\""), "the prompt asks for the JSON contract");
        assertTrue(request.system().contains("untrusted"), "the digest is declared untrusted");
        assertTrue(request.system().contains("German"), "de flows into the system prompt");
        assertFalse(request.system().contains("python build.py"), "no client text is put into the prompt");
    }

    // ---- the stream ------------------------------------------------------

    @Test
    void streamsMetaThenDeltasThenDone() throws Exception {
        List<LlmProvider.ProviderEvent> script = List.of(
                new LlmProvider.PTextDelta("{\"files\":"),
                new LlmProvider.PTextDelta("[]}"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        var response = controller(scripted(script)).analyze(body("#3 1s main run_command: ls"),
                new MockHttpServletRequest());
        assertEquals(200, response.getStatusCode().value());
        List<JsonNode> lines = drain(response.getBody());
        assertTrue(lines.get(0).has("meta"));
        assertEquals("{\"files\":", lines.get(1).get("delta").asText());
        assertEquals("[]}", lines.get(2).get("delta").asText());
        assertTrue(lines.get(lines.size() - 1).get("done").asBoolean(), "terminal line is done:true");
    }

    @Test
    void anEmptyAnswerIsAnError() throws Exception {
        // Bitten apart in card 294: whitespace deltas stream, so the guard
        // must judge the accumulated text, not the delta count.
        List<LlmProvider.ProviderEvent> noText = List.of(
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        List<LlmProvider.ProviderEvent> blankText = List.of(
                new LlmProvider.PTextDelta("  \n"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        for (List<LlmProvider.ProviderEvent> script : List.of(noText, blankText)) {
            var response = controller(scripted(script)).analyze(body("#3 1s main run_command: ls"),
                    new MockHttpServletRequest());
            List<JsonNode> lines = drain(response.getBody());
            assertEquals(FilesAnalyzeController.NO_READING, lines.get(lines.size() - 1).get("error").asText());
            for (JsonNode line : lines) {
                assertFalse(line.has("done"), "an empty answer must not close as done: " + line);
            }
        }
    }

    @Test
    void aMidStreamFailureIsAnErrorLine() throws Exception {
        Iterable<LlmProvider.ProviderEvent> exploding = () -> new Iterator<>() {
            private boolean first = true;
            @Override public boolean hasNext() { return true; }
            @Override public LlmProvider.ProviderEvent next() {
                if (first) { first = false; return new LlmProvider.PTextDelta("partial "); }
                throw new RuntimeException("connection reset");
            }
        };
        var response = controller(request -> exploding).analyze(body("#3 1s main run_command: ls"),
                new MockHttpServletRequest());
        List<JsonNode> lines = drain(response.getBody());
        assertEquals("partial ", lines.get(1).get("delta").asText());
        JsonNode last = lines.get(lines.size() - 1);
        assertTrue(last.has("error"), "terminal line carries a readable error");
        assertTrue(last.get("error").asText().contains("connection reset"));
        for (JsonNode line : lines) {
            assertFalse(line.has("done"), "a failed reading must not close as done: " + line);
        }
    }

    @Test
    void answers503WithAReadableMessageWhenThePairWillNotBuild() throws Exception {
        FilesAnalyzeController controller = new FilesAnalyzeController(
                config -> { throw new IllegalStateException("openai needs OPENAI_API_KEY, set a key in Settings."); },
                FilesAnalyzeControllerTest::serverDefault);
        var response = controller.analyze(body("#3 1s main run_command: ls", "openai", "gpt-5", "en"),
                new MockHttpServletRequest());
        assertEquals(503, response.getStatusCode().value());
        JsonNode error = drain(response.getBody()).get(0);
        assertTrue(error.get("error").asText().contains("OPENAI_API_KEY"), "the provider's own sentence: " + error);

        Map<String, Object> report = controller.engine("openai", "gpt-5", new MockHttpServletRequest()).getBody();
        assertNotNull(report);
        assertEquals(Boolean.FALSE, report.get("available"));
        assertEquals("needs-key", report.get("reason"));
        assertEquals("openai", report.get("provider"));
        assertEquals("gpt-5", report.get("model"));
        assertTrue(String.valueOf(report.get("detail")).contains("OPENAI_API_KEY"));
        assertNull(report.get("address"), "no address is promised for a call that cannot happen");
    }

    // ---- the log ---------------------------------------------------------

    @Test
    void theDigestIsNeverLogged() throws Exception {
        String marker = "files-digest-marker-" + UUID.randomUUID();
        String canary = "files-log-canary-" + UUID.randomUUID();
        String digest = "#3 1s main run_command: cat " + marker + "\n  output: " + marker;

        ch.qos.logback.classic.Logger root =
                (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        Level before = root.getLevel();
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        root.addAppender(appender);
        // Raised for the length of this test so a debug line about the digest
        // would be caught as well, not only the INFO and above the root keeps.
        root.setLevel(Level.ALL);
        try {
            // The instrument first: a debug line from the controller's own
            // logger name reaches the appender, so its silence below is a
            // finding and not a deaf appender.
            LoggerFactory.getLogger(FilesAnalyzeController.class).debug("canary {}", canary);
            assertTrue(appender.list.stream().anyMatch(event -> event.getFormattedMessage().contains(canary)),
                    "the appender hears debug lines from the controller's logger");

            // Every path the digest can travel: a full reading, an empty
            // answer, a failure mid-stream, and a pair that will not build.
            List<JsonNode> done = drain(controller(answering())
                    .analyze(body(digest), new MockHttpServletRequest()).getBody());
            assertTrue(done.get(done.size() - 1).get("done").asBoolean(), "the reading went through");
            drain(controller(scripted(List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN))))
                    .analyze(body(digest), new MockHttpServletRequest()).getBody());
            drain(controller(request -> { throw new RuntimeException("connection reset"); })
                    .analyze(body(digest), new MockHttpServletRequest()).getBody());
            drain(new FilesAnalyzeController(config -> { throw new IllegalStateException("no key"); },
                    FilesAnalyzeControllerTest::serverDefault)
                    .analyze(body(digest), new MockHttpServletRequest()).getBody());

            for (ILoggingEvent event : appender.list) {
                assertFalse(event.getFormattedMessage().contains(marker), "the digest was logged: " + event);
                if (event.getThrowableProxy() != null) {
                    assertFalse(String.valueOf(event.getThrowableProxy().getMessage()).contains(marker),
                            "the digest rode out in a logged exception: " + event);
                }
            }
        } finally {
            root.setLevel(before);
            root.detachAppender(appender);
            appender.stop();
        }
    }
}
