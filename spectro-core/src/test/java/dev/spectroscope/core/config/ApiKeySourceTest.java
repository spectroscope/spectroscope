package dev.spectroscope.core.config;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Card 584: where a key comes from, told apart without handing out its value.
 * The process environment wins over the key saved in the app, as in
 * {@link SpectroConfig#resolveApiKey}; the answer is a word.
 *
 * <p>The Gradle test task redirects {@code user.home} into the build
 * directory, so {@link SpectroConfig#dotEnvPath()} is a scratch file here.
 */
class ApiKeySourceTest {

    private static final String KEY = "ANTHROPIC_API_KEY";
    private static final String SAVED_VALUE = "saved-value-0000";
    private static final String ENV_VALUE = "env-value-1111";

    @BeforeEach
    @AfterEach
    void cleanScratchHome() throws IOException {
        Files.deleteIfExists(SpectroConfig.dotEnvPath());
    }

    private static void save(String body) throws IOException {
        Path env = SpectroConfig.dotEnvPath();
        Files.createDirectories(env.getParent());
        Files.writeString(env, body);
    }

    @Test
    void aKeyInTheEnvironmentOfTheAppComesFromTheEnvironmentEvenWhenOneIsSaved() throws IOException {
        save(KEY + "=" + SAVED_VALUE + "\n");

        assertEquals("environment", SpectroConfig.apiKeySource(KEY, Map.of(KEY, ENV_VALUE)));
        assertEquals(SpectroConfig.KEY_FROM_ENVIRONMENT, SpectroConfig.apiKeySource(KEY, Map.of(KEY, ENV_VALUE)));
    }

    @Test
    void aKeyOnlySavedInTheAppIsSaved() throws IOException {
        save("OTHER=x\n" + KEY + "=\"" + SAVED_VALUE + "\"\n");

        assertEquals("saved", SpectroConfig.apiKeySource(KEY, Map.of()));
        assertEquals(SpectroConfig.KEY_SAVED, SpectroConfig.apiKeySource(KEY, Map.of(KEY, "   ")),
                "a blank environment value does not shadow the saved key, as in resolveApiKey");
    }

    @Test
    void noKeyAnywhereHasNoSource() throws IOException {
        assertNull(SpectroConfig.apiKeySource(KEY, Map.of()));
        save(KEY + "=\n");
        assertNull(SpectroConfig.apiKeySource(KEY, Map.of()), "a blank saved line is no key");
        assertNull(SpectroConfig.apiKeySource(null, Map.of(KEY, ENV_VALUE)), "a local provider has no key name");
    }

    @Test
    void theAnswerIsAWordAndNeverTheValue() throws IOException {
        save(KEY + "=" + SAVED_VALUE + "\n");
        for (String word : new String[] {
                SpectroConfig.apiKeySource(KEY, Map.of()),
                SpectroConfig.apiKeySource(KEY, Map.of(KEY, ENV_VALUE))}) {
            assertFalse(word.contains(SAVED_VALUE) || word.contains(ENV_VALUE), word);
        }
    }
}
