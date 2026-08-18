package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 263, AC 5: the two backend shapes the harness can actually read, pinned
 * as JSON — no server, no network.
 *
 * <p>Both fixtures below are trimmed copies of REAL responses, not invented
 * shapes. LM Studio's came from {@code curl -s <lmstudio>/api/v1/models} on
 * 2026-08-18 (sixteen models, one of them loaded); ollama's from
 * {@code curl -s http://localhost:11434/api/ps} on ollama 0.24.0 with
 * qwen2.5:3b loaded. The address is house-internal and stays out of the file:
 * only the response shape matters here.</p>
 *
 * <p>The question both arms answer is the same one, and it is NOT "how big can
 * this model get": it is "how big is the instance that will serve the next
 * request". LM Studio states both — {@code max_context_length} 1,048,576 for a
 * model loaded at 204,288 — and reading the larger one would push compaction
 * past the window the server actually holds, which is the one direction worse
 * than the constant this card removes.</p>
 */
class ContextWindowShapesTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Two models, one of them loaded — the real listing, trimmed. */
    private static final String LM_STUDIO_LISTING = """
            {"models":[
              {"type":"llm","key":"qwen3.5-27b","loaded_instances":[],
               "max_context_length":262144,
               "capabilities":{"vision":false}},
              {"type":"llm","key":"deepseek-v4-flash-0731@iq1_m",
               "loaded_instances":[
                 {"id":"deepseek-v4-flash-0731@iq1_m",
                  "config":{"context_length":204288,"flash_attention":true}}],
               "max_context_length":1048576,
               "capabilities":{"vision":false,"trained_for_tool_use":false}}
            ]}""";

    private static final String OLLAMA_PS = """
            {"models":[
              {"name":"qwen2.5:3b","model":"qwen2.5:3b","size":4281147392,
               "expires_at":"2026-08-18T22:32:15.940575+02:00",
               "size_vram":4281147392,"context_length":32768}
            ]}""";

    @Test
    void lmStudioReportsTheLoadedInstancesWindowAndNotTheModelsCeiling() throws Exception {
        assertEquals(204_288, OpenAiCompatProvider.loadedWindow(
                JSON.readTree(LM_STUDIO_LISTING), "deepseek-v4-flash-0731@iq1_m"));
    }

    @Test
    void anInstalledButUnloadedModelTeachesNothing() throws Exception {
        // Fifteen of the sixteen models in the real listing look like this. A
        // ceiling of 262,144 is what the model COULD be loaded with, and LM
        // Studio's just-in-time load may pick any smaller figure — so the only
        // honest answer here is "nothing known", which lands on the fallback.
        assertEquals(0, OpenAiCompatProvider.loadedWindow(
                JSON.readTree(LM_STUDIO_LISTING), "qwen3.5-27b"));
    }

    @Test
    void aModelTheListingDoesNotCarryTeachesNothing() throws Exception {
        assertEquals(0, OpenAiCompatProvider.loadedWindow(
                JSON.readTree(LM_STUDIO_LISTING), "gpt-4o"));
        assertEquals(0, OpenAiCompatProvider.loadedWindow(
                JSON.readTree(LM_STUDIO_LISTING), null));
    }

    @Test
    void aSilentOpenAiCompatibleEndpointTeachesNothing() throws Exception {
        // AC 5's third shape: api.openai.com has no /api/v1/models at all, and
        // llama.cpp's server answers the OpenAI listing with ids only. Whatever
        // comes back — a 404 body, an OpenAI-shaped {"data":[...]}, an empty
        // object — must read as "unknown" and never as a window.
        assertEquals(0, OpenAiCompatProvider.loadedWindow(JSON.readTree("{}"), "gpt-4o"));
        assertEquals(0, OpenAiCompatProvider.loadedWindow(
                JSON.readTree("{\"data\":[{\"id\":\"gpt-4o\",\"object\":\"model\"}]}"), "gpt-4o"));
        assertEquals(0, OpenAiCompatProvider.loadedWindow(
                JSON.readTree("{\"error\":\"Unexpected endpoint or method\"}"), "gpt-4o"));
    }

    @Test
    void twoLoadedInstancesOfOneModelAnswerWithTheSmallerWindow() throws Exception {
        // LM Studio can hold several instances of one model at different
        // context lengths, and the request may land on any of them. The
        // smallest is the only figure that is true whichever one answers.
        String twoUp = """
                {"models":[{"key":"m","max_context_length":1048576,"loaded_instances":[
                  {"id":"m","config":{"context_length":204288}},
                  {"id":"m:2","config":{"context_length":32768}}]}]}""";
        assertEquals(32_768, OpenAiCompatProvider.loadedWindow(JSON.readTree(twoUp), "m"));
    }

    @Test
    void anInstanceIdMayCarryTheModelNameInsteadOfTheKey() throws Exception {
        // The configured model id is what the operator typed into settings, and
        // LM Studio answers requests addressed to either the model key or a
        // loaded instance's id. Matching only on the key would blind the probe
        // for a session that names the instance.
        String byInstance = """
                {"models":[{"key":"publisher/model","max_context_length":262144,
                  "loaded_instances":[{"id":"model-alias","config":{"context_length":16384}}]}]}""";
        assertEquals(16_384, OpenAiCompatProvider.loadedWindow(
                JSON.readTree(byInstance), "model-alias"));
    }

    @Test
    void ollamaReportsTheWindowOfTheRunningInstance() throws Exception {
        assertEquals(32_768, OllamaProvider.loadedWindow(JSON.readTree(OLLAMA_PS), "qwen2.5:3b"));
    }

    @Test
    void ollamaWithNothingLoadedTeachesNothing() throws Exception {
        // The measured empty answer, verbatim: {"models":[]}. It is what every
        // fresh session sees before its first turn, so it has to read as
        // "unknown" and not as a zero window.
        assertEquals(0, OllamaProvider.loadedWindow(JSON.readTree("{\"models\":[]}"), "qwen2.5:3b"));
        assertEquals(0, OllamaProvider.loadedWindow(
                JSON.readTree(OLLAMA_PS), "some-other-model"));
        assertEquals(0, OllamaProvider.loadedWindow(JSON.readTree(OLLAMA_PS), null));
    }

    @Test
    void anOllamaTooOldToReportAContextLengthTeachesNothing() throws Exception {
        // /api/ps grew context_length along the way; before that the running
        // entry carried only name, size and expiry. An absent field must not
        // read as a window of zero.
        String old = """
                {"models":[{"name":"qwen2.5:3b","size":4281147392,
                  "expires_at":"2026-08-18T22:32:15.940575+02:00"}]}""";
        assertEquals(0, OllamaProvider.loadedWindow(JSON.readTree(old), "qwen2.5:3b"));
    }

    @Test
    void theLmStudioRestRootIsDerivedFromWhateverTheOperatorTyped() {
        // The chat wire lives under /v1 and LM Studio's own REST under /api/v1,
        // both hung off the same root — but the configured base URL may already
        // carry the version segment (SpectroConfig.compatPath tolerates that,
        // and gemini's preset ends in /v1beta/openai). Appending blindly would
        // dial /v1/api/v1/models and learn nothing, silently.
        assertEquals("http://localhost:1234/api/v1/models",
                OpenAiCompatProvider.capabilityUrl("http://localhost:1234"));
        assertEquals("http://localhost:1234/api/v1/models",
                OpenAiCompatProvider.capabilityUrl("http://localhost:1234/"));
        assertEquals("http://localhost:1234/api/v1/models",
                OpenAiCompatProvider.capabilityUrl("http://localhost:1234/v1"));
        assertEquals("https://api.openai.com/api/v1/models",
                OpenAiCompatProvider.capabilityUrl("https://api.openai.com"));
    }
}
