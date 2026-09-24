package dev.spectroscope.core.config;

import dev.spectroscope.core.tools.RtkFilter;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 379, criterion 1: the key exists, ships off, and a typo is refused the
 * way {@code permissionMode}'s is rather than silently disabling what the
 * operator configured.
 *
 * <p>Off is not a tuning choice. rtk swallows failures: measured 2026-09-21 on
 * rtk 0.45.0, {@code rtk err sh -c 'exit 3'} returns 0 and prints
 * {@code [ok] Command completed successfully (no errors)} about a command that
 * failed. A product whose promise is that you can watch what happened does not
 * ship that on by default, whatever it saves.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class RtkFilterSettingTest {

    @Test
    void theShippedValueIsOff() {
        assertEquals(SpectroConfig.RTK_FILTER_OFF, SpectroConfig.shippedDefaults().rtkFilter(),
                "rtk swallows failures, so it does not ship on");
    }

    @Test
    void bothValuesAreKnownAndNothingElseIs() {
        assertTrue(SpectroConfig.KNOWN_RTK_FILTER_VALUES
                .containsAll(java.util.List.of(SpectroConfig.RTK_FILTER_OFF,
                        SpectroConfig.RTK_FILTER_ON)));
        assertEquals(2, SpectroConfig.KNOWN_RTK_FILTER_VALUES.size());
    }

    @Test
    void anUnknownValueIsRefusedOnLoadAndTheMessageNamesTheFieldAndTheValues(@TempDir Path ws)
            throws Exception {
        Path settings = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(settings.getParent());
        Files.writeString(settings, "{\"rtkFilter\": \"maybe\"}");

        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> SpectroConfig.loadForWorkspace(SpectroConfig.Overrides.none(),
                        ws.resolve("nowhere"), ws));
        assertTrue(refused.getMessage().contains("rtkFilter"),
                "the message names the field: " + refused.getMessage());
        assertTrue(refused.getMessage().contains("maybe"),
                "and the value that was refused: " + refused.getMessage());
        assertTrue(refused.getMessage().contains(SpectroConfig.RTK_FILTER_ON)
                        && refused.getMessage().contains(SpectroConfig.RTK_FILTER_OFF),
                "and what it could have been: " + refused.getMessage());
    }

    /** The positive half: a value that IS known loads and arrives. Without it
     *  the case above is green against a check that refuses everything. */
    @Test
    void aKnownValueLoadsAndArrives(@TempDir Path ws) throws Exception {
        Path settings = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(settings.getParent());
        Files.writeString(settings, "{\"rtkFilter\": \"on\"}");

        SpectroConfig loaded = SpectroConfig.loadForWorkspace(
                SpectroConfig.Overrides.none(), ws.resolve("nowhere"), ws);
        assertEquals(SpectroConfig.RTK_FILTER_ON, loaded.rtkFilter());
        assertTrue(loaded.rtkFilterOn());
    }

    @Test
    void theKeyIsWritableThroughTheSettingsApi() {
        assertTrue(SettingsWriter.knownKeys().contains("rtkFilter"),
                "a switch the operator cannot save is not a setting");
    }

    /** The reading the wiring uses, rather than a string comparison typed again
     *  at every call site. Both directions, because a predicate that is always
     *  false is green against the shipped default alone. */
    @Test
    void theReadingTheWiringUsesAnswersBothWays() {
        assertFalse(SpectroConfig.shippedDefaults().rtkFilterOn());
        assertTrue(SpectroConfig.shippedDefaults()
                .withRtkFilter(SpectroConfig.RTK_FILTER_ON).rtkFilterOn());
        assertFalse(SpectroConfig.shippedDefaults()
                .withRtkFilter(SpectroConfig.RTK_FILTER_OFF).rtkFilterOn());
        assertEquals("run_command", RtkFilter.TOOL);
    }
}
