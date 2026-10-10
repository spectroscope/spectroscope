package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.local.LocalModel;
import dev.spectroscope.server.providers.ProviderRegistry;
import dev.spectroscope.server.providers.ProviderRow;

/**
 * The state of the provider a playbook step's model choice names, as the step
 * table shows it: a word and a reason a person can read.
 *
 * <p>{@link #current()} answers from the provider registry of card 480: the
 * registry row's state and reason, and the model marked unverified unless the
 * row holds a live list that names it. A provider id the registry does not
 * know falls back to {@link #presence()}, the words {@code /api/config} serves
 * as {@code providerStatus}: an API provider is {@code ready} or
 * {@code needs-key}, a keyless one {@code local}, the built-in runtime
 * {@code ready} or {@code needs-download}, a name this build does not know
 * {@code unknown}. The presence words do not check whether a model exists on
 * the provider, so they always mark the model unverified.
 */
interface ProviderStates {

    /**
     * A state word, the reason for it, and whether the model is unconfirmed.
     *
     * @param state      the state word
     * @param reason     a reason a person can read
     * @param unverified true unless a live model list names the model
     */
    record State(String state, String reason, boolean unverified) {

        /** A state that says nothing about the model list: the model stays unverified. */
        public State(String state, String reason) {
            this(state, reason, true);
        }
    }

    State of(String provider, String model, SpectroConfig config);

    /** The implementation the loader uses: the process wide provider registry. */
    static ProviderStates current() {
        return over(ProviderRegistry.shared());
    }

    /**
     * The registry's rows as step states. Sends no request: the rows carry the
     * last check, presence is recomputed on every read.
     *
     * @param registry the registry to read
     * @return the states over that registry
     */
    static ProviderStates over(ProviderRegistry registry) {
        return (provider, model, config) -> {
            ProviderRow row = provider == null ? null : registry.rows(config).stream()
                    .filter(r -> r.id().equals(provider)).findFirst().orElse(null);
            if (row == null) {
                return presence().of(provider, model, config);
            }
            boolean listed = row.live() && model != null && row.models().contains(model);
            return new State(row.state(), reasonOf(row), !listed);
        };
    }

    private static String reasonOf(ProviderRow row) {
        return switch (row.state()) {
            case "failed" -> row.reason();
            case "reachable" -> "answered the last check";
            case "needs-key" -> "no API key is set";
            case "needs-signin" -> "not signed in";
            case "needs-download" -> "the built-in runtime has no model on disk yet";
            default -> "configured; not checked yet";
        };
    }

    /** The presence words of {@code /api/config}. */
    static ProviderStates presence() {
        return (provider, model, config) -> {
            if (provider == null || provider.isBlank() || !SpectroConfig.isKnownProvider(provider)) {
                return new State("unknown", "not a provider this build knows");
            }
            if ("spectro-local".equals(provider)) {
                String word = SpectroConfig.localModelStatus(LocalModel.anyPresent());
                return new State(word, "ready".equals(word)
                        ? "the built-in runtime has a model on disk"
                        : "the built-in runtime has no model on disk yet");
            }
            String keyEnv = SpectroConfig.keyEnvFor(provider);
            boolean present = keyEnv != null && SpectroConfig.hasApiKey(keyEnv);
            String word = SpectroConfig.onboardingStatus(provider, present);
            return switch (word) {
                case "ready" -> new State(word, keyEnv + " is set");
                case "needs-key" -> new State(word, keyEnv + " is not set");
                default -> new State(word, "a local provider; whether it answers is not checked here");
            };
        };
    }
}
