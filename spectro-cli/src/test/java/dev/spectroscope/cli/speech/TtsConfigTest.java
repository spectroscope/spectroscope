package dev.spectroscope.cli.speech;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The {@code tts} config block ({@code tts.enabled} / {@code tts.voice}) is read in
 * spectro-cli — reading it here, not in {@code spectro-core}, is what keeps the
 * "spectro-core unchanged" acceptance criterion intact. Settings-productization renamed
 * the user scope's file from {@code config.json} to {@code settings.json}; these tests
 * pin the two-file fold this class now performs (mirroring {@code SpectroConfig}'s own
 * user-layer fold: legacy {@code config.json}, overridden wholesale by a {@code tts}
 * block in {@code settings.json} when one is present) alongside the original
 * single-file parse edge cases (missing file, missing block, malformed JSON).
 */
class TtsConfigTest {

    private static Path writeConfig(Path dir, String json) throws IOException {
        Path file = dir.resolve("config.json");
        Files.writeString(file, json);
        return file;
    }

    private static Path writeSettings(Path dir, String json) throws IOException {
        Path file = dir.resolve("settings.json");
        Files.writeString(file, json);
        return file;
    }

    @Test
    void readsEnabledAndVoiceFromTheTtsBlock(@TempDir Path dir) throws Exception {
        Path config = writeConfig(dir, """
                { "provider": "anthropic",
                  "tts": { "enabled": true, "voice": "en_GB-alan-medium" } }
                """);

        TtsConfig tts = TtsConfig.load(config, dir.resolve("settings.json"));

        assertTrue(tts.enabled(), "tts.enabled is honored");
        assertEquals("en_GB-alan-medium", tts.voice(), "tts.voice is honored");
    }

    @Test
    void aMissingTtsBlockYieldsTheDefaults(@TempDir Path dir) throws Exception {
        Path config = writeConfig(dir, """
                { "provider": "anthropic", "model": "claude-opus-4-8" }
                """);

        TtsConfig tts = TtsConfig.load(config, dir.resolve("settings.json"));

        assertFalse(tts.enabled(), "no tts block: voice output is off by default");
        assertEquals(TtsConfig.DEFAULT_VOICE, tts.voice(), "no tts block: the default voice");
    }

    @Test
    void aMissingConfigFileYieldsTheDefaults(@TempDir Path dir) {
        TtsConfig tts = TtsConfig.load(dir.resolve("does-not-exist.json"), dir.resolve("settings.json"));

        assertFalse(tts.enabled());
        assertEquals(TtsConfig.DEFAULT_VOICE, tts.voice());
    }

    @Test
    void aBlockWithOnlyEnabledFallsBackToTheDefaultVoice(@TempDir Path dir) throws Exception {
        Path config = writeConfig(dir, """
                { "tts": { "enabled": true } }
                """);

        TtsConfig tts = TtsConfig.load(config, dir.resolve("settings.json"));

        assertTrue(tts.enabled());
        assertEquals(TtsConfig.DEFAULT_VOICE, tts.voice(),
                "voice omitted -> the default the setup script downloads");
    }

    @Test
    void enabledDefaultsToFalseWhenOnlyVoiceIsGiven(@TempDir Path dir) throws Exception {
        Path config = writeConfig(dir, """
                { "tts": { "voice": "en_US-lessac-medium" } }
                """);

        TtsConfig tts = TtsConfig.load(config, dir.resolve("settings.json"));

        assertFalse(tts.enabled(), "voice set but enabled omitted -> off (the flag can still enable it)");
        assertEquals("en_US-lessac-medium", tts.voice());
    }

    @Test
    void aMalformedConfigFileIsTreatedAsAbsent(@TempDir Path dir) throws Exception {
        Path config = writeConfig(dir, "{ this is not valid json ");

        TtsConfig tts = TtsConfig.load(config, dir.resolve("settings.json"));

        assertFalse(tts.enabled(), "broken JSON must not break the CLI — fall back to defaults");
        assertEquals(TtsConfig.DEFAULT_VOICE, tts.voice());
    }

    @Test
    void readsTtsFromSettingsJsonWhenConfigJsonIsAbsent(@TempDir Path dir) throws Exception {
        Path settings = writeSettings(dir, """
                { "provider": "anthropic",
                  "tts": { "enabled": true, "voice": "en_GB-alan-medium" } }
                """);

        TtsConfig tts = TtsConfig.load(dir.resolve("config.json"), settings);

        assertTrue(tts.enabled(), "settings.json alone (fresh seed-on-first-boot) configures tts");
        assertEquals("en_GB-alan-medium", tts.voice());
    }

    @Test
    void settingsJsonOverridesTheLegacyConfigJsonBlockWhenBothArePresent(@TempDir Path dir) throws Exception {
        Path config = writeConfig(dir, """
                { "tts": { "enabled": false, "voice": "en_US-lessac-medium" } }
                """);
        Path settings = writeSettings(dir, """
                { "tts": { "enabled": true, "voice": "en_GB-alan-medium" } }
                """);

        TtsConfig tts = TtsConfig.load(config, settings);

        assertTrue(tts.enabled(), "settings.json's tts block wins over config.json's");
        assertEquals("en_GB-alan-medium", tts.voice());
    }

    @Test
    void settingsJsonWithoutATtsBlockFallsBackToConfigJson(@TempDir Path dir) throws Exception {
        Path config = writeConfig(dir, """
                { "tts": { "enabled": true, "voice": "en_GB-alan-medium" } }
                """);
        Path settings = writeSettings(dir, """
                { "provider": "ollama" }
                """);

        TtsConfig tts = TtsConfig.load(config, settings);

        assertTrue(tts.enabled(), "settings.json exists but carries no tts block: config.json still wins");
        assertEquals("en_GB-alan-medium", tts.voice());
    }
}
