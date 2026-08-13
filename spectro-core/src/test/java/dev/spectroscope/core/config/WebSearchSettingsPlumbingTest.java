package dev.spectroscope.core.config;

import dev.spectroscope.core.web.WebSearchTiers;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Everything UPSTREAM of {@link WebSearchTiers#decide} — the three channels a
 * SearXNG address can arrive through, each carried all the way to the resolver
 * the running tool asks.
 *
 * <p>Why this class exists (card 203, review finding F2): the resolver itself
 * was pinned from the first commit, and the plumbing into it was not. Deleting
 * the {@code searxngUrl} line from the layer merge reverted every user to the
 * DuckDuckGo scrape and left all 1980 tests green — a test suite that pins the
 * decision and not one of its inputs. The three channels below are the ones a
 * user can actually reach: the Settings page writes the settings file, a shell
 * exports the variable, and {@code samples/09-searxng/install.sh} writes
 * {@code ~/.spectro/.env}. Each gets an assertion that fails when its channel
 * is cut.</p>
 *
 * <p>The assertions all name {@code searxng} as the winning tier, which is the
 * one row of the card's table that does not depend on this machine's keys — a
 * test that asserted the duckduckgo row would go red on a laptop that happens
 * to export {@code TAVILY_API_KEY}.</p>
 *
 * <p>The Gradle test task redirects {@code user.home} into the build directory,
 * so the settings file and the {@code .env} written here are scratch files,
 * never the owner's.</p>
 */
class WebSearchSettingsPlumbingTest {

    @BeforeEach
    @AfterEach
    void cleanScratchHome() throws IOException {
        // The build test-home survives between runs: start and finish clean, or a
        // leftover file from another test decides this one.
        Files.deleteIfExists(SpectroConfig.dotEnvPath());
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
    }

    private static void writeUserSettings(String json) throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, json);
    }

    private static void writeDotEnv(String body) throws IOException {
        Path env = SpectroConfig.dotEnvPath();
        Files.createDirectories(env.getParent());
        Files.writeString(env, body);
    }

    private static WebSearchTiers.Choice tierFor(Path projectDir, Map<String, String> env) {
        return WebSearchTiers.forConfig(
                SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, env));
    }

    @Test
    void anAddressSavedInSettingsReachesTheResolver(@TempDir Path projectDir) throws IOException {
        // The Settings page's own channel: PUT /api/settings -> SettingsWriter ->
        // this file. Cutting the searxngUrl line out of the layer merge makes this
        // read null and drops every user back to the scrape.
        writeUserSettings("{\"searxngUrl\": \"http://saved.example:8888\"}");

        WebSearchTiers.Choice choice = tierFor(projectDir, Map.of());

        assertEquals(WebSearchTiers.SEARXNG, choice.tier(),
                "an address in ~/.spectro/settings.json must decide the tier");
        assertEquals("http://saved.example:8888", choice.searxngUrl(),
                "and the searcher must dial exactly that address");
    }

    @Test
    void theEnvironmentVariableReachesTheResolver(@TempDir Path projectDir) {
        WebSearchTiers.Choice choice =
                tierFor(projectDir, Map.of("SPECTRO_SEARXNG_URL", "http://exported.example:8888"));

        assertEquals(WebSearchTiers.SEARXNG, choice.tier(),
                "SPECTRO_SEARXNG_URL is the env layer's channel for the same address");
        assertEquals("http://exported.example:8888", choice.searxngUrl());
    }

    @Test
    void theInstallersDotEnvReachesTheResolver(@TempDir Path projectDir) throws IOException {
        // What samples/09-searxng/install.sh writes, verbatim. A running JVM cannot
        // change its own System.getenv and the desktop shell spawns the jar without
        // loading any .env, so without the fallback in PartialConfig.envLayer this
        // file is written, reported as written, and then ignored forever.
        writeDotEnv("SPECTRO_SEARXNG_URL=http://installed.example:8888\n");

        WebSearchTiers.Choice choice = tierFor(projectDir, Map.of());

        assertEquals(WebSearchTiers.SEARXNG, choice.tier(),
                "the installer's file must be a channel the product reads, or the "
                        + "installer's own success message is a lie");
        assertEquals("http://installed.example:8888", choice.searxngUrl());
    }

    @Test
    void aSavedAddressOutranksTheInstallersFile(@TempDir Path projectDir) throws IOException {
        // Precedence is unchanged by the fallback: this is still the env layer,
        // still directly above the defaults, still outranked by every settings
        // file. So a user who types their own address into Settings after running
        // the installer gets the one they typed.
        writeDotEnv("SPECTRO_SEARXNG_URL=http://installed.example:8888\n");
        writeUserSettings("{\"searxngUrl\": \"http://typed-by-hand.example:9999\"}");

        assertEquals("http://typed-by-hand.example:9999", tierFor(projectDir, Map.of()).searxngUrl(),
                "settings.json outranks the env layer, and the .env is part of the env layer");
    }

    @Test
    void theProcessEnvironmentWinsOverTheInstallersFile(@TempDir Path projectDir) throws IOException {
        writeDotEnv("SPECTRO_SEARXNG_URL=http://installed.example:8888\n");

        assertEquals("http://exported.example:7777",
                tierFor(projectDir, Map.of("SPECTRO_SEARXNG_URL", "http://exported.example:7777"))
                        .searxngUrl(),
                "same precedence as an API key: a real process var always wins");
    }

    @Test
    void aBlankProcessVarDoesNotShadowTheInstallersFile(@TempDir Path projectDir) throws IOException {
        // The bug shape imageEnv already had: a blank var counts as ABSENT, or an
        // empty export silently swallows the file the installer just wrote.
        writeDotEnv("SPECTRO_SEARXNG_URL=http://installed.example:8888\n");

        assertEquals("http://installed.example:8888",
                tierFor(projectDir, Map.of("SPECTRO_SEARXNG_URL", "")).searxngUrl());
    }
}
