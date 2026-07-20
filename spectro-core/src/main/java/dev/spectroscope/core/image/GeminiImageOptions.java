package dev.spectroscope.core.image;

/**
 * Constructor options for the {@link GeminiImageProvider}.
 *
 * @param baseUrl API origin to send requests to — tests point it at a mock server
 * @param apiKey  key sent as {@code x-goog-api-key} on every request
 * @param model   Gemini image model id, e.g. {@code gemini-2.5-flash-image}
 */
public record GeminiImageOptions(String baseUrl, String apiKey, String model) {

    public static final String DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
    public static final String DEFAULT_MODEL = "gemini-2.5-flash-image";

    /**
     * Official endpoint and default model; a {@code null} model falls back to the default.
     *
     * @param apiKey key sent as {@code x-goog-api-key} on every request
     * @param model  desired model id, or {@code null} for {@link #DEFAULT_MODEL}
     * @return options pointing at {@link #DEFAULT_BASE_URL}
     */
    public static GeminiImageOptions withDefaults(String apiKey, String model) {
        return new GeminiImageOptions(DEFAULT_BASE_URL, apiKey,
                model != null ? model : DEFAULT_MODEL);
    }
}
