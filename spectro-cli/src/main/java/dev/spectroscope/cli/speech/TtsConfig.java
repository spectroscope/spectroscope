package dev.spectroscope.cli.speech;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * The {@code tts} block of the user scope — {@code tts.enabled} and {@code tts.voice}
 * from the canonical config contract (BUILD-PLAN.md). It is read HERE, in
 * {@code spectro-cli}, on purpose: voice output is a CLI-side consumer, and reading the
 * block here keeps {@code spectro-core} byte-identical (the acceptance criterion of the
 * stage that introduced it — no {@code SpectroConfig} edit). The core's own
 * {@code SpectroConfig} ignores unknown JSON fields, so the same file carries both.
 *
 * <p>Settings-productization renamed the user scope's file from
 * {@code ~/.spectro/config.json} to {@code ~/.spectro/settings.json} ({@code config.json}
 * stays readable underneath for one release; {@code spectroscope doctor --migrate} renames
 * it). This class mirrors {@link SpectroConfig}'s own user-layer fold exactly: the
 * legacy {@code config.json}'s {@code tts} block is read first, then a {@code tts}
 * block in {@code settings.json} OVERRIDES it wholesale when one is present — so
 * settings.json wins when both carry a block, either file alone still works, and a
 * fresh install (seed-on-first-boot writes only settings.json) can configure voice
 * output too.</p>
 *
 * <p>Both fields are optional: a missing file, a missing {@code tts} block in both
 * files, or malformed JSON all yield the defaults ({@code enabled=false},
 * {@code voice="en_US-lessac-medium"}), and the {@code --speak} flag / {@code /speak
 * on|off} override at runtime. A malformed file is treated as absent — voice output
 * must never break config loading for the rest of the CLI.</p>
 *
 * @param enabled {@code tts.enabled}: speak by default without the {@code --speak} flag
 * @param voice   {@code tts.voice}: the voice model name under ~/.spectro/models
 */
public record TtsConfig(boolean enabled, String voice) {

    /** The default voice, matching the model {@code scripts/setup-tts.sh} downloads. */
    public static final String DEFAULT_VOICE = "en_US-lessac-medium";

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * Reads {@code tts} from the user scope — {@code settings.json} overriding the
     * legacy {@code config.json} — defaulting if neither file carries the block.
     *
     * @return the configured tts block, or the safe defaults — never a load failure
     */
    public static TtsConfig load() {
        return load(SpectroConfig.CONFIG_PATH, SpectroConfig.USER_SETTINGS_PATH);
    }

    /**
     * Visible for tests: both user-scope paths are injectable.
     *
     * @param configPath   the legacy {@code config.json} to read
     * @param settingsPath the new {@code settings.json}; its {@code tts} block, when
     *                     present, overrides {@code configPath}'s wholesale — the
     *                     same whole-block precedence {@link SpectroConfig} applies to
     *                     {@code mcpServers}/{@code hooks}
     * @return the parsed tts block; missing files, a missing block in both, or
     *         broken JSON in either all fall back to the defaults
     */
    static TtsConfig load(Path configPath, Path settingsPath) {
        JsonNode legacy = readTtsBlock(configPath);
        JsonNode current = readTtsBlock(settingsPath);
        JsonNode tts = current != null ? current : legacy;
        if (tts == null) {
            return defaults();
        }
        boolean enabled = tts.path("enabled").asBoolean(false);
        JsonNode voiceNode = tts.get("voice");
        String voice = voiceNode != null && voiceNode.isTextual() && !voiceNode.asText().isBlank()
                ? voiceNode.asText()
                : DEFAULT_VOICE;
        return new TtsConfig(enabled, voice);
    }

    /**
     * Reads just the {@code tts} object out of one JSON file — one layer of the fold.
     *
     * @param path the file to read
     * @return the {@code tts} node when the file parses and carries one; {@code null}
     *         when the file is absent, unreadable, malformed, or has no {@code tts}
     *         object — this layer then contributes nothing to the fold
     */
    private static JsonNode readTtsBlock(Path path) {
        try {
            JsonNode root = JSON.readTree(Files.readString(path, StandardCharsets.UTF_8));
            JsonNode tts = root.get("tts");
            return tts != null && tts.isObject() ? tts : null;
        } catch (IOException | RuntimeException absentOrBroken) {
            // No file, or malformed JSON: this layer contributes nothing to the fold.
            return null;
        }
    }

    /**
     * The fallback whenever neither file's block can deliver: voice output off,
     * the setup script's voice.
     *
     * @return the default configuration — never null, so callers skip null checks
     */
    private static TtsConfig defaults() {
        return new TtsConfig(false, DEFAULT_VOICE);
    }
}
