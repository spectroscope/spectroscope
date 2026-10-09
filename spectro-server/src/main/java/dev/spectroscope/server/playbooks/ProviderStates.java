package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.local.LocalModel;

/**
 * The state of the provider a playbook step's model choice names, as the step
 * table shows it: a word and a reason a person can read.
 *
 * <p>This is the seam for the provider registry of card 480. Until that
 * registry is on this branch, {@link #current()} answers with the presence
 * words {@code /api/config} already serves as {@code providerStatus}: an API
 * provider is {@code ready} or {@code needs-key}, a keyless one {@code local},
 * the built-in runtime {@code ready} or {@code needs-download}, a name this
 * build does not know {@code unknown}. The presence words do not check
 * whether a model exists on the provider.
 */
interface ProviderStates {

    /** A state word and the reason for it. */
    record State(String state, String reason) {}

    State of(String provider, String model, SpectroConfig config);

    /** The implementation the loader uses. Card 480's registry replaces this one method. */
    static ProviderStates current() {
        return presence();
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
