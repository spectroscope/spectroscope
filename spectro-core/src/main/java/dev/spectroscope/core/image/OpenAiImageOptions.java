package dev.spectroscope.core.image;

/**
 * Constructor options for the {@link OpenAiImageProvider}.
 *
 * @param baseUrl API origin to send requests to — tests point it at a mock server
 * @param apiKey  key sent as {@code Authorization: Bearer} on every request
 * @param model   OpenAI image model id, e.g. {@code gpt-image-1}
 */
public record OpenAiImageOptions(String baseUrl, String apiKey, String model) {

    public static final String DEFAULT_BASE_URL = "https://api.openai.com";
    public static final String DEFAULT_MODEL = "gpt-image-1";

    /**
     * Official endpoint and default model; a {@code null} model falls back to the default.
     *
     * @param apiKey key sent as {@code Authorization: Bearer} on every request
     * @param model  desired model id, or {@code null} for {@link #DEFAULT_MODEL}
     * @return options pointing at {@link #DEFAULT_BASE_URL}
     */
    public static OpenAiImageOptions withDefaults(String apiKey, String model) {
        return new OpenAiImageOptions(DEFAULT_BASE_URL, apiKey,
                model != null ? model : DEFAULT_MODEL);
    }
}
