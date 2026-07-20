package dev.spectroscope.cli;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import org.slf4j.LoggerFactory;

/**
 * Applies the effective {@code logLevel} onto the Logback root (logging
 * night). SpectroConfig already owns the precedence (defaults &lt;
 * SPECTRO_LOG_LEVEL &lt; the settings files), so callers pass
 * {@code config.logLevel()} once the hierarchy is loaded; the shared
 * logback.xml covers the moments before that (env substitution with an INFO
 * default). Lives in spectro-cli — the module that owns the backend — and
 * serves spectro-server through the existing dependency; spectro-core stays
 * backend-free.
 */
public final class LogSetup {

    /** Static utility — never instantiated. */
    private LogSetup() {}

    /**
     * Sets the root logger level. Defensive on purpose: SpectroConfig validates
     * loudly upstream, but a face must never die on the logging knob — an
     * unknown or null value falls back to INFO.
     *
     * @param level the effective level string (error | warn | info | debug | trace)
     */
    public static void apply(String level) {
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        root.setLevel(Level.toLevel(level, Level.INFO));
    }
}
