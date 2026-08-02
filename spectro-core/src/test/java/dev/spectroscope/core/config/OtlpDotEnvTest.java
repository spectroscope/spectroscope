package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * The OTLP pair reaches a run from {@code ~/.spectro/.env}, not only from the
 * process environment. Card 137: the installer writes the endpoint and the
 * {@code pk:sk} pair into that file (0600), and a running JVM cannot change its
 * own {@code System.getenv}, so without this fallback the file would be written
 * and then ignored by every face that does not go through a launcher.
 *
 * <p>The Gradle test task redirects {@code user.home} into the build directory,
 * so {@link SpectroConfig#dotEnvPath()} here is a scratch file, never the
 * owner's.
 */
class OtlpDotEnvTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @BeforeEach
    @AfterEach
    void cleanScratchHome() throws IOException {
        // The build test-home survives between runs: start and finish clean, or a
        // leftover file from another test decides this one.
        Files.deleteIfExists(SpectroConfig.dotEnvPath());
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
    }

    private static void writeDotEnv(String body) throws IOException {
        Path env = SpectroConfig.dotEnvPath();
        Files.createDirectories(env.getParent());
        Files.writeString(env, body);
    }

    @Test
    void readsTheOtlpAuthFromTheUserDotEnv(@TempDir Path projectDir) throws IOException {
        writeDotEnv("SPECTRO_OTLP_BASIC_AUTH=pk-test:sk-test\n");

        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, Map.of());

        assertEquals("pk-test:sk-test", config.otlpBasicAuth(),
                "the installer writes the pair to ~/.spectro/.env; the exporter must read it there");
    }

    @Test
    void readsTheOtlpEndpointFromTheUserDotEnv(@TempDir Path projectDir) throws IOException {
        writeDotEnv("SPECTRO_OTLP_ENDPOINT=http://localhost:3000/api/public/otel\n");

        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, Map.of());

        assertEquals("http://localhost:3000/api/public/otel", config.otlpEndpoint());
    }

    @Test
    void theProcessEnvironmentWinsOverTheFile(@TempDir Path projectDir) throws IOException {
        writeDotEnv("SPECTRO_OTLP_ENDPOINT=http://from-file:3000/api/public/otel\n"
                + "SPECTRO_OTLP_BASIC_AUTH=pk-file:sk-file\n");

        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir,
                Map.of("SPECTRO_OTLP_ENDPOINT", "http://from-env:4318/v1/traces",
                        "SPECTRO_OTLP_BASIC_AUTH", "pk-env:sk-env"));

        assertEquals("http://from-env:4318/v1/traces", config.otlpEndpoint(),
                "same precedence as an API key: a real process var always wins");
        assertEquals("pk-env:sk-env", config.otlpBasicAuth());
    }

    @Test
    void aBlankProcessVarDoesNotShadowTheFile(@TempDir Path projectDir) throws IOException {
        // The bug shape imageEnv already had: a blank var counts as ABSENT, or the
        // file value is silently swallowed by an empty export.
        writeDotEnv("SPECTRO_OTLP_ENDPOINT=http://from-file:3000/api/public/otel\n");

        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir,
                Map.of("SPECTRO_OTLP_ENDPOINT", ""));

        assertEquals("http://from-file:3000/api/public/otel", config.otlpEndpoint());
    }

    @Test
    void absentEverywhereStaysNull(@TempDir Path projectDir) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, Map.of());

        assertNull(config.otlpEndpoint(), "no file, no env: the exporter stays off");
        assertNull(config.otlpBasicAuth());
    }

    @Test
    void theDotEnvSecretIsNeverSeededIntoSettingsJson() throws IOException {
        // First boot materializes the env base into settings.json. That file is not
        // where a credential belongs, so the .env fallback must NOT feed the seed.
        // Otherwise the installer's 0600 file gets copied into a settings document
        // the UI, the API and every layer dump read.
        writeDotEnv("SPECTRO_OTLP_ENDPOINT=http://localhost:3000/api/public/otel\n"
                + "SPECTRO_OTLP_BASIC_AUTH=pk-secret:sk-secret\n");

        SpectroConfig.ensureSeeded(Map.of("SPECTRO_PROVIDER", "ollama"));

        String seeded = Files.exists(SpectroConfig.USER_SETTINGS_PATH)
                ? Files.readString(SpectroConfig.USER_SETTINGS_PATH)
                : "";
        assertFalse(seeded.contains("sk-secret"), "a credential must never be seeded into settings.json");
        assertFalse(seeded.contains("otlpBasicAuth"), "not even the key, so the shape cannot invite a value");
        if (!seeded.isEmpty()) {
            JsonNode node = JSON.readTree(seeded);
            assertNull(node.get("otlpEndpoint"),
                    "the seed materializes the PROCESS env, not the credential file next to it");
        }
    }
}
