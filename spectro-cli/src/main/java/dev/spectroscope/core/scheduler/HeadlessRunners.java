package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;

/**
 * CLI-side bridge into {@link HeadlessRunner}'s package-private provider-override
 * constructor ("visible for tests"). It compiles in the spectro-cli module but sits in
 * the core's package on purpose: {@code spectroscope run --verbose} must hand in a decorated
 * provider, while the core itself stays free of CLI concerns like wire tracing.
 * Classpath builds accept the split package — there is no JPMS module here.
 */
public final class HeadlessRunners {

    /** Not instantiable — this class exists only for the static bridge below. */
    private HeadlessRunners() {
    }

    /**
     * A {@link HeadlessRunner} that uses {@code provider} instead of building one from config.
     *
     * @param mapper   the module's shared, configured ObjectMapper (event serialization)
     * @param config   the effective configuration (file plus overrides)
     * @param provider the pre-built provider — typically wrapped in a tracing decorator —
     *                 that replaces the one the runner would derive from {@code config}
     * @return the runner, behaving exactly like a config-built one apart from the injected provider
     */
    public static HeadlessRunner withProvider(ObjectMapper mapper, SpectroConfig config,
                                              LlmProvider provider) {
        return new HeadlessRunner(mapper, config, provider);
    }
}
