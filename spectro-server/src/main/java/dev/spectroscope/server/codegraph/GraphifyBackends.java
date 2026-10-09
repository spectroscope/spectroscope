package dev.spectroscope.server.codegraph;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.OpenAiCompatProvider;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.function.Predicate;

/**
 * The harness's providers as graphify backends (card 472).
 *
 * <p>The sheet offers the providers the harness already knows, so a person
 * picks the backend they use for chat and not graphify's own vocabulary. The
 * list is read from {@link SpectroConfig#knownProviders()} and never typed out
 * here: a provider graphify speaks natively maps to that backend
 * ({@link #NATIVE}), every other provider that speaks the OpenAI wire
 * ({@link SpectroConfig#openAiCompatProviders()}) maps to graphify's
 * {@code openai} backend at its own address, and what is left has no address
 * graphify could dial and is listed in {@link #leftOut()} with the reason.</p>
 *
 * <p>Each provider brings the environment its backend reads: the address the
 * harness would dial and, for the cloud providers, the key the harness has
 * saved. The key travels in the child's environment only, never on its command
 * line, where any local process could read it. The model must be one the
 * provider itself lists ({@code /api/models}), checked here on the server and
 * not only in the sheet.</p>
 */
public final class GraphifyBackends {

    /**
     * The key handed to graphify's openai backend for a local server that needs
     * none. graphify refuses to start that backend without some key, and a real
     * key must not travel to a server on this machine that never asked for it.
     */
    public static final String KEYLESS = "not-needed";

    /** Why a provider is left out of the sheet: graphify needs an address and it has none. */
    public static final String NO_ADDRESS = "no address graphify could dial";

    /**
     * The harness providers graphify speaks natively, by graphify's own backend
     * name. This is graphify's vocabulary, not a provider list: every other
     * provider is offered through the OpenAI wire when it speaks it.
     */
    static final Map<String, String> NATIVE = Map.of(
            "anthropic", "claude",
            "gemini", "gemini",
            "ollama", "ollama");

    /**
     * One row of the sheet's backend list.
     *
     * @param provider the harness provider name
     * @param backend  the graphify backend it maps to
     * @param ready    whether a build could use it now
     * @param reason   why not, or null when ready
     */
    public record Choice(String provider, String backend, boolean ready, String reason) {
    }

    /**
     * A checked choice, ready to become arguments and environment.
     *
     * @param naming the backend and model for {@link GraphifyCommand#steps}
     * @param env    the variables to add to graphify's environment
     */
    public record Resolved(GraphifyCommand.Naming naming, Map<String, String> env) {
    }

    private GraphifyBackends() {
    }

    /**
     * The providers the sheet offers, each with whether it can be used now.
     *
     * @param keys a saved key per environment variable name, or null
     * @return one choice per provider graphify can dial, in the harness's order
     */
    public static List<Choice> offered(Function<String, String> keys) {
        return offered(SpectroConfig.knownProviders(), SpectroConfig.openAiCompatProviders()::contains, keys);
    }

    /**
     * The derivation behind {@link #offered(Function)}, with the provider list
     * and the wire rule handed in so a test can add a provider the config does
     * not have yet.
     *
     * @param providers    the harness's provider names
     * @param openAiCompat whether a provider speaks the OpenAI wire
     * @param keys         a saved key per environment variable name, or null
     * @return one choice per provider graphify can dial, in the harness's order
     */
    static List<Choice> offered(Collection<String> providers, Predicate<String> openAiCompat,
                                Function<String, String> keys) {
        List<Choice> choices = new ArrayList<>();
        for (String provider : ordered(providers)) {
            String backend = backendOf(provider, openAiCompat);
            if (backend != null) {
                String reason = missingKey(provider, keys);
                choices.add(new Choice(provider, backend, reason == null, reason));
            }
        }
        return List.copyOf(choices);
    }

    /**
     * The harness providers the sheet does not offer, each with the reason.
     *
     * @return provider name to reason, in the harness's order
     */
    public static Map<String, String> leftOut() {
        return leftOut(SpectroConfig.knownProviders(), SpectroConfig.openAiCompatProviders()::contains);
    }

