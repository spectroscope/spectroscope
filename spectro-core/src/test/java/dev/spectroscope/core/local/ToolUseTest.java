package dev.spectroscope.core.local;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 493, criterion 7: whether the loaded model can call tools, read from
 * the three places that say so. The bundled catalogue has
 * {@code nativeTools}; LM Studio's own listing ({@code /api/v1/models})
 * reports {@code capabilities.trained_for_tool_use} per model; Ollama's
 * {@code /api/show} lists {@code tools} among its {@code capabilities}.
 * Anything that does not say is unknown, never a guess.
 */
class ToolUseTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The listing shape LM Studio answers, cut down to the fields read here. */
    private static final String LM_STUDIO = """
            {"models":[
              {"key":"plain-model","capabilities":{"vision":false,"trained_for_tool_use":false},
               "loaded_instances":[{"id":"plain-model:2","config":{"context_length":8192}}]},
              {"key":"tool-model","capabilities":{"vision":true,"trained_for_tool_use":true},
               "loaded_instances":[]},
              {"key":"old-server-model","loaded_instances":[]}
            ]}
            """;

    private static JsonNode json(String text) throws Exception {
        return JSON.readTree(text);
    }

    @Test
    void lmStudioSaysItPerModelByKeyOrByLoadedInstance() throws Exception {
        JsonNode listing = json(LM_STUDIO);
        assertEquals(ToolUse.NO, ToolUse.fromLmStudioListing(listing, "plain-model"));
        assertEquals(ToolUse.NO, ToolUse.fromLmStudioListing(listing, "plain-model:2"));
        assertEquals(ToolUse.YES, ToolUse.fromLmStudioListing(listing, "tool-model"));
        assertEquals(ToolUse.UNKNOWN, ToolUse.fromLmStudioListing(listing, "old-server-model"),
                "a listing without the field was read as an answer");
        assertEquals(ToolUse.UNKNOWN, ToolUse.fromLmStudioListing(listing, "not-installed"));
        assertEquals(ToolUse.UNKNOWN, ToolUse.fromLmStudioListing(null, "tool-model"));
    }

    @Test
    void ollamaSaysItInTheCapabilitiesOfShow() throws Exception {
        assertEquals(ToolUse.YES, ToolUse.fromOllamaShow(
                json("{\"capabilities\":[\"completion\",\"vision\",\"tools\",\"thinking\"]}")));
        assertEquals(ToolUse.NO, ToolUse.fromOllamaShow(json("{\"capabilities\":[\"completion\"]}")));
        assertEquals(ToolUse.UNKNOWN, ToolUse.fromOllamaShow(json("{\"details\":{}}")),
                "an older Ollama without the field was read as an answer");
        assertEquals(ToolUse.UNKNOWN, ToolUse.fromOllamaShow(null));
    }

    @Test
    void theBundledCatalogueSaysItWithNativeTools() {
        LocalCatalog catalogue = LocalCatalog.bundled();
        for (LocalCatalog.Model model : catalogue.models()) {
            assertEquals(model.profile().nativeTools() ? ToolUse.YES : ToolUse.NO,
                    ToolUse.fromCatalogue(catalogue, model.id()), model.id());
        }
        assertEquals(ToolUse.UNKNOWN, ToolUse.fromCatalogue(catalogue, "not-in-the-catalogue"));
        assertEquals(ToolUse.UNKNOWN, ToolUse.fromCatalogue(catalogue, null));
    }

    @Test
    void theCatalogueHoldsAtLeastOneModelThatCannot() {
        assertEquals(true, LocalCatalog.bundled().models().stream()
                        .anyMatch(model -> ToolUse.fromCatalogue(LocalCatalog.bundled(), model.id()) == ToolUse.NO),
                "premise: the bundled catalogue names a model without tool calls");
    }

    @Test
    void theWireWordsAreLowerCase() {
        assertEquals("yes", ToolUse.YES.wire());
        assertEquals("no", ToolUse.NO.wire());
        assertEquals("unknown", ToolUse.UNKNOWN.wire());
    }
}
