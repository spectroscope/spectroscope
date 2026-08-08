package dev.spectroscope.server.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The LLM-backed explain endpoint (card 62): a one-shot provider call that
 *  streams an interpretation of the client's run digest as NDJSON lines.
 *  Exercised directly (no MockMvc); the provider sits behind a builder seam. */
class ExplainControllerTest {

    private final ObjectMapper mapper = new ObjectMapper();

    /** A provider whose stream replays a fixed script of events. */
    private static LlmProvider scripted(List<LlmProvider.ProviderEvent> events) {
        return request -> events;
    }

    private static SpectroConfig anyConfig() {
        return SpectroConfig.load(SpectroConfig.Overrides.none());
    }

    private ExplainController.ExplainBody body(String digest, String lang) {
        return new ExplainController.ExplainBody(digest, lang);
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

    @Test
    void refusesANonLocalCaller() {
        ExplainController controller = new ExplainController(
                config -> scripted(List.of()), ExplainControllerTest::anyConfig);
        MockHttpServletRequest remote = new MockHttpServletRequest();
        remote.setRemoteAddr("203.0.113.7"); // TEST-NET, not loopback
        var response = controller.explain(body("digest", "en"), remote);
        assertEquals(404, response.getStatusCode().value());
    }

    @Test
    void refusesACrossSiteOrigin() {
        // The endpoint spends the operator's API key — a cross-site page must not
        // be able to trigger it even though its request arrives via loopback.
        ExplainController controller = new ExplainController(
                config -> scripted(List.of()), ExplainControllerTest::anyConfig);
        MockHttpServletRequest crossSite = new MockHttpServletRequest();
        crossSite.addHeader("Origin", "https://evil.example");
        var response = controller.explain(body("digest", "en"), crossSite);
        assertEquals(404, response.getStatusCode().value());
    }

    @Test
    void answers503WithAReadableMessageWhenNoProviderIsReady() throws Exception {
        ExplainController controller = new ExplainController(
                config -> { throw new IllegalStateException("anthropic needs ANTHROPIC_API_KEY — set a key in Settings."); },
                ExplainControllerTest::anyConfig);
        var response = controller.explain(body("digest", "en"), new MockHttpServletRequest());
        assertEquals(503, response.getStatusCode().value());
    }

    @Test
    void refusesAnOversizeDigest() {
        ExplainController controller = new ExplainController(
                config -> scripted(List.of()), ExplainControllerTest::anyConfig);
        var response = controller.explain(body("x".repeat(300_000), "en"), new MockHttpServletRequest());
        assertEquals(413, response.getStatusCode().value());
    }

    @Test
    void refusesABlankDigest() {
        ExplainController controller = new ExplainController(
                config -> scripted(List.of()), ExplainControllerTest::anyConfig);
        var response = controller.explain(body("   ", "en"), new MockHttpServletRequest());
        assertEquals(400, response.getStatusCode().value());
    }

    @Test
    void streamsMetaThenDeltasThenDone() throws Exception {
        List<LlmProvider.ProviderEvent> script = List.of(
                new LlmProvider.PTextDelta("The agent "),
                new LlmProvider.PTextDelta("planned first."),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        ExplainController controller = new ExplainController(
                config -> scripted(script), ExplainControllerTest::anyConfig);
        var response = controller.explain(body("[run_start] hi [run_end]", "en"), new MockHttpServletRequest());
        assertEquals(200, response.getStatusCode().value());
        List<JsonNode> lines = drain(response.getBody());

        assertTrue(lines.get(0).has("meta"), "first line is the meta");
        assertNotNull(lines.get(0).get("meta").get("provider"));
        assertNotNull(lines.get(0).get("meta").get("model"));
        assertEquals("The agent ", lines.get(1).get("delta").asText());
        assertEquals("planned first.", lines.get(2).get("delta").asText());
        assertTrue(lines.get(lines.size() - 1).get("done").asBoolean(), "terminal line is done:true");
    }

    @Test
    void aMidStreamProviderFailureBecomesAnErrorLineNotAStackTrace() throws Exception {
        Iterable<LlmProvider.ProviderEvent> exploding = () -> new java.util.Iterator<>() {
            private boolean first = true;
            @Override public boolean hasNext() { return true; }
            @Override public LlmProvider.ProviderEvent next() {
                if (first) { first = false; return new LlmProvider.PTextDelta("partial "); }
                throw new RuntimeException("connection reset");
            }
        };
        ExplainController controller = new ExplainController(
                config -> request -> exploding, ExplainControllerTest::anyConfig);
        var response = controller.explain(body("digest", "en"), new MockHttpServletRequest());
        List<JsonNode> lines = drain(response.getBody());
        assertEquals("partial ", lines.get(1).get("delta").asText());
        JsonNode last = lines.get(lines.size() - 1);
        assertTrue(last.has("error"), "terminal line carries a readable error");
        assertTrue(last.get("error").asText().contains("connection reset"));
    }

    @Test
    void theSystemPromptCarriesTheAnswerLanguage() {
        AtomicReference<LlmProvider.ProviderRequest> seen = new AtomicReference<>();
        LlmProvider capturing = request -> {
            seen.set(request);
            return List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        };
        ExplainController controller = new ExplainController(
                config -> capturing, ExplainControllerTest::anyConfig);
        try {
            controller.explain(body("digest text", "de"), new MockHttpServletRequest()).getBody()
                    .writeTo(new ByteArrayOutputStream());
        } catch (Exception ignored) {
            // draining only — the capture is what we assert
        }
        assertNotNull(seen.get());
        assertTrue(seen.get().system().contains("German"), "de flows into the system prompt");
        assertTrue(seen.get().tools().isEmpty(), "explain is a one-shot: no tools advertised");
        assertTrue(seen.get().messages().get(0).content().toString().contains("digest text"));
    }
}
