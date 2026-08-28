package dev.spectroscope.server.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The opt-in run analysis (card 294): one provider call over the digest of an
 * imported run, streamed back as NDJSON. Exercised directly (no MockMvc); the
 * provider sits behind a builder seam, so no test spends a key. The pattern
 * under test is the TRANSLATE pattern, not the explain one — reasoning is
 * refused (not defaulted), an empty answer is an error (not a done), and the
 * meta names the address the call will actually go to.
 */
class AnalyzeControllerTest {

    private final ObjectMapper mapper = new ObjectMapper();

    /** A provider whose stream replays a fixed script of events. */
    private static LlmProvider scripted(List<LlmProvider.ProviderEvent> events) {
        return request -> events;
    }

    /** A cloud-configured server, pinned so a dev machine that happens to run
     *  the built-in provider cannot change what these tests exercise. */
    private static SpectroConfig cloudConfig() {
        return SpectroConfig.load(SpectroConfig.Overrides.none())
                .withProvider("anthropic", "claude-opus-5");
    }

    /** The one config the endpoint must refuse: the built-in model. */
    private static SpectroConfig localConfig() {
        return SpectroConfig.load(SpectroConfig.Overrides.none())
                .withProvider("spectro-local", "qwen3-1.7b");
    }

    private static AnalyzeController controller(LlmProvider provider) {
        return new AnalyzeController(config -> provider, AnalyzeControllerTest::cloudConfig);
    }

    private AnalyzeController.AnalyzeBody body(String digest, String lang) {
        return new AnalyzeController.AnalyzeBody(digest, lang);
    }

