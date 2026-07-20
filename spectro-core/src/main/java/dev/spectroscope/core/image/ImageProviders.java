package dev.spectroscope.core.image;

import java.util.Map;

/**
 * Builds an {@link ImageProvider} by name — the image-side sibling of
 * {@code ProviderFactory}. No console output and no {@code System.exit} in the
 * core: a missing key throws, and the caller decides how to report it.
 */
public final class ImageProviders {

    /** Static factory only — never instantiated. */
    private ImageProviders() {
    }

    /**
     * Instantiates the named provider against its official endpoint, with the API key
     * read from {@code env}.
     *
     * @param name  {@code "gemini"} or {@code "openai"}
     * @param model the model to use, or {@code null} for the provider default
     * @param env   the environment to read API keys from (injectable for tests)
     * @return a ready-to-use provider
     * @throws IllegalStateException    if the provider's API key is missing from {@code env}
     * @throws IllegalArgumentException if the name matches no known provider
     */
    public static ImageProvider create(String name, String model, Map<String, String> env) {
        return switch (name) {
            case "gemini" -> new GeminiImageProvider(
                    GeminiImageOptions.withDefaults(requireKey(env, "GEMINI_API_KEY", name), model));
            case "openai" -> new OpenAiImageProvider(
                    OpenAiImageOptions.withDefaults(requireKey(env, "OPENAI_API_KEY", name), model));
            default -> throw unknownProvider(name);
        };
    }

    /**
     * The model a provider falls back to when none is configured.
     *
     * @param name {@code "gemini"} or {@code "openai"}
     */
    public static String defaultModel(String name) {
        return switch (name) {
            case "gemini" -> GeminiImageOptions.DEFAULT_MODEL;
            case "openai" -> OpenAiImageOptions.DEFAULT_MODEL;
            default -> throw unknownProvider(name);
        };
    }

    /**
     * Looks up a mandatory API key — a missing or blank value throws with a message
     * that names the variable and where to set it.
     *
     * @param env      environment map to look the variable up in
     * @param variable environment variable that must hold the key, e.g. {@code GEMINI_API_KEY}
     * @param provider provider name, named in the error message
     * @return the non-blank key value
     */
    private static String requireKey(Map<String, String> env, String variable, String provider) {
        String key = env.get(variable);
        if (key == null || key.isBlank()) {
            throw new IllegalStateException(variable + " is not set — the " + provider
                    + " image provider needs it (./.env is the usual place).");
        }
        return key;
    }

    /**
     * Builds the shared unknown-provider error — returned rather than thrown, so call
     * sites read {@code throw unknownProvider(name)}.
     *
     * @param name the unmatched provider name, echoed in the message
     * @return the exception, ready to throw
     */
    private static IllegalArgumentException unknownProvider(String name) {
        return new IllegalArgumentException(
                "unknown image provider: " + name + " (known: gemini, openai)");
    }
}
