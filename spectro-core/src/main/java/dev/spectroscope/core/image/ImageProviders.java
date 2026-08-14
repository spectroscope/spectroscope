package dev.spectroscope.core.image;

import java.util.List;
import java.util.Map;

/**
 * Builds an {@link ImageProvider} by name — the image-side sibling of
 * {@code ProviderFactory}. No console output and no {@code System.exit} in the
 * core: a missing key throws, and the caller decides how to report it.
 */
public final class ImageProviders {

    /**
     * The image backends this build knows, in the order a fallback prefers
     * them. The one list: {@link #create} dispatches on these names,
     * {@code SpectroConfig.KNOWN_IMAGE_PROVIDERS} is a copy of this and
     * {@link #withAKey} walks it. A second hand-written spelling is how the
     * workspace-scope rule ended up written twice (card 222, F11).
     */
    public static final List<String> BACKENDS = List.of("gemini", "openai");

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
                    GeminiImageOptions.withDefaults(requireKey(env, keyVariable(name), name), model));
            case "openai" -> new OpenAiImageProvider(
                    OpenAiImageOptions.withDefaults(requireKey(env, keyVariable(name), name), model));
            default -> throw unknownProvider(name);
        };
    }

    /**
     * The environment variable a backend's key lives in.
     *
     * @param name {@code "gemini"} or {@code "openai"}
     * @return the variable {@link #create} demands for that backend
     * @throws IllegalArgumentException if the name matches no known provider
     */
    public static String keyVariable(String name) {
        return switch (name) {
            case "gemini" -> "GEMINI_API_KEY";
            case "openai" -> "OPENAI_API_KEY";
            default -> throw unknownProvider(name);
        };
    }

    /**
     * The backend a generation should actually run on: the one named, unless it
     * has no key and another one does.
     *
     * <p>Card 222, review finding F5. This rule used to live only in the web
     * app, as an effect that fired on connect and told the SESSION its answer
     * over the websocket — which marked the image backend as "the operator
     * touched this" and made the settings page's own image dropdown dead for
     * the rest of that session, with nobody having touched anything. The rule
     * is not a choice and must not be remembered as one, so it lives here: a
     * function of the settings and the keys, evaluated on the call being made.
     * The composer's dropdown pre-selects with the same rule (its twin is
     * {@code spectro-web/src/components/imageBackend.ts}), which is what keeps
     * what the composer SHOWS and what the belt USES the same answer.</p>
     *
     * <p>A blank value is no key — {@code SpectroConfig.resolveApiKey} and
     * {@code imageEnvFrom} both draw that line, and a rule that did not would
     * hand a generation an empty credential.</p>
     *
     * @param named the backend the settings resolve to
     * @param env   the environment image keys are read from ({@code SpectroConfig.imageEnv()}
     *              in production, an injected map in tests)
     * @return the backend to build, or {@code named} untouched when it is
     *         unknown — {@link #create} owns that error, not this
     */
    public static String withAKey(String named, Map<String, String> env) {
        if (!BACKENDS.contains(named) || hasKey(named, env)) {
            return named;
        }
        return BACKENDS.stream().filter(backend -> hasKey(backend, env)).findFirst().orElse(named);
    }

    /** Whether {@code env} carries a non-blank key for one backend. */
    private static boolean hasKey(String backend, Map<String, String> env) {
        String key = env.get(keyVariable(backend));
        return key != null && !key.isBlank();
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
