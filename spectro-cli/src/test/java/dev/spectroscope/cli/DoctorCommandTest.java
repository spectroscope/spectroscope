package dev.spectroscope.cli;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Doctor honesty batch (settings-productization final wave): the "layers:"
 * line used to check only the legacy {@code config.json} and print "user
 * config absent" even when {@code settings.json} — the CURRENT user scope —
 * was present, and called the launch-dir file "project settings" rather than
 * naming it as the deprecated compat layer it is. This pins the corrected
 * wording against real files on disk (no env dependency, so it stays
 * deterministic regardless of what the running shell happens to export).
 */
class DoctorCommandTest {

    @AfterEach
    void cleanHome() throws IOException {
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
    }

    /**
     * Runs doctor with stdout captured. {@code parent} stays unset (a
     * standalone {@code new DoctorCommand()}), so {@code effectiveOverrides()}
     * answers {@code Overrides.none()} and the default anthropic provider
     * check only reads an env var — never a network call — keeping this
     * deterministic in any environment.
     */
    private static String captureDoctorOutput() {
        PrintStream original = System.out;
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        System.setOut(new PrintStream(buffer, true, StandardCharsets.UTF_8));
        try {
            new DoctorCommand().call();
        } finally {
            System.setOut(original);
        }
        return buffer.toString(StandardCharsets.UTF_8);
    }

    @Test
    void layersLineNamesTheRealUserScopeWhenOnlySettingsJsonExists() throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, "{}");

        String out = captureDoctorOutput();
        assertTrue(out.contains("user settings.json present"),
                "must name the real user scope, got:\n" + out);
        assertTrue(out.contains("launch-dir settings.json (deprecated)"),
                "must call the launch-dir layer by its real, deprecated name, got:\n" + out);
        assertFalse(out.contains("legacy config.json also present"),
                "no legacy file exists here, so the aside must not appear, got:\n" + out);
    }

    @Test
    void layersLineNamesTheLegacyFileWhenOnlyItExistsAndSettingsJsonIsStillAbsent() throws IOException {
        Files.createDirectories(SpectroConfig.CONFIG_PATH.getParent());
        Files.writeString(SpectroConfig.CONFIG_PATH, "{}");

        String out = captureDoctorOutput();
        assertTrue(out.contains("user settings.json absent"),
                "settings.json itself is still absent — the pre-fix line used to hide this"
                        + " whenever config.json existed, got:\n" + out);
        assertTrue(out.contains("legacy config.json also present"),
                "the legacy file's presence must not be swallowed, got:\n" + out);
    }
}
