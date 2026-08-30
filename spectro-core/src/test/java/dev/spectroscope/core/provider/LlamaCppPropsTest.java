package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 312: a llama.cpp server answers what window the loaded model actually
 * has, so the run stops guessing it from a published-limits table.
 *
 * <p>The body below is VERBATIM from the bundled binary (build b10107,
 * Qwen3-1.7B, started with {@code -c 4096}), trimmed to the fields that are
 * read. The two facts that made this route worth taking are both in it:
 * {@code default_generation_settings.n_ctx} is the window one request really
 * gets (the server log says {@code n_ctx_slot = 4096} for the same run), and
 * {@code endpoint_props:false} proves GET is served even though the
 * {@code --props} flag — which only opens POST — was never passed.</p>
 */
class LlamaCppPropsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Measured 2026-08-30, `curl http://127.0.0.1:18099/props`, no --props flag. */
    private static final String PROPS = """
            { "default_generation_settings": { "n_ctx": 4096 },
              "total_slots": 4,
              "model_path": "/models/Qwen3-1.7B-Q8_0.gguf",
              "modalities": { "vision": false, "video": false, "audio": false },
              "endpoint_props": false,
              "build_info": "b10107-c0bc8591e" }
            """;

    // ---- the route ------------------------------------------------------

    @Test
    void thePropsRouteHangsOffTheServerRootNotTheVersionedPath() {
        assertEquals("http://localhost:8080/props",
                OpenAiCompatProvider.propsUrl("http://localhost:8080"));
    }

    @Test
    void aTrailingSlashDoesNotDoubleUp() {
        assertEquals("http://localhost:8080/props",
                OpenAiCompatProvider.propsUrl("http://localhost:8080/"));
    }

    @Test
    void aConfiguredV1SuffixIsStrippedTheSameWayTheCapabilityRouteStripsIt() {
        // An operator who pasted the OpenAI-style base ("…:8080/v1") must still
        // reach /props, which llama.cpp serves at the ROOT.
        assertEquals("http://localhost:8080/props",
                OpenAiCompatProvider.propsUrl("http://localhost:8080/v1"));
    }

    // ---- the window -----------------------------------------------------

    @Test
    void thePropsBodyYieldsTheWindowTheModelIsActuallyLoadedAt() throws Exception {
        // No model id is passed, and none could be: the body names no model to
        // match on, and the model field in a request is decorative — measured
        // 2026-08-30, a completion naming "totally-made-up-name" came back from
        // the loaded model. That is the whole reason /props beats the listing
        // route here. Which door the probe walks through is pinned where the
        // pieces are composed (ContextWindowProbeTest.LlamaCpp); this file is
        // about the pieces.
        JsonNode props = JSON.readTree(PROPS);
        assertEquals(4096, OpenAiCompatProvider.loadedWindowFromProps(props));
    }

    @Test
    void aBodyWithoutTheFieldTeachesNothingRatherThanZeroing() throws Exception {
        assertEquals(0, OpenAiCompatProvider.loadedWindowFromProps(JSON.readTree("{}")));
        assertEquals(0, OpenAiCompatProvider.loadedWindowFromProps(
                JSON.readTree("{\"default_generation_settings\":{}}")));
    }

    @Test
    void aNullBodyTeachesNothing() {
        assertEquals(0, OpenAiCompatProvider.loadedWindowFromProps(null));
    }

    @Test
    void aNegativeOrZeroWindowIsRefused() throws Exception {
        // -1 is llama.cpp's own "unset" spelling in neighbouring fields; taking
        // it as a window would make the compactor divide by a negative number.
        assertEquals(0, OpenAiCompatProvider.loadedWindowFromProps(
                JSON.readTree("{\"default_generation_settings\":{\"n_ctx\":-1}}")));
        assertEquals(0, OpenAiCompatProvider.loadedWindowFromProps(
                JSON.readTree("{\"default_generation_settings\":{\"n_ctx\":0}}")));
    }

    // ---- which server gets asked ----------------------------------------

    @Test
    void aLlamaCppDialectAsksProps() {
        assertTrue(OpenAiCompatProvider.readsWindowFromProps("llamacpp"));
    }

    @Test
    void theBundledRuntimeAsksPropsToo() {
        // spectro-local IS a llama-server — the same binary this card measured.
        // Leaving it on the model-listing route would mean one engine answering
        // through two different doors, and the bundled one taking the guess.
        assertTrue(OpenAiCompatProvider.readsWindowFromProps("spectro-local"));
    }

    @Test
    void lmStudioKeepsItsOwnListingRoute() {
        // LM Studio has no /props; its window lives in
        // /api/v1/models loaded_instances[].config.context_length.
        assertFalse(OpenAiCompatProvider.readsWindowFromProps("lmstudio"));
    }

    @Test
    void theOpenAiCloudIsNotAskedAtAll() {
        assertFalse(OpenAiCompatProvider.readsWindowFromProps("openai"));
    }

    @Test
    void anUnstampedEndpointKeepsTheOldRoute() {
        // A null dialect is an operator's own OpenAI-compatible server of
        // unknown make. Asking it for /props would spend a request on a route
        // that probably 404s; the existing listing probe already handles it.
        assertFalse(OpenAiCompatProvider.readsWindowFromProps(null));
    }
}
