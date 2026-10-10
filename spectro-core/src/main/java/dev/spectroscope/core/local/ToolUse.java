package dev.spectroscope.core.local;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Card 493, criterion 7: whether a model can call tools, as the places that
 * know say it. The Local mode switch warns when the answer is {@link #NO}.
 *
 * <p>Three sources. The bundled catalogue's {@code nativeTools}; LM Studio's
 * own listing ({@code GET /api/v1/models}), whose {@code capabilities} carry
 * {@code trained_for_tool_use} per model; and Ollama's {@code POST /api/show},
 * whose {@code capabilities} list {@code tools} for a model that takes them.
 * A source that does not say is {@link #UNKNOWN}, never a guess.</p>
 */
public enum ToolUse {
    /** The source says the model calls tools. */
    YES,
    /** The source says it does not. */
    NO,
    /** No source said. */
    UNKNOWN;

    /**
     * The word the server sends for this answer.
     *
     * @return yes, no or unknown
     */
    public String wire() {
        return name().toLowerCase(java.util.Locale.ROOT);
    }

    /**
     * Reads LM Studio's listing for one model, matched on its {@code key} or
     * on the {@code id} of a loaded instance, as the window probe matches it.
     *
     * @param listing the parsed body of {@code /api/v1/models}, or null
     * @param model   the model id the chat sends to
     * @return the answer for that model
     */
    public static ToolUse fromLmStudioListing(JsonNode listing, String model) {
        if (listing == null || model == null) {
            return UNKNOWN;
        }
        for (JsonNode entry : listing.path("models")) {
            boolean mine = model.equals(entry.path("key").asText(null));
            for (JsonNode instance : entry.path("loaded_instances")) {
                mine = mine || model.equals(instance.path("id").asText(null));
            }
            if (!mine) {
                continue;
            }
            JsonNode trained = entry.path("capabilities").path("trained_for_tool_use");
            return trained.isBoolean() ? (trained.asBoolean() ? YES : NO) : UNKNOWN;
        }
        return UNKNOWN;
    }

    /**
     * Reads Ollama's answer to {@code /api/show}.
     *
     * @param show the parsed body, or null
     * @return YES when {@code capabilities} names {@code tools}, NO when the
     *         list is there without it, UNKNOWN when there is no list
     */
    public static ToolUse fromOllamaShow(JsonNode show) {
        if (show == null || !show.path("capabilities").isArray()) {
            return UNKNOWN;
        }
        for (JsonNode capability : show.path("capabilities")) {
            if ("tools".equals(capability.asText())) {
                return YES;
            }
        }
        return NO;
    }

    /**
     * Reads the bundled catalogue.
     *
     * @param catalogue the catalogue
     * @param model     the catalogue id, or null
     * @return the entry's {@code nativeTools}, UNKNOWN for an id it does not hold
     */
    public static ToolUse fromCatalogue(LocalCatalog catalogue, String model) {
        if (model == null || model.isBlank()) {
            return UNKNOWN;
        }
        LocalCatalog.Model entry = catalogue.byId(model);
        if (entry == null) {
            return UNKNOWN;
        }
        return entry.profile().nativeTools() ? YES : NO;
    }
}