    /**
     * The derivation behind {@link #leftOut()}.
     *
     * @param providers    the harness's provider names
     * @param openAiCompat whether a provider speaks the OpenAI wire
     * @return provider name to reason, in the harness's order
     */
    static Map<String, String> leftOut(Collection<String> providers, Predicate<String> openAiCompat) {
        Map<String, String> out = new LinkedHashMap<>();
        for (String provider : ordered(providers)) {
            if (backendOf(provider, openAiCompat) == null) {
                out.put(provider, NO_ADDRESS);
            }
        }
        return out;
    }

    /**
     * Checks a provider and model from the sheet and maps them to graphify.
     *
     * @param provider  a harness provider name from {@link #offered}
     * @param model     the model id
     * @param endpoints the address per provider, as the config resolves it
     * @param keys      a saved key per environment variable name, or null
     * @param models    the models a provider lists, as {@code /api/models} answers
     * @return the naming and the environment
     * @throws IllegalArgumentException for a provider outside the list, a
     *                                  keyed provider without a key, a model
     *                                  that is not one argument, or a model the
     *                                  provider does not list
     */
    public static Resolved resolve(String provider, String model, Function<String, String> endpoints,
                                   Function<String, String> keys, Function<String, List<String>> models) {
        String backend = provider == null
                ? null
                : backendOf(provider, SpectroConfig.openAiCompatProviders()::contains);
        if (backend == null) {
            throw new IllegalArgumentException("not a provider the code graph can use");
        }
        String missing = missingKey(provider, keys);
        if (missing != null) {
            throw new IllegalArgumentException(missing);
        }
        GraphifyCommand.Naming naming = new GraphifyCommand.Naming(backend, model);
        List<String> listed = models.apply(provider);
        if (listed == null || listed.isEmpty()) {
            throw new IllegalArgumentException(provider + " lists no models");
        }
        if (!listed.contains(model)) {
            throw new IllegalArgumentException("not a model " + provider + " lists");
        }
        String keyEnv = SpectroConfig.keyEnvFor(provider);
        String key = keyEnv == null ? null : keys.apply(keyEnv);
        Map<String, String> env = new LinkedHashMap<>();
        switch (backend) {
            case "claude" -> env.put("ANTHROPIC_API_KEY", key);
            case "gemini" -> {
                env.put("GEMINI_API_KEY", key);
                env.put("GEMINI_BASE_URL", endpoints.apply(provider));
            }
            case "ollama" -> env.put("OLLAMA_BASE_URL", versioned(endpoints.apply(provider)));
            default -> {
                env.put("OPENAI_BASE_URL", versioned(endpoints.apply(provider)));
                env.put("OPENAI_API_KEY", key == null ? KEYLESS : key);
            }
        }
        return new Resolved(naming, Map.copyOf(env));
    }

    /** graphify's backend for a provider, or null when graphify has no way to reach it. */
    private static String backendOf(String provider, Predicate<String> openAiCompat) {
        String nativeBackend = NATIVE.get(provider);
        if (nativeBackend != null) {
            return nativeBackend;
        }
        return openAiCompat.test(provider) ? "openai" : null;
    }

    /**
     * The providers in the order the harness shows them
     * ({@link SpectroConfig#KNOWN_PROVIDERS_DISPLAY}), and any name that
     * listing lacks after them, alphabetically.
     */
    private static List<String> ordered(Collection<String> providers) {
        List<String> display = List.of(SpectroConfig.KNOWN_PROVIDERS_DISPLAY.split(",\\s*"));
        List<String> sorted = new ArrayList<>(providers);
        sorted.sort(Comparator.comparingInt((String p) -> display.contains(p) ? display.indexOf(p) : display.size())
                .thenComparing(Comparator.naturalOrder()));
        return sorted;
    }

    /** The sheet's reason a keyed provider cannot run, or null when it can. */
    private static String missingKey(String provider, Function<String, String> keys) {
        String keyEnv = SpectroConfig.keyEnvFor(provider);
        if (keyEnv == null) {
            return null;
        }
        String key = keys.apply(keyEnv);
        return key == null || key.isBlank() ? "no key saved for " + provider : null;
    }

    /** An OpenAI-compatible root with its version segment, the form graphify's clients expect. */
    private static String versioned(String base) {
        String trimmed = base.replaceAll("/+$", "");
        return trimmed + OpenAiCompatProvider.compatPath(trimmed, "");
    }
}
