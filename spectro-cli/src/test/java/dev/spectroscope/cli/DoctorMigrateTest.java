package dev.spectroscope.cli;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@code doctor --migrate} renames the user scope's legacy file name
 * ({@code config.json}) to its new one ({@code settings.json}) — never
 * destructively: a rename only happens when the new name is still absent.
 */
class DoctorMigrateTest {

    @AfterEach
    void cleanHome() throws IOException {
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
    }

    @Test
    void migrateRenamesTheLegacyFileWhenTheTargetIsAbsent() throws IOException {
        Files.createDirectories(SpectroConfig.CONFIG_PATH.getParent());
        Files.writeString(SpectroConfig.CONFIG_PATH, """
                { "provider": "ollama" }
                """);
        assertTrue(DoctorCommand.migrateUserFile());
        assertFalse(Files.exists(SpectroConfig.CONFIG_PATH));
        assertTrue(Files.readString(SpectroConfig.USER_SETTINGS_PATH).contains("ollama"));
    }

    @Test
    void migrateRefusesWhenBothExist() throws IOException {
        Files.createDirectories(SpectroConfig.CONFIG_PATH.getParent());
        Files.writeString(SpectroConfig.CONFIG_PATH, "{}");
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, "{}");
        assertFalse(DoctorCommand.migrateUserFile());
        assertTrue(Files.exists(SpectroConfig.CONFIG_PATH), "no data is ever destroyed");
    }
}
