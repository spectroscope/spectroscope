package dev.spectroscope.server.localmodel;

import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.provider.ReasoningCapability;
import org.junit.jupiter.api.AfterEach;
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
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@code GET /api/models/capabilities} — the picker's source of truth. Static
 * dialects (openai, gemini, lmstudio, spectro-local) answer from the bundled
 * table; anthropic, ollama and openrouter overlay live discovery and fall back
 * to the table when their API is dark. The response IS the
 * {@link ReasoningCapability} record, so what the picker renders and what the
 * providers act on can never be two different truths.
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS)
class ModelCapabilityControllerTest {

    private HttpServer server;

    @AfterEach
    void stopScripted() {
        if (server != null) {
            server.stop(0);
        }
    }

    private String scripted(String path, String json, AtomicReference<String> requestSink)
            throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext(path, exchange -> {
            if (requestSink != null) {
                requestSink.set(new String(exchange.getRequestBody().readAllBytes(),
                        StandardCharsets.UTF_8));
            }
            byte[] body = json.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static ModelCapabilityController offline() {
        // Unroutable bases: every discovery leg fails fast onto the static table.
        return new ModelCapabilityController(
                "http://127.0.0.1:1", "http://127.0.0.1:1", "http://127.0.0.1:1", null);
    }

    // ---- static dialects --------------------------------------------------

    @Test
    void openAiAnswersFromTheStaticTable() {
        ReasoningCapability cap = offline().capabilities("openai", "gpt-5.6-turbo");
        assertEquals("effort", cap.control());
        assertEquals(List.of("none", "low", "medium", "high", "xhigh", "max"), cap.efforts());
        assertEquals("static", cap.source());
    }

    @Test
    void theBundledEngineAnswersFromTheCatalogueRows() {
        ReasoningCapability qwen = offline().capabilities("spectro-local", "qwen3-4b");
        assertEquals("toggle", qwen.control());
        assertEquals("chat_template_kwargs.enable_thinking", qwen.wire());
        assertEquals("catalog", qwen.source());

        assertEquals("none", offline().capabilities("spectro-local", "vibethinker-3b").control());
    }

    @Test
    void unknownProvidersAnswerNoneNotAnError() {
        assertEquals("none", offline().capabilities("smoke-signal", "m").control());
    }

    // ---- discovery overlays ----------------------------------------------

    @Test
    void anthropicDiscoveryTurnsANonThinkingModelToNone() throws IOException {
        // The static catch-all would say toggle for an unknown claude id; the
        // live Models API knows better.
        String base = scripted("/v1/models/claude-lumen-6", """
                {"id":"claude-lumen-6","capabilities":{
                  "thinking":{"supported":false},"effort":{"supported":false}}}""", null);
        ModelCapabilityController controller =
                new ModelCapabilityController(base, "http://127.0.0.1:1", "http://127.0.0.1:1", "k");
        ReasoningCapability cap = controller.capabilities("anthropic", "claude-lumen-6");
        assertEquals("none", cap.control());
        assertEquals("api", cap.source());
    }

    @Test
    void anthropicDiscoveryNarrowsTheEffortListButKeepsTheClientSideRules() throws IOException {
        String base = scripted("/v1/models/claude-opus-5", """
                {"id":"claude-opus-5","capabilities":{
                  "thinking":{"supported":true},
                  "effort":{"supported":true,
                    "low":{"supported":true},"medium":{"supported":true},
                    "high":{"supported":true},"xhigh":{"supported":false},
                    "max":{"supported":false}}}}""", null);
        ModelCapabilityController controller =
                new ModelCapabilityController(base, "http://127.0.0.1:1", "http://127.0.0.1:1", "k");
        ReasoningCapability cap = controller.capabilities("anthropic", "claude-opus-5");
        assertEquals(List.of("low", "medium", "high"), cap.efforts(),
                "the API's per-level flags narrow the static list");
        assertEquals("high", cap.offMaxEffort(),
                "the disabled-at-xhigh rule is NOT in the Models API and must survive the overlay");
        assertEquals("api", cap.source());
    }

    @Test
    void ollamaDiscoveryHidesTheControlWhenTheModelCannotThink() throws IOException {
        AtomicReference<String> shown = new AtomicReference<>();
        String base = scripted("/api/show", """
                {"capabilities":["completion","tools"]}""", shown);
        ModelCapabilityController controller =
                new ModelCapabilityController("http://127.0.0.1:1", "http://127.0.0.1:1", base, null);
        ReasoningCapability cap = controller.capabilities("ollama", "qwen3:8b");
        assertEquals("none", cap.control(),
                "/api/show without \"thinking\" outranks the family table");
        assertEquals("api", cap.source());
        assertTrue(shown.get().contains("qwen3:8b"), "the probe must name the model");
    }

    @Test
    void ollamaDiscoveryConfirmsAThinkerAndTheFamilyTableSuppliesTheShape() throws IOException {
        String base = scripted("/api/show", """
                {"capabilities":["completion","thinking"]}""", null);
        ModelCapabilityController controller =
                new ModelCapabilityController("http://127.0.0.1:1", "http://127.0.0.1:1", base, null);
        ReasoningCapability cap = controller.capabilities("ollama", "qwen3:8b");
        assertEquals("effort", cap.control());
        assertEquals(List.of("low", "medium", "high", "max"), cap.efforts());
        assertEquals("api", cap.source());
    }

    @Test
    void ollamaFallsBackToTheStaticRowWhenTheApiIsDark() {
        ReasoningCapability cap = offline().capabilities("ollama", "glm-5.2:cloud");
        assertEquals("toggle", cap.control());
        assertEquals("static", cap.source());
    }

    @Test
    void openrouterDiscoveryReadsTheReasoningObject() throws IOException {
        String base = scripted("/api/v1/models", """
                {"data":[
                  {"id":"openai/gpt-5.6","supported_parameters":["reasoning"],
                   "reasoning":{"mandatory":false,"supported_efforts":["xhigh","high","medium","low"],
                                "default_effort":"medium","default_enabled":true}},
                  {"id":"plain/model","supported_parameters":["temperature"]}
                ]}""", null);
        ModelCapabilityController controller =
                new ModelCapabilityController("http://127.0.0.1:1", base, "http://127.0.0.1:1", null);

        ReasoningCapability effortful = controller.capabilities("openrouter", "openai/gpt-5.6");
        assertEquals("effort", effortful.control());
        assertEquals(List.of("xhigh", "high", "medium", "low"), effortful.efforts());
        assertEquals("medium", effortful.defaultEffort());
        assertTrue(effortful.offSwitch(), "mandatory:false keeps the off switch");
        assertTrue(effortful.defaultOn());
        assertEquals("api", effortful.source());

        ReasoningCapability plain = controller.capabilities("openrouter", "plain/model");
        assertEquals("none", plain.control(), "neither discovery signal → no control");
        assertEquals("api", plain.source());
    }

    @Test
    void openrouterMandatoryReasoningLosesTheOffSwitch() throws IOException {
        String base = scripted("/api/v1/models", """
                {"data":[{"id":"x-ai/thinker","reasoning":{"mandatory":true}}]}""", null);
        ModelCapabilityController controller =
                new ModelCapabilityController("http://127.0.0.1:1", base, "http://127.0.0.1:1", null);
        ReasoningCapability cap = controller.capabilities("openrouter", "x-ai/thinker");
        assertEquals("toggle", cap.control(), "a reasoning object without efforts is a toggle");
        assertFalse(cap.offSwitch(), "mandatory reasoning cannot be switched off");
    }
}