    /** Drain the streaming body into parsed NDJSON lines. */
    private List<JsonNode> drain(org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody streaming)
            throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        streaming.writeTo(out);
        List<JsonNode> lines = new ArrayList<>();
        for (String line : out.toString("UTF-8").split("\n")) {
            if (!line.isBlank()) lines.add(mapper.readTree(line));
        }
        return lines;
    }

    // ---- the fences and bounds -------------------------------------------

    @Test
    void refusesANonLocalCaller() {
        MockHttpServletRequest remote = new MockHttpServletRequest();
        remote.setRemoteAddr("203.0.113.7"); // TEST-NET, not loopback
        var response = controller(scripted(List.of())).analyze(body("digest", "en"), remote);
        assertEquals(404, response.getStatusCode().value());
    }

    @Test
    void refusesACrossSiteOrigin() {
        // The endpoint spends the operator's API key — a cross-site page must
        // not trigger it even though its request arrives via loopback.
        MockHttpServletRequest crossSite = new MockHttpServletRequest();
        crossSite.addHeader("Origin", "https://evil.example");
        var response = controller(scripted(List.of())).analyze(body("digest", "en"), crossSite);
        assertEquals(404, response.getStatusCode().value());
    }

    @Test
    void theEngineReportWearsTheSameFence() {
        MockHttpServletRequest remote = new MockHttpServletRequest();
        remote.setRemoteAddr("203.0.113.7");
        assertEquals(404, controller(scripted(List.of())).engine(remote).getStatusCode().value());
    }

    @Test
    void refusesABlankDigest() {
        var response = controller(scripted(List.of())).analyze(body("   ", "en"), new MockHttpServletRequest());
        assertEquals(400, response.getStatusCode().value());
    }

    @Test
    void refusesAMissingBody() {
        var response = controller(scripted(List.of())).analyze(null, new MockHttpServletRequest());
        assertEquals(400, response.getStatusCode().value());
    }

    @Test
    void refusesAnOversizeDigest() {
        var response = controller(scripted(List.of()))
                .analyze(body("x".repeat(AnalyzeController.MAX_DIGEST_CHARS + 1), "en"),
                        new MockHttpServletRequest());
        assertEquals(413, response.getStatusCode().value());
    }

    // ---- readiness --------------------------------------------------------

    @Test
    void answers503WithAReadableMessageWhenNoProviderIsReady() throws Exception {
        AnalyzeController controller = new AnalyzeController(
                config -> { throw new IllegalStateException("anthropic needs ANTHROPIC_API_KEY — set a key in Settings."); },
                AnalyzeControllerTest::cloudConfig);
        var response = controller.analyze(body("digest", "en"), new MockHttpServletRequest());
        assertEquals(503, response.getStatusCode().value());
        List<JsonNode> lines = drain(response.getBody());
        assertTrue(lines.get(0).get("error").asText().contains("ANTHROPIC_API_KEY"),
                "the panel shows the provider's own readable message");
    }

    @Test
    void refusesTheBuiltInProviderWithAReadableMessage() throws Exception {
        // The analysis is a cloud-provider call by design (the translate
        // lesson): a config on spectro-local gets a readable refusal, never a
        // silent fall-through into the pure config path's own exception.
        AnalyzeController controller = new AnalyzeController(
                config -> scripted(List.of()), AnalyzeControllerTest::localConfig);
        var response = controller.analyze(body("digest", "en"), new MockHttpServletRequest());
        assertEquals(503, response.getStatusCode().value());
        List<JsonNode> lines = drain(response.getBody());
        assertTrue(lines.get(0).get("error").asText().contains("built-in model"),
                "the refusal names the actual problem: " + lines.get(0));
    }

    // ---- the stream -------------------------------------------------------

    @Test
    void streamsMetaThenDeltasThenDone() throws Exception {
        List<LlmProvider.ProviderEvent> script = List.of(
                new LlmProvider.PTextDelta("{\"summary\":\"The run "),
                new LlmProvider.PTextDelta("finished.\",\"agents\":[]}"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        var response = controller(scripted(script)).analyze(body("run: hi", "en"), new MockHttpServletRequest());
        assertEquals(200, response.getStatusCode().value());
        List<JsonNode> lines = drain(response.getBody());

        assertTrue(lines.get(0).has("meta"), "first line is the meta");
        assertEquals("{\"summary\":\"The run ", lines.get(1).get("delta").asText());
        assertTrue(lines.get(lines.size() - 1).get("done").asBoolean(), "terminal line is done:true");
    }

    @Test
    void theMetaNamesProviderModelAndAddressAndNothingElse() throws Exception {
        // The consent dialog promised these three BEFORE the click; the meta
        // confirms them AFTER. And nothing else: a key, a header, a config
        // field beyond these three must never ride out in the response.
        List<LlmProvider.ProviderEvent> script = List.of(
                new LlmProvider.PTextDelta("reading"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        var response = controller(scripted(script)).analyze(body("run: hi", "en"), new MockHttpServletRequest());
        JsonNode meta = drain(response.getBody()).get(0).get("meta");
        assertEquals("anthropic", meta.get("provider").asText());
        assertEquals("claude-opus-5", meta.get("model").asText());
        assertEquals("api.anthropic.com", meta.get("address").asText());
        assertEquals(3, meta.size(), "meta carries exactly provider, model, address: " + meta);
    }

    @Test
    void reasoningIsRefusedNotDefaulted() {
        // The translate lesson (MEASURED on glm-5.2): a model that thinks its
        // way through a bounded budget returns an empty answer. Explain passed
        // a boolean false and got Reasoning.DEFAULT; this endpoint pins OFF.
        AtomicReference<LlmProvider.ProviderRequest> seen = new AtomicReference<>();
        LlmProvider capturing = request -> {
            seen.set(request);
            return List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        };
        try {
            controller(capturing).analyze(body("digest text", "en"), new MockHttpServletRequest())
                    .getBody().writeTo(new ByteArrayOutputStream());
        } catch (Exception ignored) {
            // draining only — the capture is what we assert
        }
        assertNotNull(seen.get());
        assertEquals(LlmProvider.ProviderRequest.Reasoning.OFF, seen.get().reasoning(),
                "reasoning is refused, not merely left unasked");
    }

    @Test
    void theRequestIsAOneShotOverTheDigestAlone() {
        AtomicReference<LlmProvider.ProviderRequest> seen = new AtomicReference<>();
        LlmProvider capturing = request -> {
            seen.set(request);
            return List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        };
        try {
            controller(capturing).analyze(body("the digest body", "de"), new MockHttpServletRequest())
                    .getBody().writeTo(new ByteArrayOutputStream());
        } catch (Exception ignored) {
            // draining only
        }
        assertNotNull(seen.get());
        assertTrue(seen.get().tools().isEmpty(), "an analysis advertises no tools");
        assertEquals(1, seen.get().messages().size(), "the digest is the sole user message");
        assertTrue(seen.get().messages().get(0).content().toString().contains("the digest body"));
        assertTrue(seen.get().system().contains("German"), "de flows into the system prompt");
        assertTrue(seen.get().system().contains("untrusted"), "the digest is declared untrusted");
    }

    @Test
    void anEmptyAnswerIsAnErrorNotADone() throws Exception {
        // The translate lesson again: a stop with no text reads as success and
        // is the worst kind of wrong. The error is a FIXED sentence — no
        // third-party text may ride back out in an error line.
        List<LlmProvider.ProviderEvent> script = List.of(
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        var response = controller(scripted(script)).analyze(body("run: hi", "en"), new MockHttpServletRequest());
        List<JsonNode> lines = drain(response.getBody());
        JsonNode last = lines.get(lines.size() - 1);
        assertEquals(AnalyzeController.NO_ANALYSIS, last.get("error").asText());
        for (JsonNode line : lines) {
            assertFalse(line.has("done"), "an empty answer must not close as done: " + line);
        }
    }

    @Test
    void aBlankOnlyAnswerIsAlsoTheEmptyAnswer() throws Exception {
        // Bitten separately from the no-deltas case: whitespace deltas stream,
        // so the guard must judge the accumulated TEXT, not the delta count.
        List<LlmProvider.ProviderEvent> script = List.of(
                new LlmProvider.PTextDelta("  \n"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        var response = controller(scripted(script)).analyze(body("run: hi", "en"), new MockHttpServletRequest());
        List<JsonNode> lines = drain(response.getBody());
        assertEquals(AnalyzeController.NO_ANALYSIS, lines.get(lines.size() - 1).get("error").asText());
    }

    @Test
    void aMidStreamProviderFailureBecomesAnErrorLineNotAStackTrace() throws Exception {
        Iterable<LlmProvider.ProviderEvent> exploding = () -> new Iterator<>() {
            private boolean first = true;
            @Override public boolean hasNext() { return true; }
            @Override public LlmProvider.ProviderEvent next() {
                if (first) { first = false; return new LlmProvider.PTextDelta("partial "); }
                throw new RuntimeException("connection reset");
            }
        };
        AnalyzeController controller = new AnalyzeController(
                config -> request -> exploding, AnalyzeControllerTest::cloudConfig);
        var response = controller.analyze(body("digest", "en"), new MockHttpServletRequest());
        List<JsonNode> lines = drain(response.getBody());
        assertEquals("partial ", lines.get(1).get("delta").asText());
        JsonNode last = lines.get(lines.size() - 1);
        assertTrue(last.has("error"), "terminal line carries a readable error");
        assertTrue(last.get("error").asText().contains("connection reset"));
    }

    // ---- the engine pre-flight -------------------------------------------

    @Test
    void theEngineReportNamesProviderModelAndAddress() {
        var response = controller(scripted(List.of())).engine(new MockHttpServletRequest());
        assertEquals(200, response.getStatusCode().value());
        var report = response.getBody();
        assertNotNull(report);
        assertEquals(Boolean.TRUE, report.get("available"));
        assertEquals("anthropic", report.get("provider"));
        assertEquals("claude-opus-5", report.get("model"));
        assertEquals("api.anthropic.com", report.get("address"));
    }

    @Test
    void theEngineReportSaysNeedsKeyWhenTheProviderWillNotBuild() {
        AnalyzeController controller = new AnalyzeController(
                config -> { throw new IllegalStateException("anthropic needs ANTHROPIC_API_KEY"); },
                AnalyzeControllerTest::cloudConfig);
        var report = controller.engine(new MockHttpServletRequest()).getBody();
        assertNotNull(report);
        assertEquals(Boolean.FALSE, report.get("available"));
        assertEquals("needs-key", report.get("reason"));
        assertEquals("anthropic", report.get("provider"));
        assertTrue(String.valueOf(report.get("detail")).contains("ANTHROPIC_API_KEY"));
        assertNull(report.get("address"), "no address is promised for a call that cannot happen");
    }

    @Test
    void theEngineReportSaysProviderIsLocalForTheBuiltInModel() {
        AnalyzeController controller = new AnalyzeController(
                config -> scripted(List.of()), AnalyzeControllerTest::localConfig);
        var report = controller.engine(new MockHttpServletRequest()).getBody();
        assertNotNull(report);
        assertEquals(Boolean.FALSE, report.get("available"));
        assertEquals("provider-is-local", report.get("reason"));
        assertEquals("spectro-local", report.get("provider"));
    }
}
