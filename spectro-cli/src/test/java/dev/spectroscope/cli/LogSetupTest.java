package dev.spectroscope.cli;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * LogSetup applies the effective {@code logLevel} (SpectroConfig already folded
 * config-file and SPECTRO_LOG_LEVEL precedence) onto the Logback root — the
 * programmatic half of the logging setup; logback.xml only covers the moments
 * BEFORE the settings hierarchy is loaded.
 */
class LogSetupTest {

    private Logger root;
    private Level before;

    @BeforeEach
    void remember() {
        root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        before = root.getLevel();
    }

    @AfterEach
    void restore() {
        root.setLevel(before);
    }

    @Test
    void appliesTheEffectiveLevelToTheRoot() {
        LogSetup.apply("debug");
        assertEquals(Level.DEBUG, root.getLevel());

        LogSetup.apply("warn");
        assertEquals(Level.WARN, root.getLevel());
    }

    @Test
    void anUnknownValueFallsBackToInfoInsteadOfCrashing() {
        // SpectroConfig validates loudly upstream; the setter itself stays
        // defensive — a face must never die on the logging knob.
        LogSetup.apply("not-a-level");
        assertEquals(Level.INFO, root.getLevel());

        LogSetup.apply(null);
        assertEquals(Level.INFO, root.getLevel());
    }
}
